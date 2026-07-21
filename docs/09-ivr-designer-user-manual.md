# IVR Designer User Manual

**Product:** fs-enrs Emergency Notification and Response System
**Audience:** ADMIN and SUPERVISOR users
**Applies to:** IVR Flow Builder (`/ivr` in the web UI)

---

## Overview

The IVR Designer is the visual flow-builder component of fs-enrs. It provides a drag-and-drop canvas on which you construct call-flow graphs that FreeSWITCH executes when a caller dials an emergency number of type `IVR`.

A flow is stored as a directed graph (`entry_node_id` + a keyed map of `nodes`) in the `ivr_flows.graph` JSONB column. The designer reads and writes this column in real time, meaning no separate "save" step is needed for most operations — the canvas auto-saves the draft whenever you pause editing.

### When to Use the IVR Designer

Use the IVR Designer when you need to:

- Build a custom voice menu in front of an ERS conference or ENS blast trigger.
- Route callers by time-of-day, DTMF digit, PIN, or caller authorization status.
- Collect and record a voice message before starting an ENS notification.
- Add hold-queue logic before bridging to an ERS conference.

The IVR Designer **does not** apply to ERS and ENS numbers that are configured directly (without a custom menu). Those types operate through the `ers_conference_bridge.lua` and `ens_blast_trigger.lua` scripts and do not require an IVR flow.

### Prerequisites

| Requirement | Detail |
|---|---|
| Role | `ADMIN` or `SUPERVISOR` |
| Organization | At least one organization configured under Settings |
| Emergency Number | At least one number of type `IVR` added in Settings → Emergency Numbers |
| Audio files (optional) | WAV files uploaded to the Deployment → Audio Library before referencing them in `play` nodes |

---

## Accessing the IVR Designer

### Flow List

Navigate to **IVR** in the main navigation (URL: `/ivr`). The list page shows all flows belonging to your tenant, with columns for:

- Flow name and description
- Organization
- Latest published version and publish date
- Number of bound emergency numbers

### Creating a New Flow

1. Click **New Flow** (top right of the list page).
2. Enter a name (required, 1–128 characters) and an optional description.
3. Select an organization if multi-organization mode is enabled.
4. Click **Create**. The designer opens immediately on an empty canvas.

### Editing an Existing Flow

Click the flow name in the list to open the designer. The canvas restores the previously saved pan position and zoom level (`_viewport`), and all nodes restore to their saved positions (`_layout`).

### Auto-Save Behavior

The designer auto-saves the draft graph to the backend every time the internal `dirty` flag is set and the user pauses for a short interval. The toolbar shows a **Saved** badge (green) or **Unsaved changes** indicator (amber). If you attempt to close or reload the browser tab while unsaved changes exist, the browser prompts you to confirm.

You can force an immediate save with **Save Now** in the toolbar.

> **Note:** Auto-save persists the draft graph including `_layout` (node positions) and `_viewport` (pan/zoom). It does **not** create a published version. Publishing is a separate, explicit action.

---

## Canvas Layout

The designer uses a three-column layout within the main content area:

```
┌─────────────────────┬──────────────────────────────────────┬────────────────────┐
│   Node Palette      │         Flow Canvas (infinite)        │  Property Panel    │
│   (188 px wide)     │                                       │   (220 px wide)    │
│                     │                                       │                    │
│  Audio              │   [Entry] ──► [Gather] ──► [ERS]     │  Node: Gather DTMF │
│  ▶ Play Audio       │                                       │  Variable: choice  │
│  💬 Say (TTS)       │                                       │  Max digits: 1     │
│                     │                                       │  Timeout: 10s      │
│  Input              │                                       │  ...               │
│  ⌨ Gather DTMF     │                                       │                    │
│  ⑂ Condition       │                                       │                    │
│                     │                                       │                    │
│  Flow               │                                       │                    │
│  ↩ Go To Node       │                                       │                    │
│  ✕ Hangup           │                                       │                    │
│  ↗ Transfer         │                                       │                    │
│                     │                                       │                    │
│  Emergency          │                                       │                    │
│  📢 Trigger ENS     │                                       │                    │
│  🚨 Trigger ERS     │                                       │                    │
│  📟 ERS Ring-All    │                                       │                    │
│  🚦 ERS Overflow…   │                                       │                    │
│  ⏳ ERS Wait        │                                       │                    │
│  📣 ENS Blast…      │                                       │                    │
│  🔐 Playback Gate   │                                       │                    │
│                     │                                       │                    │
│  Integrations       │                                       │                    │
│  🪝 Webhook         │                                       │                    │
│                     │                                       │                    │
│  Recording          │                                       │                    │
│  ⏺ Record          │                                       │                    │
│  📌 Set Variable    │                                       │                    │
└─────────────────────┴──────────────────────────────────────┴────────────────────┘
```

### Left Panel — Node Palette

The palette organizes all 17 node types into categories:

| Category | Nodes |
|---|---|
| Audio | Play Audio, Say (TTS) |
| Input | Gather DTMF, Condition |
| Flow | Go To Node, Hangup, Transfer |
| Emergency | Trigger ENS, Trigger ERS, ERS Ring-All, ERS Overflow Check, ERS Overflow Wait, ENS Blast (PIN + Record), Playback Gate |
| Integrations | Webhook |
| Recording | Record, Set Variable |

Click any palette chip to add the node to the centre of the canvas at a random offset near (200, 100) canvas units. Alternatively, drag a chip from the palette and drop it on the canvas to place it at a specific position.

### Centre Panel — Flow Canvas

The canvas is infinite (panning is unlimited in all directions). Each node appears as a coloured card with:

- An icon and label at the top.
- A summary line showing the key config values.
- Input port (left edge, grey dot) — the incoming connection anchor.
- Output port(s) (right edge) — one or more coloured dots depending on port strategy.

**Canvas interactions:**

| Action | Input |
|---|---|
| Pan | Middle-click drag, or Space + left-click drag |
| Zoom | Mouse wheel |
| Select node | Left-click |
| Move node | Left-click drag on node body |
| Connect nodes | Drag from output port dot to another node's input port |
| Disconnect edge | Click the edge to select it, then press Delete |
| Delete node | Select node, press Delete (or use right-click context menu) |
| Duplicate node | Right-click → Duplicate |
| Undo | Ctrl+Z |
| Redo | Ctrl+Shift+Z |

Zoom controls and a node-count badge are rendered in the bottom-right corner of the canvas.

Nodes with validation errors display a **red badge** on the canvas; nodes with warnings display a **yellow badge**.

### Right Panel — Property Panel

Clicking a node on the canvas opens its configuration form in the right panel. Each field is rendered generically from the node type's `configSchema` definition (served by `GET /api/v1/ivr/node-types`). Field types include:

- `text` / `textarea` — free-form strings
- `number` — numeric input with min/max constraints
- `select` — dropdown for enum fields
- `node_ref` — dropdown showing all nodes in the current flow (for successor/branch references)
- `audio_url` — text field constrained to `/media/` prefix
- `branches_map` — dynamic key/value editor for DTMF branch maps
- `mono_text` — monospace text field for variable names and paths
- `ens_config_ref` / `ers_config_ref` — dropdowns populated from the backend configuration lists

The **Entry Point** badge appears at the top of the Property Panel when the selected node is the flow's `entry_node_id`. Click **Set as Entry** to designate a different node as the entry point.

### Top Toolbar

| Control | Function |
|---|---|
| Flow name | Editable in-place; saved on blur |
| **Save Now** | Force immediate draft save |
| **Validate** | POST `/api/v1/ivr/flows/:uuid/validate` — shows error/warning panel below toolbar |
| **Publish** | POST `/api/v1/ivr/flows/:uuid/publish` — creates a new immutable version |
| **History** | Opens the version history drawer (right slide-in panel) |
| **Bind Number** | Opens the Bind Numbers modal |

---

## Building a Flow — Step by Step

### 1. Create the Flow

Click **New Flow** on the IVR list page. Give it a name that reflects its purpose (e.g., "Campus Emergency — Business Hours").

### 2. Place the Entry Point

Every flow must have exactly one entry point. Drag any node onto the canvas that will receive the call first (typically a `play` or `say` node for a greeting, or a `gather` node for an immediate menu).

With that node selected, click **Set as Entry** in the Property Panel. The node displays an "ENTRY" badge and its ID is saved as `entry_node_id` in the graph.

### 3. Build Out the Flow

Add nodes from the palette and connect them:

1. Drag or click a node type from the palette to place it on the canvas.
2. Configure it in the Property Panel.
3. Draw a connection: hover over the source node's output port dot until it highlights, then drag to the destination node's input port.
4. The connection appears as a curved edge. The port label (e.g., `next`, `true`, `false`, `1`, `2`, `_default`) is shown on the source end.

### 4. Connect All Paths to Terminal Nodes

Every non-terminal path must eventually reach a terminal node: `hangup`, `transfer`, `ers`, or `ers_ring_all`. The validator catches paths that loop forever without reaching a terminal.

### 5. Validate

Click **Validate** in the toolbar. The validation panel shows:

- **Errors** (red): blocking issues that prevent publishing.
- **Warnings** (yellow): non-blocking issues such as orphaned nodes.
- **Stats**: total node count, reachable nodes, unreachable nodes.

Fix all errors before proceeding. Warnings are advisory.

### 6. Publish

Click **Publish**. Optionally enter change notes in the dialog. The backend runs a full validation (including database FK checks for all ENS/ERS configuration IDs and audio file IDs). If validation passes, a new version record is created in `ivr_flow_versions`. The toolbar updates to show the new version number.

> **Important:** Published versions are immutable. To modify a published flow, edit the draft (which remains editable at all times) and publish a new version.

### 7. Bind to an Emergency Number

Click **Bind Number** in the toolbar. The modal lists all active emergency numbers of type `IVR` belonging to your tenant. Select a number and click **Bind**. The backend calls `PATCH /api/v1/ivr/flows/:uuid/bind` with the `emergency_number_id`.

A number can only be bound to one flow at a time. Binding a number to a new flow automatically removes it from any previous binding.

### 8. Deploy

Deployment is handled from **Settings → Deployment** (URL: `/deployment`). Select the flow and click **Deploy**. The backend:

1. Re-validates the latest published graph.
2. Generates `ivr_executor.lua` — the Lua call-handler script.
3. Writes `ivr_executor.lua` to the FreeSWITCH scripts directory (default: `/usr/share/freeswitch/scripts/ivr_executor.lua`).
4. Generates `enrs_ivr.xml` — the FreeSWITCH dialplan XML for all bound numbers.
5. Writes `enrs_ivr.xml` to the FreeSWITCH dialplan directory (default: `/etc/freeswitch/dialplan/enrs_ivr.xml`).
6. Sends `bgapi reloadxml` to FreeSWITCH via ESL.
7. Verifies the extension loaded using `xml_locate`.

After a successful deployment, inbound calls to any bound number execute the generated Lua script.

---

## Entry Point

Every flow graph contains exactly one `entry_node_id`. This is the node whose Lua handler runs first when a call arrives.

Rules:

- `entry_node_id` must reference an existing node ID in the `nodes` map.
- An empty string (`""`) is accepted for unsaved drafts with no nodes yet — this is the initial state of a newly created flow.
- The validator rejects a non-empty `entry_node_id` that does not match any node key.

To change the entry point, select the new entry node on the canvas and click **Set as Entry** in the Property Panel.

---

## Node Connection Rules

### Port Strategies

Each node type uses one of six port strategies, defined in the node-type registry:

| Strategy | Output Ports | Used By |
|---|---|---|
| `next` | Single `next` port, always shown | play, say, record_message, set_variable, webhook, ers_overflow_wait |
| `next_optional` | Single `next` port, shown only if `node.next` is set | ens |
| `true_false` | Two ports: `true_node` and `false_node` | condition, ens_playback_gate |
| `branches` | One port per key in `node.branches` (dynamic) | gather, ers_overflow_check |
| `goto_target` | Single port labelled `target` (maps to `target_node_id`) | goto |
| `none` | No output ports — terminal node | hangup, ers, transfer, ers_ring_all |

### Drawing Connections

1. Hover over a source node's output port dot (right edge of the node card). The dot highlights.
2. Click and drag from the dot.
3. Release over the destination node's input port (left edge of any node).
4. The edge is created and the appropriate field (`next`, `true_node`, `false_node`, etc.) is set in the source node's config.

### Removing Connections

Click an edge to select it (it turns highlighted). Press Delete to remove it. The corresponding field in the source node's config is cleared.

### Connection Validation

The validator enforces these structural rules:

- All node references (`next`, `true_node`, `false_node`, `branches` values, `target_node_id`) must point to existing node IDs.
- Every reachable node must have at least one path to a terminal node (hangup / transfer / ers / ers_ring_all). The Lua executor's `MAX_STEPS=100` guard is the runtime backstop for infinite loops.
- Unreachable nodes (not reachable from `entry_node_id`) produce warnings, not errors, because the canvas may have work-in-progress orphans.

---

## Validation

The **Validate** button in the toolbar calls `POST /api/v1/ivr/flows/:uuid/validate`. You can also validate a candidate graph without saving by passing `{ graph: {...} }` in the request body.

### Validation Response

```json
{
  "valid": false,
  "errors": [
    "node node_abc123: references non-existent node \"node_xyz999\"",
    "ens_configuration_id 42 not found or wrong tenant"
  ],
  "warnings": [
    "Node \"node_orphan\" is not reachable from entry_node_id"
  ],
  "stats": {
    "node_count": 7,
    "reachable": 6,
    "unreachable": 1
  }
}
```

### Two-Pass Validation

**Pass 1 — Zod Schema:** Every node is validated against its type-specific Zod schema (`ivrValidator.js`). Missing required fields, out-of-range numbers, and invalid variable names are caught here.

**Pass 2 — Graph Integrity:**

1. Dangling references: any `next`/`true_node`/`false_node`/`branches` value that does not match an existing node key.
2. Reachability: BFS from `entry_node_id` identifies reachable vs. unreachable nodes.
3. Terminal reachability: reverse BFS from all terminal nodes. Any reachable node with no path to a terminal is an error.
4. Per-node lint: missing `ers_configuration_id` on ERS nodes, missing branch connections on `ers_overflow_check`, etc.
5. Database FK checks (publish only): ENS configuration IDs, ERS configuration IDs, and audio file IDs are verified to exist in the tenant's data.

---

## Publishing

Clicking **Publish** in the toolbar calls `POST /api/v1/ivr/flows/:uuid/publish`.

Request body (optional):
```json
{ "change_notes": "Added overnight routing branch" }
```

The backend:

1. Runs full validation (all passes including DB FK checks).
2. On success, inserts a row into `ivr_flow_versions` with an auto-incremented `version_number` (starting at 1).
3. The version's `graph` column captures a snapshot of the current `ivr_flows.graph`.
4. Returns the version record including `version_number`, `published_at`, and `published_by_email`.

Response (HTTP 201):
```json
{
  "version": {
    "version_number": 3,
    "published_at": "2026-07-20T14:30:00Z",
    "published_by_email": "admin@example.com",
    "warnings": ["Node \"node_orphan\" is not reachable from entry_node_id"]
  }
}
```

> **Versions are immutable.** Once published, a version's graph cannot be changed. The live draft in `ivr_flows.graph` remains editable.

---

## Version History

Click **History** in the toolbar to open the Version History drawer.

### Listing Versions

`GET /api/v1/ivr/flows/:uuid/versions` returns all published versions in descending order:

```json
{
  "versions": [
    { "version_number": 3, "published_at": "...", "published_by_email": "...", "change_notes": "..." },
    { "version_number": 2, "published_at": "...", "published_by_email": "..." },
    { "version_number": 1, "published_at": "...", "published_by_email": "..." }
  ]
}
```

### Inspecting a Version

`GET /api/v1/ivr/flows/:uuid/versions/:vnum` — click a version row in the drawer to view its graph snapshot.

### Restoring a Version

In the drawer, click **Restore** next to any version. The UI confirms before proceeding. On confirmation, the version's graph is loaded into the current draft canvas (via the `SEED` graph dispatch action). The draft is overwritten but the restored state is not yet published — review it and click **Publish** to create a new version from the restored content.

---

## Binding to Emergency Numbers

### Binding

`PATCH /api/v1/ivr/flows/:uuid/bind`

```json
{ "emergency_number_id": 15 }
```

Rules:
- The emergency number must belong to the same tenant.
- The number's type must be `IVR` (enforced at the UI level; the API does not enforce the type constraint but the FreeSWITCH dialplan generator only generates extensions for `IVR`-type numbers).
- A number can only be bound to one flow at a time. Binding it to this flow does not automatically unbind it from another flow — you must unbind first.

### Unbinding

`PATCH /api/v1/ivr/flows/:uuid/unbind`

```json
{ "emergency_number_id": 15 }
```

The number's `ivr_flow_id` is set to `NULL`. If the flow is deleted, all bound numbers are automatically unbound.

---

## Deploying

Deployment is performed from the Deployment page (`/deployment`). The operation calls the deployment engine for the selected flow.

### Deployment Pipeline

1. **Validate** — the latest published graph is validated (full two-pass validation with DB FK checks).
2. **Generate Lua** — `ivr_executor.lua` is generated from the node registry's `luaHandler` entries, assembled into a dispatch table and executor loop.
3. **Write Lua** — the script is written to `${FS_SCRIPTS_DIR}/ivr_executor.lua` (default: `/usr/share/freeswitch/scripts/ivr_executor.lua`).
4. **Generate XML** — `enrs_ivr.xml` dialplan is generated with one `<extension>` per bound number, each calling `lua ivr_executor.lua`.
5. **Write XML** — the dialplan is written to `${FS_DIALPLAN_DIR}/enrs_ivr.xml` (default: `/etc/freeswitch/dialplan/enrs_ivr.xml`).
6. **Reload FreeSWITCH** — `bgapi reloadxml` is sent via ESL (`src/services/eslService.js`).
7. **Verify** — `xml_locate dialplan default <condition>` is called to confirm the extension is loaded.

### Deployment Failure Recovery

If the Lua write or XML write fails (permissions, missing directory), the deployment engine returns an error without attempting `reloadxml`. Fix the filesystem issue and re-deploy.

If `reloadxml` fails, FreeSWITCH continues serving the previous dialplan. Check the ESL connection (`FREESWITCH_HOST`, `FREESWITCH_PORT=8021`, `FREESWITCH_PASSWORD`) and retry.

---

## Templates

Pre-built flow templates speed up common patterns.

### Listing Templates

`GET /api/v1/ivr/flows/templates` — returns all available templates.

### Creating from a Template

`POST /api/v1/ivr/flows/templates/:id/create` — clones the template graph into a new `ivr_flows` row with the template's default name. The new flow opens in the designer for customization.

> Templates are read-only reference graphs; cloning never modifies the source template.

---

## Common Flow Patterns

### Pattern 1: Simple Welcome Menu

A greeting followed by a DTMF menu that routes to ERS or plays an information message.

```
[Entry: say "Welcome to Campus Emergency"]
    │ next
    ▼
[gather: max_digits=1, timeout=10s, branches: 1→ers_node, _default→repeat_node]
    │ 1
    ▼
[ers: ers_configuration_id=1, group_type=primary]   ← terminal

    │ _default
    ▼
[say: "Invalid selection. Please try again."]
    │ next
    ▼
[goto: target_node_id=gather_node]   ← loops back (MAX_STEPS=100 prevents runaway)
```

### Pattern 2: ENS PIN Verification Flow

An operator calls in, enters a PIN, and if valid, records and sends an emergency notification.

```
[Entry: say "Emergency Notification System. Please enter your PIN."]
    │ next
    ▼
[gather: variable_name=entered_pin, max_digits=8, terminators=#]
    │ _default
    ▼
[condition: variable=entered_pin, operator=ens_pin_valid, expected_value=${destination_number}]
    │ true_node                        │ false_node
    ▼                                  ▼
[ens_blast_record:                 [say: "Invalid PIN. Goodbye."]
  pin_prompt_text=...,                 │ next
  record_prompt_text=...]              ▼
    │ next                         [hangup]
    ▼
[say: "Your notification is being sent."]
    │ next
    ▼
[hangup]
```

> **Note:** The `ens_blast_record` node handles its own internal PIN gate with 3 attempts and records the message in one step. The pattern above uses a separate `gather` + `condition` only when you need intermediate logic between PIN validation and recording.

### Pattern 3: Time-of-Day Routing

Route to primary ERS during business hours, secondary (or an informational message) after hours.

```
[Entry: say "Thank you for calling."]
    │ next
    ▼
[condition: variable=destination_number, operator=time_of_day, expected_value="0800-1700"]
    │ true_node                        │ false_node
    ▼                                  ▼
[ers: ers_configuration_id=1,      [condition: operator=day_of_week, expected_value="1,2,3,4,5"]
  group_type=primary]                  │ true_node           │ false_node
                                       ▼                     ▼
                                   [ers:               [say: "Our offices are closed."]
                                     group_type=        │ next
                                     secondary]         ▼
                                                    [hangup]
```

### Pattern 4: Multi-Level Menu with Invalid Input Retry

A two-level menu where invalid input replays the prompt up to the MAX_STEPS limit.

```
[Entry: say "Press 1 for ERS. Press 2 for ENS. Press 9 to repeat."]
    │ next
    ▼
[gather: variable_name=top_menu, max_digits=1, branches:
    1 → ers_node
    2 → ens_node
    9 → repeat_node
    _default → invalid_node ]

invalid_node: [say: "That was not a valid option."]
    │ next
    ▼
[goto: target_node_id=entry_node]   ← back to greeting

repeat_node: [goto: target_node_id=gather_node]   ← replay just the gather

ers_node: [ers: ers_configuration_id=1]   ← terminal
ens_node: [ens_blast_record: ...]         ← handles blast internally
    │ next
    ▼
[hangup]
```

---

## Troubleshooting the Designer

| Symptom | Likely Cause | Resolution |
|---|---|---|
| Canvas blank after opening | Flow graph is empty (new flow) | Drag nodes from palette |
| Validate returns "entry_node_id not found" | Entry node was deleted without assigning a new entry | Select another node and click Set as Entry |
| Publish fails with "not found or wrong tenant" | ENS/ERS configuration ID deleted or belongs to another tenant | Re-select the configuration in the node's Property Panel |
| Deploy fails with "Permission denied" | FreeSWITCH script/dialplan directory not writable by the Node.js process | Fix directory permissions or run backend with appropriate privileges |
| Call hits IVR but plays silence | Audio file was not deployed to FreeSWITCH | Go to Deployment → Audio Library → Deploy the file |
| Version history drawer shows no versions | Flow has never been published | Click Publish to create the first version |
