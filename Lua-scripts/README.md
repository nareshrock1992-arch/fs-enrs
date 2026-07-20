# Lua Scripts — fs-enrs

FreeSWITCH Lua call-handling scripts for the Emergency Response & Notification System.

---

## Architecture Overview

```
FreeSWITCH Dialplan (hand-configured per number)
        │
        ├─► ers_conference_bridge.lua    ERS trigger numbers (e.g. 1222)
        │
        ├─► ens_blast_trigger.lua        ENS blast trigger numbers (e.g. 1888)
        │
        └─► ens_playback_handler.lua     ENS playback numbers (e.g. 1999)
                │
                └─► Backend  /api/v1/internal/*  (X-Internal-Key auth)
```

**Separately**, the backend deployment pipeline generates and writes:

```
backend deploy  ──►  {FS_SCRIPT_DIR}/ivr_executor.lua   (IVR flow runner, auto-generated)
                ──►  {FS_DIALPLAN_DIR}/enrs_ivr.xml      (IVR dialplan, auto-generated)
```

The three hand-written scripts in this directory are **not** managed by the deployment pipeline. They are deployed manually (`cp Lua-scripts/*.lua $FS_LUA_DIR/`) and their dialplan extensions must be configured separately on the FreeSWITCH server.

---

## Script Reference

### `ers_conference_bridge.lua`

| Property | Value |
|---|---|
| **Purpose** | ERS emergency conference bridge: create incident, invite responders, manage queue |
| **Entry point** | FreeSWITCH dialplan `<action application="lua" data="ers_conference_bridge.lua"/>` |
| **Called by** | ERS trigger number extensions in FreeSWITCH dialplan |
| **Related XML** | Hand-configured extension per ERS trigger number |
| **Backend service** | `ersInternalController.js` |
| **FreeSWITCH modules** | `mod_lua`, `mod_conference`, `mod_dptools` |

**API endpoints called (all `/api/v1/internal`):**

| Verb | Path | When |
|---|---|---|
| GET | `/ers/lookup?number=<dest>` | Step 1 — fetch full config |
| POST | `/ers/incidents` | Step 3 — create ACTIVE or QUEUED incident |
| GET | `/ers/incidents/<uuid>/status` | Queue poll loop (every 3 s) |
| PATCH | `/ers/incidents/<uuid>/responder` | After each `freeswitch.bgapi(originate …)` |
| POST | `/ers/incidents/<uuid>/complete` | After caller disconnects from conference |

**Environment variables:**

| Variable | Default | Purpose |
|---|---|---|
| `ENRS_INTERNAL_API` | `http://127.0.0.1:4100/api/v1/internal` | Backend base URL |
| `FS_INTERNAL_KEY` | *(required)* | Auth header value |
| `ENRS_ERS_REC_DIR` | `/opt/freeswitch/recordings/ers` | Recording directory |
| `ENRS_TTS_ENGINE` | `flite` | TTS engine |
| `ENRS_TTS_VOICE` | `slt` | TTS voice |

**Dialplan example:**
```xml
<extension name="ers_1222">
  <condition field="destination_number" expression="^(1222)$">
    <action application="lua" data="ers_conference_bridge.lua"/>
  </condition>
</extension>
```

---

### `ens_blast_trigger.lua`

| Property | Value |
|---|---|
| **Purpose** | ENS blast trigger: authenticate caller, record message, start outbound campaign |
| **Entry point** | FreeSWITCH dialplan `<action application="lua" data="ens_blast_trigger.lua"/>` |
| **Called by** | ENS blast number extensions in FreeSWITCH dialplan |
| **Related XML** | Hand-configured extension per ENS trigger number |
| **Backend service** | `ensInternalController.js` |
| **FreeSWITCH modules** | `mod_lua`, `mod_dptools`, `mod_tone_stream` |

**API endpoints called (all `/api/v1/internal`):**

| Verb | Path | When |
|---|---|---|
| GET | `/ens/lookup?number=<dest>` | Step 1 — fetch ENS config |
| POST | `/ens/verify-pin` | Step 2 — PIN auth (if `pin_required`) |
| POST | `/ens/campaign/start` | Step 4 — start outbound campaign |

**Environment variables:**

| Variable | Default | Purpose |
|---|---|---|
| `ENRS_INTERNAL_API` | `http://127.0.0.1:4100/api/v1/internal` | Backend base URL |
| `FS_INTERNAL_KEY` | *(required)* | Auth header value |
| `ENRS_REC_DIR` | `/opt/freeswitch/recordings/ens` | ENS recording directory |
| `ENRS_TTS_ENGINE` | `flite` | TTS engine |
| `ENRS_TTS_VOICE` | `slt` | TTS voice |

**Dialplan example:**
```xml
<extension name="ens_blast">
  <condition field="destination_number" expression="^(1888)$">
    <action application="lua" data="ens_blast_trigger.lua"/>
  </condition>
</extension>
```

---

### `ens_playback_handler.lua`

| Property | Value |
|---|---|
| **Purpose** | ENS on-demand playback: contacts call to hear the latest emergency recording |
| **Entry point** | FreeSWITCH dialplan `<action application="lua" data="ens_playback_handler.lua"/>` |
| **Called by** | ENS playback number extensions in FreeSWITCH dialplan |
| **Related XML** | Hand-configured extension per ENS playback number |
| **Backend service** | `ensInternalController.js` |
| **FreeSWITCH modules** | `mod_lua`, `mod_dptools` |

**API endpoints called (all `/api/v1/internal`):**

| Verb | Path | When |
|---|---|---|
| GET | `/ens/lookup?number=<dest>` | Step 1 — fetch ENS config |
| GET | `/ens/campaigns/latest?configuration_id=<id>` | Step 2 — get latest campaign |
| GET | `/ens/campaigns/<id>/playback-log?caller=<num>` | Step 5 — log playback (best-effort) |

**Environment variables:**

| Variable | Default | Purpose |
|---|---|---|
| `ENRS_INTERNAL_API` | `http://127.0.0.1:4100/api/v1/internal` | Backend base URL |
| `FS_INTERNAL_KEY` | *(required)* | Auth header value |
| `ENRS_TTS_ENGINE` | `flite` | TTS engine |
| `ENRS_TTS_VOICE` | `slt` | TTS voice |

**Dialplan example:**
```xml
<extension name="ens_playback_1999">
  <condition field="destination_number" expression="^(1999)$">
    <action application="answer"/>
    <action application="lua" data="ens_playback_handler.lua"/>
  </condition>
</extension>
```

---

## Deployment

All three scripts must be copied to the FreeSWITCH Lua scripts directory:

```bash
cp Lua-scripts/ens_blast_trigger.lua     $FS_LUA_DIR/
cp Lua-scripts/ens_playback_handler.lua  $FS_LUA_DIR/
cp Lua-scripts/ers_conference_bridge.lua $FS_LUA_DIR/
```

Default `$FS_LUA_DIR` on Debian: `/usr/share/freeswitch/scripts/`

After copying, create the corresponding dialplan extensions in your FreeSWITCH dialplan (see per-script examples above) and reload:

```
fs_cli -x "reloadxml"
```

---

## Runtime Call Flow

```
Incoming Call
     │
     ▼
FreeSWITCH Dialplan (destination_number match)
     │
     ├── ERS trigger number ──► ers_conference_bridge.lua
     │        │
     │        ├── GET /ers/lookup          ─► Backend (config + slot assignment)
     │        ├── POST /ers/incidents      ─► Backend (create ACTIVE/QUEUED incident)
     │        ├── [QUEUED] poll /status    ─► Backend (every 3 s)
     │        ├── freeswitch.bgapi(orig.)  ─► FreeSWITCH (invite responders, non-blocking)
     │        ├── PATCH /ers/.../responder ─► Backend (log each invitation)
     │        ├── session:execute(conf)    ─► FreeSWITCH conference (caller stays here)
     │        └── POST /ers/.../complete   ─► Backend (close incident + recording path)
     │
     ├── ENS blast number ────► ens_blast_trigger.lua
     │        │
     │        ├── GET /ens/lookup          ─► Backend (config + pin_required flag)
     │        ├── [PIN] POST /ens/verify-pin ► Backend (max 3 attempts)
     │        ├── session:execute(record)  ─► FreeSWITCH (record message to WAV)
     │        └── POST /ens/campaign/start ─► Backend (outbound campaign engine)
     │
     └── ENS playback number ─► ens_playback_handler.lua
              │
              ├── GET /ens/lookup          ─► Backend (config)
              ├── GET /ens/campaigns/latest ► Backend (recording file + status)
              ├── session:execute(playback) ─► FreeSWITCH (play WAV to caller)
              └── GET /ens/.../playback-log ► Backend (increment callback_count)
```

---

## Shared Design Patterns

All three scripts follow the same conventions:

- **No hardcoded business logic.** Every decision (which room, which responders, whether to queue, which recording to play) comes from the API response. The scripts are pure call-flow executors.
- **`cjson` is optional.** `pcall(require, "cjson")` — if not installed, the scripts still work (HTTP responses are not JSON-decoded; feature degrades gracefully to nil returns).
- **HTTP via `io.popen(curl …)`.** FreeSWITCH Lua has no native HTTP library. All API calls use `curl -sf -m <timeout>` via `io.popen`.
- **`X-Internal-Key` auth.** Every curl call includes `-H "X-Internal-Key: $FS_INTERNAL_KEY"`. The backend verifies this with a timing-safe comparison against `INTERNAL_API_KEY`.
- **TTS via `speak` application.** `session:execute("speak", "engine|voice|text")`.
- **Non-blocking origination.** Responder invitations use `freeswitch.bgapi("originate …")` — not `session:execute("bgapi", …)` — so the script's execution is not blocked waiting for the outbound leg to answer.

---

## Legacy Archive

Original files with old names are preserved in `legacy/` for reference:

| Archived file | Renamed to |
|---|---|
| `legacy/dial_911_conference.lua` | `ers_conference_bridge.lua` |
| `legacy/blast_call.lua` | `ens_blast_trigger.lua` |
| `legacy/ENS_retry_playback.lua` | `ens_playback_handler.lua` |

**Bug fixed during rename:** `dial_911_conference.lua` line 110 used `session:execute(dialstr)` where `dialstr` was the full `bgapi originate …` string passed as the application name. The correct non-blocking origination API is `freeswitch.bgapi("originate …")`. The fix is in `ers_conference_bridge.lua`.

The `legacy/` files exist as a safety reference. Once the renamed scripts have been validated in a running FreeSWITCH environment, the legacy directory can be deleted.

---

## Directory Structure

```
Lua-scripts/
├── ers_conference_bridge.lua    ← ACTIVE  ERS conference bridge (official)
├── ens_blast_trigger.lua        ← ACTIVE  ENS blast trigger (official)
├── ens_playback_handler.lua     ← ACTIVE  ENS on-demand playback (official)
├── README.md                    ← this file
└── legacy/
    ├── dial_911_conference.lua  ← ARCHIVED (renamed + bgapi bug fixed)
    ├── blast_call.lua           ← ARCHIVED (renamed)
    └── ENS_retry_playback.lua   ← ARCHIVED (renamed)
```
