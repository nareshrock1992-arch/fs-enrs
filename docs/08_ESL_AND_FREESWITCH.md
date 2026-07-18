# 08 — ESL and FreeSWITCH Integration

## ESL Connection

**Library:** `modesl` (npm)  
**Protocol:** TCP persistent connection to FreeSWITCH Event Socket on `:8021`  
**Auth:** `ClueCon` password (or `ESL_PASSWORD` env var)  
**Config:**
```
ESL_HOST=127.0.0.1
ESL_PORT=8021
ESL_PASSWORD=ClueCon
```

The connection is established in `eslService.js` at server startup. If the connection drops, a reconnect loop with exponential backoff fires every few seconds. All ESL API calls queue if the connection is not yet ready.

---

## ESL Command Layer (`eslService.js`)

### `eslCommand(cmd)`
Wraps `conn.api(cmd)` — sends an ESL API command, returns a promise resolving to the response body string.

```js
await eslCommand('conference 3010 list');
await eslCommand('api reloadxml');
await eslCommand(`bgapi originate {vars}user/1001 &conference(3010@default)`);
```

### `confRecord(room, path)`
```js
await confRecord('3010', '/var/lib/freeswitch/recordings/ers/3010_2026.wav');
// → conference 3010 record /var/lib/freeswitch/recordings/ers/3010_2026.wav
```

### `getConferenceMemberCount(room)`
Queries the in-memory `conferenceRegistry` — **no ESL round trip**. Returns `0` when the room does not exist.

### `registryGetOrCreate(confName)`
Ensures the in-memory registry has an entry for a conference room. Called on `conference-create` ESL event.

---

## In-Memory Conference Registry

`eslService.js` maintains a `Map<string, Conference>` where key is the conference room name:

```js
{
  "3010": {
    name: "3010",
    createdAt: Date,
    recording: false,
    locked: false,
    members: Map<memberId, {
      id, callerNum, callerName, muted, talking, floor, role
    }>
  }
}
```

This registry is the **live source of truth** for all monitoring operations. The DB is never queried for live conference state.

The registry is rebuilt from scratch on ESL reconnect by issuing `xml_list` (or `list`) to enumerate all current conferences.

---

## ESL Event Handling

### Subscribed events

`eslService.js` subscribes to:
- `conference::maintenance` — all conference state changes
- `CHANNEL_ANSWER` — campaign engine: call answered
- `CHANNEL_HANGUP` — campaign engine: call ended

### `conference::maintenance` Action Dispatch

| Action | Handler | Effect |
|---|---|---|
| `conference-create` | `registryGetOrCreate(confName)` | Add to registry; emit `conference.created`; trigger `handleConferenceCreated()` |
| `add-member` | Updates `conf.members` | Emit `conference.member.added`; trigger `handleFirstParticipant()` if count = 1 |
| `del-member` | Removes from `conf.members` | Emit `conference.member.removed` |
| `mute-member` | Sets `member.muted = true` | Emit `conference.member.muted` |
| `unmute-member` | Sets `member.muted = false` | Emit `conference.member.muted` |
| `start-talking` | Sets `member.talking = true` | Emit `conference.member.talking` |
| `stop-talking` | Sets `member.talking = false` | Emit `conference.member.talking` |
| `floor-change` | Sets `member.floor` | Emit `conference.member.floor` |
| `lock` | Sets `conf.locked = true` | Emit `conference.locked` |
| `unlock` | Sets `conf.locked = false` | Emit `conference.locked` |
| `record` | Sets `conf.recording = true` | Emit `conference.recording` |
| `norecord` | Sets `conf.recording = false` | Emit `conference.recording` |
| `conference-destroy` | Deletes from registry | Emit `conference.destroyed` |

### ESL Event Body Parsing

Raw ESL events arrive as URL-encoded key=value pairs. `eslService.js` parses:
- `Event-Subclass` → conference sub-type
- `Action` → the maintenance action
- `Conference-Name` → room name
- `Member-ID` → integer member ID
- `Caller-Caller-ID-Number` / `Caller-Caller-ID-Name` → member identity
- `Speak` (flag) → mute state

---

## Conference Commands

All conference control commands are ESL API calls issued from `eslCommand()`.

### Conference-Level

| Operation | ESL Command |
|---|---|
| List members (text) | `conference <room> list` |
| List members (XML) | `conference <room> xml_list` |
| Lock | `conference <room> lock` |
| Unlock | `conference <room> unlock` |
| Start recording | `conference <room> record <path>` |
| Stop recording | `conference <room> norecord <path>` |
| Play audio file | `conference <room> play <file_path>` |
| TTS announcement | `conference <room> say <text>` |
| Invite participant | `conference <room> bgdial <dial_string>` |
| Kick all members | `conference <room> kick all` |
| Transfer member | `conference <room> transfer <member_id> <ext> XML default` |

### Member-Level

| Operation | ESL Command |
|---|---|
| Mute | `conference <room> mute <member_id>` |
| Unmute | `conference <room> unmute <member_id>` |
| Kick | `conference <room> kick <member_id>` |
| Deaf | `conference <room> deaf <member_id>` |
| Undeaf | `conference <room> undeaf <member_id>` |
| Volume in | `conference <room> volume_in <member_id> <level>` |
| Volume out | `conference <room> volume_out <member_id> <level>` |
| Energy threshold | `conference <room> energy <member_id> <level>` |
| Video floor | `conference <room> vid-floor <member_id>` |

---

## Outbound Call Origination

### ERS Ring-All

Used by `ersRingService.startRingAll()` to invite responders into a conference:

```
bgapi originate {
  origination_caller_id_name='John Smith',
  origination_caller_id_number=7001003,
  effective_caller_id_name='John Smith',
  effective_caller_id_number=7001003,
  ignore_early_media=true,
  originate_timeout=25
}sofia/gateway/main-trunk/60123456789 &conference(3010@default)
```

- `bgapi` prefix — non-blocking; FS sends `BACKGROUND_JOB` event when done
- `&conference(room@profile)` — action app that joins the channel into the named conference
- `room` must be a safe conference name (alphanumeric + `_-`)
- `profile` is always validated by `getConferenceProfile()` — never a raw IP address

### ENS Campaign Call

Used by `campaignEngine.originateCampaignCall()`:

```
bgapi originate {
  origination_caller_id_number=<ens_number>,
  originate_timeout=30,
  sip_h_X-Campaign-ID=7,
  sip_h_X-Destination-ID=42
}sofia/gateway/trunk/60198765432 &lua(blast_call.lua)
```

- Campaign and destination IDs passed as SIP headers so `blast_call.lua` can read them
- The Lua script records the message then calls `POST /internal/ens/campaign/start`

---

## Recording Paths

Two parallel recording mechanisms:

### 1. Lua-Side Recording (`record_conferences = true`)
Lua script calls `session:execute("record_session", "/path/to.wav")` — records the caller's channel from the moment they joined. Triggered when the first responder answers (inside `startRingAll()`).

### 2. ESL Auto-Recording (`recording_enabled = true`, `recording_mode = AUTO`)
`conferenceManager.js` receives `handleConferenceCreated()` or `handleFirstParticipant()` hooks from `eslService.js`. It issues:
```
conference <room> record /var/lib/freeswitch/recordings/ers/<room>_<date>.wav
```

This records the entire conference mix, not just one channel.

### Recording Directory Resolution

`freeSwitchPathService.getRecordingDirForType(type)`:

| Type | Path |
|---|---|
| `ERS` | `$FS_RECORDING_DIR/ers/` |
| `ENS` | `$FS_RECORDING_DIR/ens/` |
| `IVR` | `$FS_RECORDING_DIR/ivr/` |
| `MANUAL` | `$FS_RECORDING_DIR/manual/` |

---

## IVR Deployment

The deployment pipeline produces two files per IVR flow:

### Lua Script (generated by `luaGenerator.js`)
Written to `$FS_SCRIPT_DIR/<flow_name>.lua`

Structure:
```lua
-- Auto-generated by ENRS IVR Builder
local api_base = os.getenv("ENRS_INTERNAL_API") or "http://127.0.0.1:4100"
local internal_key = os.getenv("FS_INTERNAL_KEY")

-- Entry node: MENU
session:execute("playback", "/sounds/menu_prompt.wav")
local dtmf = session:getDigits(1, "#", 5000)
if dtmf == "1" then
  -- DTMF 1 → ERS bridge
  session:execute("conference", "3010@default")
elseif dtmf == "2" then
  -- DTMF 2 → ENS recording
  session:execute("lua", "blast_call.lua")
end
```

### Dialplan XML (generated by `xmlGenerator.js`)
Written to `$FS_DIALPLAN_DIR/enrs/<flow_name>.xml`

```xml
<include>
  <context name="default">
    <extension name="enrs_ivr_flow_uuid">
      <condition field="destination_number" expression="^1222$">
        <action application="lua" data="enrs_ivr_flow_uuid.lua"/>
      </condition>
    </extension>
  </context>
</include>
```

After writing both files, the backend issues:
```
api reloadxml
```

FreeSWITCH reloads its dialplan from disk without dropping calls.

---

## SIP Gateway Deployment

`gatewayDeployment.js` generates SIP gateway XML and writes to `$FS_SIP_PROFILE_DIR`:

```xml
<include>
  <gateway name="main-trunk">
    <param name="username" value="user123"/>
    <param name="password" value="pass"/>
    <param name="proxy" value="sip.provider.com"/>
    <param name="register" value="true"/>
    <param name="caller-id-in-from" value="false"/>
  </gateway>
</include>
```

After writing, the backend issues:
```
sofia profile internal rescan
```

---

## FreeSWITCH Conference Naming Rules

Conference names must satisfy the FreeSWITCH regex `/^[a-z0-9_]{1,64}$/` (case-insensitive for most FS builds, but lowercase is safest).

**STATIC mode:** The `primary_bridge_number` / `secondary_bridge_number` value is used directly (e.g. `3010`).

**DYNAMIC mode:** `conferenceManager.resolveConferenceRoom()` generates `ers{cfgId}_{p|s}_{7hex}` (e.g. `ers1_p_0e3f2a1`).

**Profile name (`@profile`):** Always validated by `getConferenceProfile()`. Accepts only `[a-z0-9_-]{1,64}`. Rejects anything containing `.` or `:` (SIP domain IPs). Falls back to `default`.

---

## Lua Environment Variables

Lua scripts read these from the FreeSWITCH environment (set in `freeswitch.xml` or `.env` sourced by the FS init):

| Variable | Purpose |
|---|---|
| `ENRS_INTERNAL_API` | Backend base URL (`http://127.0.0.1:4100`) |
| `FS_INTERNAL_KEY` | Shared secret for `X-Internal-Key` header |
| `ENRS_TTS_ENGINE` | TTS engine name (e.g. `flite`, `google`) |
| `ENRS_TTS_VOICE` | TTS voice ID |
| `ENRS_ERS_REC_DIR` | ERS recording directory |
| `ENRS_REC_DIR` | ENS/IVR recording directory |

---

## Lua HTTP Calls

Lua scripts use `io.popen(curl ...)` — no native HTTP library. Every API call pattern:

```lua
local function http_get(url)
  local cmd = string.format(
    'curl -s -H "X-Internal-Key: %s" "%s"',
    internal_key, url
  )
  local handle = io.popen(cmd)
  local body = handle:read("*a")
  handle:close()
  return cjson.decode(body)
end
```

This is why internal API responses must be minimal and fast — Lua blocks its session while waiting.

---

## ESL Reconnect Strategy

`eslService.js` reconnect loop:

1. On `esl::disconnect_notice` or `error`: mark `connected = false`
2. Wait 2s, retry connection
3. On success: re-subscribe to events, rebuild conference registry from `xml_list`
4. `emitInternal('esl.reconnected', {})` — frontend shows reconnected banner

During disconnect: ESL commands queue in memory (with a cap). Campaign engine pauses until ESL is back.
