# Sprint B5 — ENS IVR Flow Engine

## What was built

Sprint B5 completes the ENS IVR flow by:
1. Adding 4 missing node types to the visual builder
2. Extending the ENS node with `recording_file_var` and `ens_config_var`
3. Writing the generic IVR flow executor Lua script
4. Adding internal extension originate mode to eslService.js

---

## New Node Types

| Type | Purpose | Key fields |
|---|---|---|
| `condition` | Branch on session variable value | `variable`, `operator`, `expected_value`, `true_node`, `false_node` |
| `record_message` | Record caller audio to file | `variable_name`, `max_seconds`, `silence_threshold`, `prompt_text` |
| `set_variable` | Set a channel variable | `variable`, `value` (supports `${ref}`) |
| `transfer` | Transfer call to extension | `destination`, `dialplan`, `context` |

### Condition operators

| Operator | Behaviour |
|---|---|
| `==` | String equality |
| `!=` | String inequality |
| `contains` | Substring match |
| `starts_with` | Prefix match |
| `ens_pin_valid` | HTTP lookup to `/internal/ens/lookup`, PIN compare, stores config vars |
| `ens_callback_valid` | HTTP to `/internal/ens/callbacks/authorize`, stores recording path |

### ENS node — new fields

| Field | Purpose |
|---|---|
| `ens_config_var` | Session variable holding the ENS configuration ID (set by `ens_pin_valid` condition) |
| `recording_file_var` | Session variable holding the recorded file path (set by `record_message` node) |

---

## IVR Flow Executor

**File**: `Lua-scripts/ivr_flow_executor.lua`

The executor replaces all hardcoded operator-dial Lua scripts. It:
- Fetches the published flow graph from `/internal/ivr/lookup?number=<dest>`
- Walks nodes from `entry_node_id` using a loop (MAX_LOOP=100 cycle guard)
- Executes each node via a typed handler dispatch table
- Terminates on: hangup node, transfer node, session disconnect, graph end

**Environment variables required on FreeSWITCH server**:

```
ENRS_INTERNAL_API=http://127.0.0.1:4100/api/v1/internal
FS_INTERNAL_KEY=<must match INTERNAL_API_KEY in backend .env>
ENRS_REC_DIR=/var/enrs/recordings
ENRS_TTS_ENGINE=flite
ENRS_TTS_VOICE=slt
```

---

## ENS Operator Dial Flow (Lab Mode)

This is the canonical ENS IVR flow. Build it in the IVR builder exactly as shown:

```
[entry] node_welcome
  say: "Welcome to the Emergency Notification System. Please enter your PIN followed by pound."
  → node_collect_pin

node_collect_pin
  gather:
    variable_name: gather_result
    max_digits: 6
    timeout_seconds: 15
    terminators: #
    prompt_text: (leave blank — welcome say node plays first)
    branches:
      _default: node_check_pin
      timeout:  node_pin_timeout
      invalid:  node_pin_invalid
  → branches resolve to next node

node_check_pin
  condition:
    variable: gather_result
    operator: ens_pin_valid
    expected_value: ${destination_number}
    true_node:  node_record_prompt
    false_node: node_bad_pin

node_bad_pin
  say: "Invalid PIN. Please try again."
  → node_collect_pin        (loops back — build via goto node if needed)

node_pin_timeout
  say: "No input received. Goodbye."
  → node_hangup

node_pin_invalid
  say: "Invalid input. Please try again."
  → node_collect_pin

node_record_prompt
  say: "Please record your emergency message after the tone. Press pound when finished."
  → node_record

node_record
  record_message:
    variable_name: recorded_file_path
    max_seconds: 60
    silence_threshold: 500
    silence_hits: 3
  → node_blast

node_blast
  ens:
    ens_config_var: ens_configuration_id
    recording_file_var: recorded_file_path
    next: node_confirm

node_confirm
  say: "Emergency notification has been triggered. All contacts are being called."
  → node_hangup

node_hangup
  hangup: (no goodbye audio)
```

---

## ENS Callback Flow (Contacts Calling Back)

Option A — Visual IVR flow (bind reply_clid number to an IVR flow):

```
[entry] node_callback_check
  condition:
    variable: caller_id_number          ← populated by FreeSWITCH automatically
    operator: ens_callback_valid
    expected_value: ${destination_number}   ← the reply_clid number dialed
    true_node:  node_play_recording
    false_node: node_not_authorized

node_play_recording
  play:
    audio_url: ${ens_recording_file}     ← set by ens_callback_valid condition
    next: node_hangup

node_not_authorized
  say: "There is no active emergency notification at this time."
  → node_hangup

node_hangup
  hangup
```

Option B — Use the standalone `ens_callback_handler.lua` (no visual builder needed).

---

## FreeSWITCH Dialplan

Add to `/etc/freeswitch/dialplan/default.xml` (or equivalent):

```xml
<!-- IVR Flow executor — handles all numbers with bound IVR flows -->
<extension name="ivr_flow_executor">
  <condition field="${ivr_flow_lookup}" expression="true"/>
  <condition field="destination_number" expression="^(\d+)$">
    <action application="set" data="destination_number=$1"/>
    <action application="lua" data="ivr_flow_executor.lua"/>
  </condition>
</extension>

<!-- ENS operator access extension (lab mode) -->
<extension name="ens_operator_access">
  <condition field="destination_number" expression="^(1200)$">
    <action application="set" data="destination_number=1200"/>
    <action application="lua" data="ivr_flow_executor.lua"/>
  </condition>
</extension>

<!-- ENS callback (contacts calling back) — use if NOT in IVR builder -->
<extension name="ens_callback">
  <condition field="destination_number" expression="^(1300)$">
    <action application="set" data="reply_clid=1300"/>
    <action application="lua" data="ens_callback_handler.lua"/>
  </condition>
</extension>
```

**Internal extension lab mode** — no external SIP gateway required. FreeSWITCH internal profile handles all calls between extensions.

---

## ESL Internal Extension Originate (Lab Mode)

The `originateCall` function in `eslService.js` now supports three modes:

```js
// Lab mode — internal extensions, no SIP gateway needed
await originateCall({
  mode: 'user',
  extension: '1001',
  clid: '1200',
  action: 'playback',
  target: '/var/enrs/recordings/blast.wav',
});

// Internal SIP profile (explicit domain)
await originateCall({
  mode: 'internal',
  extension: '1001',
  domain: '192.168.1.100',
  clid: '1200',
  action: 'playback',
  target: '/var/enrs/recordings/blast.wav',
});

// Production — external SIP gateway
await originateCall({
  mode: 'gateway',
  gateway: 'my_sip_provider',
  to: '+61400000000',
  clid: '1300',
  action: 'playback',
  target: '/var/enrs/recordings/blast.wav',
});
```

Set `ENS_ORIGINATE_MODE=user` in the backend `.env` to default all ENS blasts to internal extension mode.

---

## Deployment Steps

### 1. Backend

```bash
cd backend
npm install
# No new migration required for B5
pm2 restart fs-enrs-backend
```

### 2. Frontend

```bash
cd frontend
npm install && npm run build
cp -r dist/* /var/enrs/frontend/dist/
```

### 3. FreeSWITCH Lua scripts

```bash
cp Lua-scripts/ivr_flow_executor.lua    /usr/share/freeswitch/scripts/
cp Lua-scripts/ens_callback_handler.lua /usr/share/freeswitch/scripts/

# Set permissions
chmod 644 /usr/share/freeswitch/scripts/ivr_flow_executor.lua
chmod 644 /usr/share/freeswitch/scripts/ens_callback_handler.lua

# Create recordings directory
mkdir -p /var/enrs/recordings
chown freeswitch:freeswitch /var/enrs/recordings
chmod 755 /var/enrs/recordings
```

### 4. FreeSWITCH environment

Add to `/etc/freeswitch/vars.xml` or set via systemd EnvironmentFile:

```xml
<X-PRE-PROCESS cmd="set" data="ENRS_INTERNAL_API=http://127.0.0.1:4100/api/v1/internal"/>
<X-PRE-PROCESS cmd="set" data="FS_INTERNAL_KEY=YOUR_INTERNAL_KEY_HERE"/>
<X-PRE-PROCESS cmd="set" data="ENRS_REC_DIR=/var/enrs/recordings"/>
<X-PRE-PROCESS cmd="set" data="ENRS_TTS_ENGINE=flite"/>
<X-PRE-PROCESS cmd="set" data="ENRS_TTS_VOICE=slt"/>
```

### 5. Add ENS configuration in the web UI

Create an ENS configuration with:
- Destination number: `1200` (the operator access extension)
- Reply CLID: `1300` (the callback number contacts call back on)
- PIN: any 4-6 digit code
- Contacts: internal extensions (e.g., 1001, 1002, 1003)

### 6. Build and publish the ENS operator IVR flow

Using the visual IVR builder:
1. Go to IVR Flows → New Flow → "ENS Operator Access"
2. Build the flow as described in the canonical flow section above
3. Validate → Publish
4. Bind to emergency number `1200`

### 7. Lab smoke test checklist

```
[ ] Dial 1200 from internal extension
[ ] Hear welcome TTS prompt
[ ] Enter PIN → press #
[ ] Hear "Invalid PIN" on wrong PIN (loops back)
[ ] Enter correct PIN → hear record prompt
[ ] Record message → press #
[ ] Hear "Emergency notification triggered"
[ ] Check backend logs: ENS blast created, contacts being called
[ ] Check internal extensions (1001, 1002, ...) receive calls playing recording
[ ] From extension 1002, dial 1300
[ ] Hear recording played back
[ ] Check backend: callback logged for that delivery
[ ] Dial 1300 from an extension NOT in the contact list → hear "not registered"
[ ] Wait 24h (or set recording_retention_hours=0 to test expiry) → hear "expired"
```

---

## Final GO/NO-GO — ENS IVR Flow (Lab Mode)

| Component | Status |
|---|---|
| 4 new node types implemented | ✅ |
| ENS node extended with recording_file_var | ✅ |
| IVR flow executor Lua script | ✅ |
| ENS callback handler Lua script | ✅ |
| Internal extension originate mode | ✅ |
| Backend API endpoints all present | ✅ |
| Visual builder supports full ENS flow | ✅ |
| No SIP trunk required for lab mode | ✅ |
| Retry handled by existing blast_call scripts | ✅ |
| 24h recording expiry enforced by backend | ✅ |

**VERDICT: GO for Friday lab deployment** — pending smoke test checklist above passing on Dabin server.
