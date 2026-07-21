# IVR Architecture

**ENRS Unified Communications Platform**  
Version 1.0 · 2026-07-21

---

## Design Philosophy

The IVR system is a **generic workflow engine**, not a collection of FreeSWITCH scripts. A flow graph defines what happens. The node registry defines what node types exist. The executor runs nodes. None of these layers know about specific business modules (ENS, ERS) unless explicitly permitted.

---

## Data Model

### `ivr_flows`

Stores a JSONB flow graph per tenant. One row per named flow.

```sql
ivr_flows:
  id                UUID PRIMARY KEY
  tenant_id         INT NOT NULL
  name              VARCHAR(255)
  description       TEXT
  entry_node_id     VARCHAR(64)
  nodes             JSONB         -- { [nodeId]: { type, label, config, next } }
  is_published      BOOLEAN DEFAULT false
  template_id       UUID REFERENCES ivr_templates(id)
  created_by        INT REFERENCES users(id)
  deleted_at        TIMESTAMPTZ
```

### Flow Graph Structure

```json
{
  "entry_node_id": "node_001",
  "nodes": {
    "node_001": {
      "type":   "play_audio",
      "label":  "Welcome message",
      "config": { "audio_file": "/recordings/welcome.wav" },
      "next":   "node_002"
    },
    "node_002": {
      "type":   "get_digits",
      "label":  "Extension entry",
      "config": { "timeout": 5, "max_digits": 4 },
      "next":   {
        "1": "node_003",
        "2": "node_004",
        "_default": "node_001"
      }
    }
  }
}
```

### `ivr_flow_versions`

Immutable published snapshots. Once a version is created, its `graph_snapshot` never changes.

```sql
ivr_flow_versions:
  id              UUID PRIMARY KEY
  flow_id         UUID REFERENCES ivr_flows(id)
  version_number  INT NOT NULL
  graph_snapshot  JSONB          -- copy of nodes at publish time
  published_at    TIMESTAMPTZ DEFAULT now()
  published_by    INT REFERENCES users(id)
  lua_script_path TEXT           -- path to generated Lua on FS filesystem
  dialplan_path   TEXT           -- path to generated dialplan XML
```

Publishing is one-way: you publish a flow; you never un-publish. Deployments reference versions by ID, not by the live `ivr_flows.nodes` JSONB.

---

## Node Registry

`src/nodeTypes/registry.js` — the catalog of all valid node types.

Each node type is a descriptor:

```javascript
{
  type:       'play_audio',           // unique identifier
  label:      'Play Audio',           // UI display name
  category:   'media',                // grouping: media | input | routing | integration
  schema:     Zod.object({...}),      // config validation schema
  // does this node type fork flow control?
  branches:   false,                  // true = node.next is an object (digit map, condition)
  // does this node require IVR graph validator to resolve a config ID?
  requiresConfigId: false,
}
```

Adding a new node type: add a descriptor to `registry.js`. No other files need changing until Lua generation is updated.

### Current Node Types

| Type | Category | Description |
|---|---|---|
| `play_audio` | media | Play a WAV/MP3 file |
| `tts_speak` | media | Text-to-speech via configured TTS engine |
| `get_digits` | input | Collect DTMF digits with timeout |
| `get_speech` | input | Collect speech input (ASR — future) |
| `transfer` | routing | Blind transfer to extension or number |
| `hangup` | routing | End the call |
| `goto` | routing | Jump to another node (loop prevention: max 20 jumps) |
| `condition` | routing | Branch on channel variable value |
| `set_variable` | routing | Set a channel variable for use by later nodes |
| `ens_playback` | integration | Play ENS campaign recording (looks up latest) |
| `ens_blast_gate` | integration | Allow caller to trigger ENS blast |
| `ers_connect` | integration | Connect caller to ERS conference (legacy) |
| `webhook` | integration | HTTP POST to external URL |
| `record_message` | media | Record caller audio to file |
| `voicemail` | media | Record to mailbox (future) |
| `queue` | routing | Place caller in ACD queue (future) |

### Integration Nodes — Boundary Rules

Integration nodes (`ens_*`, `ers_*`, `webhook`) call the **public Internal API** of their respective modules, not internal service functions.

- `ens_playback` → calls `GET /internal/ens/campaigns/latest`
- `ens_blast_gate` → calls `POST /internal/ens/campaign/start`
- `ers_connect` → the ERS conference bridge is initiated by the Lua caller (the number dialled routes directly to ERS Lua). An `ers_connect` IVR node that transfers to an ERS number is the preferred pattern going forward.

---

## IVR Graph Validator

`src/utils/ivrGraphValidator.js` — runs before publish. Checks:

1. **Reachability:** Every node must be reachable from `entry_node_id`. Unreachable nodes block publish.
2. **No infinite loops:** Maximum path length of 100 nodes. Cycles are detected.
3. **Config ID integrity:** Nodes with `config.configuration_id` values (ENS, ERS references) must reference configurations that exist and belong to the same `tenant_id` as the flow.
4. **Schema validation:** Each node's `config` is validated against the node type's Zod schema from the registry.
5. **Audio file paths:** `play_audio` nodes with absolute paths must reference files in `media_library` or the recordings directory (configurable validation depth).
6. **Webhook URL format:** `webhook` nodes must have valid HTTPS URLs (HTTP is rejected in production). Special characters in URL query string values must be URL-encoded — not raw.

Validation errors are returned as an array: `[{ nodeId, type, message }]`.

---

## Lua Generator

`src/utils/luaGenerator.js` — translates a published flow version's graph snapshot into a Lua script.

```
ivr_flow_versions.graph_snapshot (JSONB)
          ↓
    luaGenerator.generate(snapshot, context)
          ↓
    Lua script (string)
          ↓
    Write to FS_LUA_DIR/ivr_<version_id>.lua
```

The generator emits a self-contained script. The flow graph is embedded as a JSON constant — no runtime API fetch. The executor reads channel variables, processes nodes, and makes targeted API calls only for integration nodes that require fresh data (e.g., `ens_playback` fetches the latest campaign recording each call).

### Generator → Executor Model

Two layers:
- **Generator:** Runs at deploy time. Produces the Lua file.
- **Executor (`ivr_executor.lua`):** Library included by generated scripts. Processes the node graph at call time.

This means bug fixes to the executor apply to all deployed flows on the next FS reload — no re-deployment needed for executor bug fixes.

---

## Deployment Chain

```
1. User publishes flow version (POST /api/v1/ivr/flows/:id/publish)
   → ivrGraphValidator.validate(graph)
   → Insert ivr_flow_versions row

2. User deploys flow version (POST /api/v1/ivr/flows/:id/deploy)
   → luaGenerator.generate(snapshot)
   → Write Lua to FS_LUA_DIR
   → dialplanGenerator.generate(flowId, version, phoneNumber)
   → Write XML to FS_DIALPLAN_DIR
   → eslCommand('reloadxml')
   → Update ivr_flow_versions.lua_script_path and dialplan_path
```

The phone number (from `emergency_numbers` table) determines the dialplan extension that triggers the IVR.

### Dialplan XML Structure

```xml
<extension name="ivr_flow_abc123">
  <condition field="destination_number" expression="^12345$">
    <action application="lua" data="/path/to/ivr_abc123.lua"/>
  </condition>
</extension>
```

---

## Known IVR Node Bugs (Wave 1 Fixes)

### Bug 1: `ens_playback` wrong endpoint
`ens_playback` node currently calls `GET /internal/ens/lookup` instead of `GET /internal/ens/campaigns/latest`. It gets the config instead of the campaign recording. Fix: update the Lua generator to emit the correct endpoint for this node type.

### Bug 2: `webhook` URL not escaping special characters
The Lua generator embeds webhook URLs from the node `config.url` field directly into `io.popen(curl …)` without escaping query string parameters. A URL containing `&` or `=` in query values will break the curl command. Fix: URL-encode query string values in the generator.

### Bug 3: `record_message` hardcoded directory
`record_message` nodes use a hardcoded path `/var/lib/freeswitch/recordings/ivr/`. Fix: read from `freeSwitchPathService.recordingsDir`.

### Bug 4: `ens_blast_gate` PIN retry count
`ens_blast_gate` allows unlimited PIN attempts (Lua loops without a counter). Fix: add `max_pin_attempts` config field (default: 3) to the node type schema and generator.

### Bug 5: `ers_connect` legacy node
`ers_connect` IVR node attempts to originate directly into an ERS conference from within the IVR Lua script. This bypasses ERS incident creation, responder ringing, and all reporting. The node should be deprecated. Replace with a `transfer` node targeting an ERS phone number, allowing the standard ERS conference flow to execute.

---

## Variable Registry

Channel variables set by IVR execution that downstream nodes and Lua calls may read:

| Variable | Set by | Read by |
|---|---|---|
| `enrs_session_uuid` | outboundRouter / ESL | ESL event handlers |
| `ivr_flow_id` | Lua generator | IVR executor, audit |
| `ivr_version_id` | Lua generator | IVR executor, audit |
| `ivr_digits_collected` | `get_digits` node | `condition`, `goto` nodes |
| `ivr_speech_result` | `get_speech` node | `condition` nodes (future) |
| `ivr_record_path` | `record_message` node | `webhook` nodes, ENS blast |
| `ivr_loop_count` | IVR executor | Loop prevention |

Custom variables set by `set_variable` nodes use the prefix `ivr_custom_` to avoid collision with FS system variables.

---

## Future IVR Capabilities

These are designed as extensions to the node registry — no executor changes required unless new node categories are needed:

- **ACD Queue node** — `queue` type: place caller in a named queue; emit agent assignment event
- **ASR node** — `get_speech` type: integrate with Whisper or Google Speech
- **Voicemail node** — `voicemail` type: record to named mailbox, notify owner
- **SMS side-channel node** — `send_sms` type: fire a Communication Request with `channel: 'sms'`
- **Callback node** — `schedule_callback` type: create a scheduled Communication Request for later
