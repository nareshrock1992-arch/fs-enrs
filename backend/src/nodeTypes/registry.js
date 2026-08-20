/**
 * IVR Node-Type Registry — single source of truth for every node type.
 *
 * Phase 3: everything that previously had to be edited in THREE separate
 * places to add or change a node type (luaGenerator.js's hardcoded Lua
 * string, ivrValidator.js's Zod schema, PropertyPanel.jsx's hand-built
 * form) now lives here as one entry. luaGenerator.js iterates this to
 * build the dispatch table; GET /api/v1/ivr/node-types exposes configSchema
 * so the frontend renders forms generically instead of hand-building one
 * per type — see docs/EXTENDING_NODE_TYPES.md for the full walkthrough.
 *
 * This is a pure refactor of the 11 pre-existing node types — every
 * `luaHandler` body below is byte-for-byte the same Lua that
 * luaGenerator.js previously hardcoded inline. Validation (ivrValidator.js)
 * is NOT yet driven from this registry — configSchema here is presentation
 * + Lua-generation metadata, not a replacement for the Zod schemas, which
 * remain the source of truth for what the backend accepts. Unifying those
 * is a reasonable future step once this registry has proven itself, not
 * part of this refactor.
 *
 * ── configSchema field shape ──────────────────────────────────────────────
 *   key:        node property name (matches the graph JSON + Zod schema)
 *   label:      form field label
 *   fieldType:  'text' | 'textarea' | 'number' | 'select' | 'node_ref' |
 *               'audio_url' | 'branches_map' | 'mono_text'
 *   required:   boolean (informational — Zod schema is still authoritative)
 *   hint:       optional helper text shown under the field
 *   options:    for fieldType:'select' — [{ value, label }]
 *   placeholder, min, max, mono: passed through to the generic renderer
 *
 * ── ports ──────────────────────────────────────────────────────────────────
 * Selects one of a fixed set of port-rendering STRATEGIES FlowNode.jsx
 * already knows how to draw — adding a node type never requires adding a
 * new strategy unless its connection shape is genuinely novel (e.g. a
 * dynamic per-key branch map like gather's). This is a deliberately small,
 * closed set rather than a fully free-form per-node port spec: canvas
 * connection-dragging is stateful, unverifiable-without-a-browser code —
 * picking from known-working strategies keeps new node types safe to add
 * without ever touching FlowNode.jsx's rendering internals.
 *   'next'          — single 'next' output port, always shown
 *   'next_optional' — single 'next' output port, shown only if node.next is set (ens)
 *   'true_false'    — 'true_node' / 'false_node' output ports (condition)
 *   'branches'      — dynamic output ports, one per node.branches key (gather)
 *   'goto_target'   — single port keyed 'goto' (matches goto's target_node_id field)
 *   'none'          — no output port (hangup, ers, transfer — call-enders)
 */

export const NODE_TYPE_REGISTRY = [
  {
    type: 'play',
    label: 'Play Audio',
    icon: '▶',
    bg: '#1e3a5f', border: '#3b6ca8', color: '#93c5fd',
    category: 'Audio',
    description: 'Play an audio file or a dynamically generated recording from a session variable.',
    ports: 'next',
    summaryTemplate: '${audio_url}',
    configSchema: [
      {
        key: 'audio_source_type', label: 'Audio Source', fieldType: 'select',
        options: [
          { value: 'url',      label: 'Static — Media Library / URL' },
          { value: 'variable', label: 'Dynamic — Session Variable' },
        ],
        hint: 'Static: pick a file from the Media Library. Dynamic: use a file path stored in a session variable (e.g. from a Record node).',
      },
      {
        key: 'audio_url', label: 'Audio File URL', fieldType: 'audio_url',
        placeholder: '/media/welcome.wav',
        hint: 'Local media path starting with /media/. Used when Audio Source is Static.',
      },
      {
        key: 'audio_variable', label: 'Variable Name', fieldType: 'mono_text',
        placeholder: 'recorded_file_path',
        hint: 'Session variable that holds the audio file path at call time. Example: recorded_file_path (produced by a Record node). Used when Audio Source is Dynamic.',
      },
      { key: 'next', label: 'Next Node', fieldType: 'node_ref', required: true, hint: 'Node to proceed to after the audio finishes playing.' },
    ],
    luaHandler: `
local function exec_play(s, node)
  local f
  if node.audio_source_type == "variable" then
    -- Dynamic source: resolve the file path from a session variable.
    -- The variable is written by a Record node or set_variable node
    -- earlier in the flow (e.g. recorded_file_path).
    local var_name = node.audio_variable or "recorded_file_path"
    local var_val  = s:getVariable(var_name) or ""
    f = var_val ~= "" and var_val or nil
    if not f then
      freeswitch.consoleLog("WARN", "[ivr_executor] play: variable '" .. var_name .. "' is empty — skipping audio\\n")
    end
  else
    -- Static source: path from the Media Library, resolved via resolve_audio().
    f = resolve_audio(node.audio_url)
  end
  if f then s:streamFile(f) end
  return node.next
end`,
    apiEndpoint: null,
  },

  {
    type: 'say',
    label: 'Say (TTS)',
    icon: '💬',
    bg: '#1e3a2f', border: '#2d6a4f', color: '#6ee7b7',
    category: 'Audio',
    description: 'Text-to-speech message',
    ports: 'next',
    summaryTemplate: '"${text}"',
    configSchema: [
      { key: 'text', label: 'Text to speak', fieldType: 'textarea', required: true, placeholder: 'Please press 1 for emergency…' },
      { key: 'language', label: 'Language', fieldType: 'select', options: ['en-US','en-AU','en-GB','es-ES','fr-FR','de-DE'].map(l => ({ value: l, label: l })) },
      { key: 'voice', label: 'Voice (optional)', fieldType: 'text', placeholder: 'Joanna' },
      { key: 'next', label: 'Next Node', fieldType: 'node_ref', required: true, hint: 'Node to go to after speaking' },
    ],
    luaHandler: `
local function exec_say(s, node)
  speak(s, interp(s, node.text))
  return node.next
end`,
    apiEndpoint: null,
  },

  {
    type: 'gather',
    label: 'Gather DTMF',
    icon: '⌨',
    bg: '#3b2f1e', border: '#7c5c2a', color: '#fbbf24',
    category: 'Input',
    description: 'Collect DTMF digits',
    ports: 'branches',
    summaryTemplate: 'max ${max_digits} digit · ${timeout_seconds}s',
    configSchema: [
      {
        key: 'variable_name', label: 'Variable Name', fieldType: 'mono_text',
        placeholder: 'gather_result',
        hint: 'Session variable that stores the collected digits. Access it later with ${gather_result}. Example: caller_pin, menu_choice, incident_number.',
      },
      {
        key: 'min_digits', label: 'Minimum Digits', fieldType: 'number', min: 1, max: 11,
        hint: 'Fewest digits accepted before the input is considered complete. FreeSWITCH re-prompts (up to 3 tries) until this minimum is met. Example: 4 for a 4-digit PIN.',
      },
      {
        key: 'max_digits', label: 'Maximum Digits', fieldType: 'number', min: 1, max: 11,
        hint: 'Collection stops automatically when this many digits are entered. For a single-key menu set both min and max to 1.',
      },
      {
        key: 'timeout_seconds', label: 'Timeout (seconds)', fieldType: 'number', min: 1, max: 60,
        hint: 'Seconds to wait for the first digit. If no digit is received within this time, the timeout branch is followed.',
      },
      {
        key: 'terminators', label: 'DTMF Terminator', fieldType: 'select',
        options: [
          { value: '',  label: 'None — stop at max digits or timeout' },
          { value: '#', label: '# (pound) — caller presses # to confirm' },
          { value: '*', label: '* (star)' },
        ],
        hint: 'Key the caller presses to finish early. "None" is best for fixed-length inputs (menus, PINs) — collection ends as soon as max digits are reached. "#" lets callers confirm a variable-length entry.',
      },
      {
        key: 'inter_digit_timeout', label: 'Inter-digit timeout (seconds)', fieldType: 'number', min: 0, max: 30,
        hint: 'Maximum seconds allowed between consecutive digits. Defaults to 2s. Set to 0 to use FreeSWITCH\'s built-in default. Applies to playAndGetDigits path (Prompt Audio File configured).',
      },
      {
        key: 'prompt_audio_url', label: 'Prompt Audio File', fieldType: 'audio_url',
        placeholder: '/media/menu.wav',
        hint: 'Played before digit collection starts. Takes priority over Prompt Text when both are set.',
      },
      {
        key: 'prompt_text', label: 'Prompt Text (TTS fallback)', fieldType: 'text',
        placeholder: 'Please enter your PIN followed by pound.',
        hint: 'Spoken when no Prompt Audio File is configured.',
      },
      {
        key: 'branches', label: 'Branches (digit / key → target node)', fieldType: 'branches_map',
        hint: 'Map digit sequences to target nodes. Use _default to catch any input not listed. Use timeout for no-input timeout. Use invalid for inputs that fall through all branches.',
        required: true,
      },
    ],
    luaHandler: `
local function exec_gather(s, node)
  local br      = node.branches or {}
  local min_d   = node.min_digits          or 1
  local max_d   = node.max_digits          or 1
  local timeout = (node.timeout_seconds    or 10) * 1000
  -- inter_digit_timeout: seconds between digits (0 = FreeSWITCH built-in default).
  -- Converted to ms for playAndGetDigits's 10th argument.
  local idt     = (node.inter_digit_timeout or 2) * 1000
  -- Empty string means "no terminator" — collection ends at max_digits or timeout.
  local terms   = node.terminators or ""
  local digits  = ""

  local pf = resolve_audio(node.prompt_audio_url)
  if pf then
    -- playAndGetDigits(min, max, tries, timeout, terminators, file, invalid_file, regexp, var, inter_digit_timeout)
    -- FreeSWITCH re-prompts up to 3 times until min_digits are collected.
    digits = s:playAndGetDigits(min_d, max_d, 3, timeout, terms, pf, "", "[0-9#*]+", "", idt) or ""
  else
    -- TTS path: manual retry loop enforces min_d (getDigits has no min parameter).
    -- Up to 3 attempts; breaks immediately on timeout (empty string from getDigits).
    local tries = 3
    while tries > 0 and s:ready() do
      local pt = interp(s, node.prompt_text)
      if pt ~= "" then speak(s, pt) end
      local d = s:getDigits(max_d, terms, timeout) or ""
      if d == "" then break end   -- timeout → no point re-prompting
      if #d >= min_d then digits = d; break end
      tries = tries - 1
      if tries > 0 then speak(s, "Please enter at least " .. tostring(min_d) .. " digit" .. (min_d > 1 and "s" or "") .. ".") end
    end
  end

  s:setVariable(node.variable_name or "gather_result", digits)

  -- Explicit timeout route: empty string means no input was received.
  -- Falls through to _default when no timeout branch is wired.
  if digits == "" then
    return br["timeout"] or br["_default"]
  end
  -- Input received: match exact branch, then _default (catch-all), then invalid.
  return br[digits] or br["_default"] or br["invalid"]
end`,
    apiEndpoint: null,
  },

  {
    type: 'condition',
    label: 'Condition',
    icon: '⑂',
    bg: '#2a2a1e', border: '#6a6a2a', color: '#fde68a',
    category: 'Input',
    description: 'Branch on variable value',
    ports: 'true_false',
    summaryTemplate: '${variable} ${operator} ${expected_value}',
    configSchema: [
      { key: 'variable', label: 'Variable to check', fieldType: 'mono_text', required: true, placeholder: 'gather_result', hint: 'Session variable name (e.g. gather_result)' },
      {
        key: 'operator', label: 'Operator', fieldType: 'select', required: true,
        options: [
          { value: '==',          label: '== equals (string)' },
          { value: '!=',          label: '!= not equals (string)' },
          { value: 'contains',    label: 'contains (substring)' },
          { value: 'starts_with', label: 'starts with' },
          { value: 'ends_with',   label: 'ends with' },
          { value: 'exists',      label: 'exists (variable is set and non-empty)' },
          { value: 'not_exists',  label: 'does not exist (variable is empty or unset)' },
          { value: 'gt',          label: '> greater than (numeric)' },
          { value: 'gte',         label: '>= greater than or equal (numeric)' },
          { value: 'lt',          label: '< less than (numeric)' },
          { value: 'lte',         label: '<= less than or equal (numeric)' },
          { value: 'ens_pin_valid',      label: 'ENS PIN valid (lookup + validate)' },
          { value: 'ens_callback_valid', label: 'ENS callback valid (recording replay)' },
          { value: 'time_of_day',        label: 'Time of day (HHMM range)' },
          { value: 'day_of_week',        label: 'Day of week (0=Sun…6=Sat)' },
        ],
        hint: 'String operators compare as text. Numeric operators (gt/gte/lt/lte) parse both sides as numbers. "exists" and "not_exists" ignore the Expected Value field.',
      },
      {
        key: 'expected_value', label: 'Expected value', fieldType: 'mono_text', required: true,
        placeholder: 'expected value',
        hint: 'Static value or ${var_name} interpolation. Not used by exists/not_exists. For time_of_day: "HHMM-HHMM" (e.g. 0900-1700). For day_of_week: comma-separated numbers (e.g. 1,2,3,4,5 for Mon–Fri).',
        conditionalOn: {
          field: 'operator', value: 'ens_pin_valid',
          label: 'ENS access number',
          hint: 'The ENS emergency number to look up PIN against. Use ${var} to read from session.',
          placeholder: '${destination_number}',
          infoBox: 'On PIN match: auto-stores ens_configuration_id and ens_blast_clid as session variables for downstream ENS node.',
        },
      },
      { key: 'true_node', label: 'True → Node', fieldType: 'node_ref', required: true, hint: 'Route here when condition is met' },
      { key: 'false_node', label: 'False → Node', fieldType: 'node_ref', required: true, hint: 'Route here when condition fails' },
    ],
    luaHandler: `
local function exec_condition(s, node)
  local op  = node.operator or "=="
  local val = s:getVariable(node.variable or "") or ""
  local exp = interp(s, node.expected_value) or ""
  local ok  = false

  if     op == "==" then
    ok = (val == exp)
  elseif op == "!=" then
    ok = (val ~= exp)
  elseif op == "contains" then
    ok = (val:find(exp, 1, true) ~= nil)
  elseif op == "starts_with" then
    ok = (val:sub(1, #exp) == exp)
  elseif op == "ends_with" then
    ok = #val >= #exp and val:sub(-#exp) == exp
  elseif op == "exists" then
    -- true when the variable is set to a non-empty string
    ok = (val ~= "")
  elseif op == "not_exists" then
    ok = (val == "")
  elseif op == "gt" then
    local n, e = tonumber(val), tonumber(exp)
    ok = (n ~= nil and e ~= nil and n > e)
  elseif op == "gte" then
    local n, e = tonumber(val), tonumber(exp)
    ok = (n ~= nil and e ~= nil and n >= e)
  elseif op == "lt" then
    local n, e = tonumber(val), tonumber(exp)
    ok = (n ~= nil and e ~= nil and n < e)
  elseif op == "lte" then
    local n, e = tonumber(val), tonumber(exp)
    ok = (n ~= nil and e ~= nil and n <= e)
  elseif op == "ens_pin_valid" then
    -- PIN check goes through /ens/verify-pin ONLY — it is the single
    -- source of truth for pin_required + correctness (handles "no PIN
    -- configured -> always authorized" internally). /ens/lookup never
    -- reads a pin query param at all; the raw PIN is never echoed back
    -- by lookup, matching the documented contract in CLAUDE.md.
    local dest = exp ~= "" and exp or s:getVariable("destination_number") or ""
    local verify = post("/ens/verify-pin", { trigger_number = dest, pin = val })
    if verify and verify.authorized then
      local lookup = get("/ens/lookup?number=" .. url_encode(dest))
      if lookup and lookup.success and lookup.data then
        s:setVariable("ens_configuration_id", tostring(lookup.data.configuration_id))
        s:setVariable("ens_blast_clid",       lookup.data.blast_clid or "")
      end
      ok = true
    end
  elseif op == "time_of_day" then
    -- expected_value format: "HHMM-HHMM" e.g. "0900-1700"
    local now_hhmm = tonumber(os.date("%H%M")) or 0
    local s_part, e_part = exp:match("^(%d%d%d%d)-(%d%d%d%d)$")
    if s_part and e_part then
      local start_n = tonumber(s_part) or 0
      local end_n   = tonumber(e_part) or 2359
      if start_n <= end_n then
        ok = (now_hhmm >= start_n and now_hhmm < end_n)
      else
        -- overnight range e.g. 2200-0600
        ok = (now_hhmm >= start_n or now_hhmm < end_n)
      end
    end
  elseif op == "day_of_week" then
    -- expected_value: comma-separated day numbers 0=Sun … 6=Sat
    local today = tonumber(os.date("%w")) or -1
    for d in exp:gmatch("%d+") do
      if tonumber(d) == today then ok = true; break end
    end
  elseif op == "ens_callback_valid" then
    -- expected_value carries the reply_clid the caller dialed in on —
    -- matches GET /ens/callbacks/authorize?reply_clid=&caller= exactly.
    local reply_clid = exp ~= "" and exp or ""
    local caller = s:getVariable("caller_id_number") or ""
    local d = get("/ens/callbacks/authorize?reply_clid=" .. url_encode(reply_clid) .. "&caller=" .. url_encode(caller))
    if d and d.authorized then
      s:setVariable("ens_notification_uuid", d.notification_uuid or "")
      s:setVariable("ens_recording_file",    d.recording_file or "")
      s:setVariable("ens_delivery_id",       tostring(d.delivery_id or ""))
      ok = true
    end
  end

  return ok and node.true_node or node.false_node
end`,
    apiEndpoint: null,
  },

  {
    type: 'goto',
    label: 'Go To Node',
    icon: '↩',
    bg: '#2a1e3b', border: '#5b3a8a', color: '#c4b5fd',
    category: 'Flow',
    description: 'Jump to another node',
    ports: 'goto_target',
    summaryTemplate: '→ ${target_node_id}',
    configSchema: [
      { key: 'target_node_id', label: 'Jump to Node', fieldType: 'node_ref', required: true, hint: 'The node this Go To routes to' },
    ],
    // "goto" is a reserved word since Lua 5.2 and cannot be used as a bare
    // table-constructor key — the generator wraps this with ["goto"] when
    // building the dispatch table (see luaGenerator.js), not here.
    luaHandler: `
local function exec_goto(s, node)  return node.target_node_id end`,
    apiEndpoint: null,
  },

  {
    type: 'ens',
    label: 'Trigger ENS',
    icon: '📢',
    bg: '#1e2f3b', border: '#2a6080', color: '#7dd3fc',
    category: 'Emergency',
    description: 'Trigger ENS blast',
    ports: 'next_optional',
    summaryTemplate: 'Config ${ens_configuration_id}',
    configSchema: [
      { key: 'ens_configuration_id', label: 'ENS Configuration', fieldType: 'ens_config_ref', hint: 'Leave blank if using ens_config_var' },
      { key: 'ens_config_var', label: 'ENS Config Variable', fieldType: 'mono_text', placeholder: 'ens_configuration_id', hint: 'Session var holding config ID (set by condition ens_pin_valid)' },
      { key: 'recording_file_var', label: 'Recording File Variable', fieldType: 'mono_text', placeholder: 'recorded_file_path', hint: 'Session var holding recorded file path (from record_message node)' },
      { key: 'next', label: 'Next Node (optional — after blast)', fieldType: 'node_ref', hint: 'Where to go after ENS fires' },
    ],
    luaHandler: `
local function exec_ens(s, node)
  local cfg_id = node.ens_configuration_id
  if not cfg_id or cfg_id == 0 then
    cfg_id = tonumber(s:getVariable(node.ens_config_var or "ens_configuration_id") or "")
  end
  if not cfg_id then
    freeswitch.consoleLog("ERR", "[ivr_executor] ens node: could not resolve configuration_id — skipping\\n")
    return node.next
  end

  local caller_number = s:getVariable("caller_id_number") or ""

  -- Default recording_file_var to "recorded_file_path" so a preceding
  -- record_message node's output is forwarded without explicit config.
  local rfvar = (node.recording_file_var and node.recording_file_var ~= "") and node.recording_file_var or "recorded_file_path"
  local recording_file = s:getVariable(rfvar) or ""
  if recording_file == "" then recording_file = nil end

  local d = post("/ens/campaign/start-by-config", {
    configuration_id = cfg_id,
    recording_file   = recording_file,
    caller_number    = caller_number ~= "" and caller_number or nil,
  })

  if d and d.success and d.campaign_id then
    s:setVariable("ens_notification_uuid", tostring(d.campaign_id))
    freeswitch.consoleLog("INFO",
      "[ivr_executor] ens node: campaign started id=" .. tostring(d.campaign_id) ..
      " destinations=" .. tostring(d.total_destinations or 0) .. "\\n")
  else
    freeswitch.consoleLog("ERR",
      "[ivr_executor] ens node: blast failed — " .. tostring(d and d.error or "no response") .. "\\n")
  end

  return node.next
end`,
    apiEndpoint: { method: 'POST', path: '/api/v1/internal/ens/campaign/start-by-config' },
  },

  {
    type: 'ers',
    label: 'Trigger ERS',
    icon: '🚨',
    bg: '#3b1e1e', border: '#8a2a2a', color: '#fca5a5',
    category: 'Emergency',
    description: 'Start ERS conference',
    ports: 'none',
    summaryTemplate: 'Config ${ers_configuration_id}',
    configSchema: [
      { key: 'ers_configuration_id', label: 'ERS Configuration', fieldType: 'ers_config_ref', required: true, hint: 'Pick from your ERS configurations — the internal ID is stored automatically' },
      { key: 'group_type', label: 'Responder Tier', fieldType: 'select', options: [{ value: 'primary', label: 'Primary' }, { value: 'secondary', label: 'Secondary' }] },
    ],
    luaHandler: `
local function exec_ers(s, node)
  local cfg_id = node.ers_configuration_id
  if not cfg_id or cfg_id == 0 then
    cfg_id = tonumber(s:getVariable(node.ers_config_var or "ers_configuration_id") or "")
  end
  if not cfg_id then
    freeswitch.consoleLog("ERR", "[ivr_executor] ers node: could not resolve configuration_id — hanging up\\n")
    return nil
  end

  -- The API never echoes conference_room back — it is generated here and
  -- reused directly to bridge, matching the constraint the internal API
  -- enforces on the value it is given: ^[a-z0-9_]{1,64}$
  local room = "ers_" .. tostring(cfg_id) .. "_" .. tostring(os.time())

  local d = post("/ers/incidents", {
    configuration_id = cfg_id,
    caller_number    = s:getVariable("caller_id_number") or "",
    conference_room  = room,
    group_type       = node.group_type or "primary",
  })

  if d and d.incident_uuid then
    s:setVariable("ers_incident_uuid", d.incident_uuid)
    s:execute("conference", room .. "@default")
    -- s:execute("conference", ...) blocks until THIS leg leaves the
    -- room. Reuse the already-built /ers/incidents/:uuid/complete
    -- endpoint (handles ers_queues promotion too — do not rebuild that
    -- here) so the incident row stops showing as permanently ACTIVE.
    -- NOTE: this marks "this leg left," not "the room is empty" — a
    -- room with other members still bridged stays live in FreeSWITCH
    -- regardless of this incident row's status; live occupancy must
    -- always be checked via ESL conference member count, never this
    -- status field alone.
    post("/ers/incidents/" .. d.incident_uuid .. "/complete", {
      recording_file = s:getVariable("recorded_file_path") or nil,
    })
  else
    freeswitch.consoleLog("ERR", "[ivr_executor] ers node: incident creation failed — " .. tostring(d and d.error or "no response") .. "\\n")
  end
  return nil
end`,
    apiEndpoint: { method: 'POST', path: '/api/v1/internal/ers/incidents' },
  },

  {
    type: 'hangup',
    label: 'Hangup',
    icon: '✕',
    bg: '#1e2a1e', border: '#2a4a2a', color: '#86efac',
    category: 'Flow',
    description: 'End the call',
    ports: 'none',
    configSchema: [
      { key: 'play_audio_url', label: 'Goodbye Audio URL (optional)', fieldType: 'audio_url', placeholder: '/media/goodbye.wav' },
    ],
    luaHandler: `
local function exec_hangup(s, node)
  local f = resolve_audio(node.play_audio_url)
  if f then s:streamFile(f) end
  s:hangup()
  return nil
end`,
    apiEndpoint: null,
  },

  {
    type: 'record_message',
    label: 'Record',
    icon: '⏺',
    bg: '#2a1e2a', border: '#6a2a6a', color: '#e9d5ff',
    category: 'Recording',
    description: 'Record caller audio. Stops on silence or # key. Stores the file path in a session variable for downstream ENS or playback nodes.',
    ports: 'next',
    summaryTemplate: '→ ${variable_name} · max ${max_seconds}s',
    configSchema: [
      { key: 'variable_name', label: 'Variable name', fieldType: 'mono_text', required: true, placeholder: 'recorded_file_path', hint: 'Session variable that stores the recorded file path — read by downstream ENS node' },
      { key: 'prompt_audio_url', label: 'Prompt audio file', fieldType: 'audio_url', placeholder: '/media/record_after_tone.wav', hint: 'Played before recording starts. Takes priority over prompt text.' },
      { key: 'prompt_text', label: 'Prompt text (TTS fallback)', fieldType: 'textarea', placeholder: 'Please record your message after the tone. Press pound when done.', hint: 'Spoken when no prompt audio file is configured' },
      {
        key: 'max_seconds', label: 'Maximum Duration (seconds)', fieldType: 'number', min: 1, max: 300,
        hint: 'Recording stops automatically after this many seconds even if the caller has not pressed the stop key.',
      },
      {
        key: 'dtmf_stop_key', label: 'DTMF Stop Key', fieldType: 'select',
        options: [
          { value: '#', label: '# (pound) — recommended' },
          { value: '*', label: '* (star)' },
          { value: '',  label: 'None — duration / silence only' },
        ],
        hint: 'Key the caller presses to immediately stop the recording. Recommended: # (pound). The maximum duration is always enforced regardless of this setting.',
      },
      {
        key: 'silence_threshold', label: 'Silence threshold (ms)', fieldType: 'number', min: 10, max: 2000,
        hint: 'Energy level below which audio is considered silence. Default 500 works for most telephony. Raise for noisy environments.',
      },
      {
        key: 'silence_hits', label: 'Silence hits', fieldType: 'number', min: 1, max: 500,
        hint: 'Consecutive silent frames (20 ms each) required before auto-stop. Default 20 ≈ 400 ms of silence after speech ends. Raise for callers with slow delivery; lower for quick turnaround.',
      },
      { key: 'next', label: 'Next Node', fieldType: 'node_ref', required: true, hint: 'Node to proceed to after a successful recording. Variable Output below is available to this node and all downstream nodes.' },
    ],
    luaHandler: `
local function exec_record_message(s, node)
  freeswitch.consoleLog("INFO", "[ivr_executor] record_message: started\\n")

  -- Resolve recordings directory from FreeSWITCH runtime (never hardcode paths)
  -- recordings_dir is always set by FreeSWITCH's built-in default_vars.conf.xml
  local rec_base = _api:execute("global_getvar", "recordings_dir")
  if not rec_base or rec_base == "" then
    rec_base = "/var/lib/freeswitch/recordings"
  end
  local rec_dir = rec_base .. "/ivr"
  freeswitch.consoleLog("DEBUG", "[ivr_executor] record_message: rec_dir=" .. rec_dir .. "\\n")

  -- Auto-create IVR recording directory (deploymentEngine creates at deploy time;
  -- this handles fresh installs or directory removal without redeployment)
  os.execute("mkdir -p '" .. rec_dir .. "'")

  -- Unique filename: ivr_<call-uuid>_<unix-timestamp>.wav (no collisions)
  local call_uuid = s:getVariable("uuid") or "unknown"
  local fpath = rec_dir .. "/ivr_" .. call_uuid .. "_" .. os.time() .. ".wav"
  freeswitch.consoleLog("INFO", "[ivr_executor] record_message: path=" .. fpath .. "\\n")

  -- Play prompt before recording (audio file takes priority; TTS spoken as fallback)
  local pf = resolve_audio(node.prompt_audio_url)
  if pf and pf ~= "" then
    freeswitch.consoleLog("INFO", "[ivr_executor] record_message: playing prompt file\\n")
    s:streamFile(pf)
  elseif node.prompt_text and node.prompt_text ~= "" then
    freeswitch.consoleLog("INFO", "[ivr_executor] record_message: speaking prompt (TTS)\\n")
    speak(s, interp(s, node.prompt_text))
  end

  -- Abort if caller disconnected during prompt playback
  if not s:ready() then
    freeswitch.consoleLog("WARN", "[ivr_executor] record_message: caller disconnected before recording\\n")
    return nil
  end

  -- Play beep — always, gives caller a clear start signal
  s:execute("playback", "tone_stream://%(500,0,640)")
  s:sleep(100)

  -- Record audio — stops when caller presses the stop key, silence is detected,
  -- or max_sec is reached. dtmf_stop_key defaults to "#"; empty string = no DTMF stop.
  -- Empty string is truthy in Lua, so we must compare to nil to detect "not set".
  local max_sec  = node.max_seconds       or 60
  local sil_thr  = node.silence_threshold or 500
  -- silence_hits: consecutive 20 ms frames that must be silent before auto-stop.
  -- Default 20 ≈ 400 ms of silence after speech ends (old default of 3 = 60 ms was too short).
  local sil_hits = node.silence_hits      or 20
  local stop_key = (node.dtmf_stop_key ~= nil) and node.dtmf_stop_key or "#"

  -- Belt-and-suspenders DTMF detection: register a session-level input callback
  -- BEFORE execute("record") so that DTMF delivered as SIP INFO — which the record
  -- app's internal terminator handler may not intercept on all FreeSWITCH builds —
  -- still breaks the recording via the Lua callback returning "break".
  -- The record app's own terminator arg (5th positional) is kept as an additional layer.
  local dtmf_stopped = false
  if stop_key ~= "" then
    s:setInputCallback(function(_sess, itype, obj, _arg)
      if itype == "dtmf" then
        local d = obj and obj["digit"] or ""
        if d == stop_key then
          dtmf_stopped = true
          return "break"
        end
      end
      return ""
    end, "")
  end

  freeswitch.consoleLog("INFO",
    "[ivr_executor] record_message: recording max_sec=" .. max_sec ..
    " sil_thr=" .. sil_thr .. " sil_hits=" .. sil_hits ..
    " stop_key='" .. stop_key .. "'\\n")

  -- Both the record app terminator (5th arg) AND the session callback above are active.
  s:execute("record", fpath .. " " .. max_sec .. " " .. sil_thr .. " " .. sil_hits ..
    (stop_key ~= "" and (" " .. stop_key) or ""))

  -- Clear session callback immediately so downstream nodes are not affected.
  if stop_key ~= "" then
    s:setInputCallback("none")
  end

  if dtmf_stopped then
    freeswitch.consoleLog("INFO",
      "[ivr_executor] record_message: stopped by DTMF '" .. stop_key .. "' (session callback)\\n")
  else
    freeswitch.consoleLog("INFO",
      "[ivr_executor] record_message: stopped by silence or max duration\\n")
  end
  s:sleep(200)

  -- Handle caller hangup during recording
  if not s:ready() then
    freeswitch.consoleLog("WARN", "[ivr_executor] record_message: caller disconnected during recording\\n")
    return nil
  end

  -- Verify recording has meaningful audio content (guards against silence-only captures)
  local rec_size = 0
  local fh = io.open(fpath, "rb")
  if fh then
    rec_size = fh:seek("end") or 0
    fh:close()
  end
  freeswitch.consoleLog("INFO",
    "[ivr_executor] record_message: file=" .. fpath .. " bytes=" .. rec_size .. "\\n")

  if rec_size < 2000 then
    freeswitch.consoleLog("ERR",
      "[ivr_executor] record_message: recording too short or empty (bytes=" .. rec_size ..
      ") — not proceeding to next node\\n")
    speak(s, "We could not capture your recording. Please try again.")
    return nil
  end

  -- Store file path in session variable — downstream ENS node reads this
  local var_name = node.variable_name or "recorded_file_path"
  s:setVariable(var_name, fpath)
  freeswitch.consoleLog("INFO",
    "[ivr_executor] record_message: stored " .. var_name .. "=" .. fpath .. "\\n")

  freeswitch.consoleLog("INFO", "[ivr_executor] record_message: completed, proceeding to next node\\n")
  return node.next
end`,
    apiEndpoint: null,
  },

  {
    type: 'set_variable',
    label: 'Set Variable',
    icon: '📌',
    bg: '#1e2a3b', border: '#2a4a6a', color: '#bae6fd',
    category: 'Recording',
    description: 'Set session variable',
    ports: 'next',
    summaryTemplate: '${variable} = ${value}',
    configSchema: [
      { key: 'variable', label: 'Variable name', fieldType: 'mono_text', required: true, placeholder: 'my_variable', hint: 'FreeSWITCH channel variable to set' },
      { key: 'value', label: 'Value', fieldType: 'mono_text', required: true, placeholder: '${destination_number}', hint: 'Static text or ${other_var} interpolation' },
      { key: 'next', label: 'Next Node', fieldType: 'node_ref', required: true, hint: 'Node to proceed to after setting variable' },
    ],
    luaHandler: `
local function exec_set_variable(s, node)
  s:setVariable(node.variable or "unknown_var", interp(s, node.value) or "")
  return node.next
end`,
    apiEndpoint: null,
  },

  {
    type: 'transfer',
    label: 'Transfer',
    icon: '↗',
    bg: '#1e3b2a', border: '#2a6a4a', color: '#a7f3d0',
    category: 'Flow',
    description: 'Transfer call to extension',
    ports: 'none',
    footnote: 'Transfer hands off call control. No next node — the transferred dialplan takes over.',
    summaryTemplate: '→ ${destination}',
    configSchema: [
      { key: 'destination', label: 'Destination', fieldType: 'mono_text', required: true, placeholder: '1001', hint: 'Extension number, or ${var} for dynamic destination' },
      { key: 'dialplan', label: 'Dialplan', fieldType: 'select', options: [{ value: 'XML', label: 'XML (default)' }, { value: 'inline', label: 'inline' }, { value: 'enum', label: 'enum' }] },
      { key: 'context', label: 'Context', fieldType: 'mono_text', placeholder: 'default' },
    ],
    luaHandler: `
local function exec_transfer(s, node)
  local dest = interp(s, node.destination) or ""
  s:execute("transfer",
    dest .. " " .. (node.dialplan or "XML") .. " " .. (node.context or "default"))
  return nil
end`,
    apiEndpoint: null,
  },

  // ── Proof node type (docs/EXTENDING_NODE_TYPES.md walkthrough) ─────────────
  // Added purely through this registry entry — zero edits to
  // luaGenerator.js's generation loop or NodePalette.jsx's rendering logic.
  // (ivrValidator.js's AnyNodeSchema union DOES need one added entry so
  // saved graphs containing this node pass validation — the registry is
  // not yet the source of truth for validation, see the header comment.)
  {
    type: 'webhook',
    label: 'Webhook',
    icon: '🪝',
    bg: '#1e1e3b', border: '#4a4a8a', color: '#c7c7fa',
    category: 'Integrations',
    description: 'POST JSON to an external URL',
    ports: 'next',
    summaryTemplate: '${url}',
    configSchema: [
      { key: 'url', label: 'Webhook URL', fieldType: 'mono_text', required: true, placeholder: 'https://example.com/hooks/emergency' },
      { key: 'body_template', label: 'Body (JSON, supports ${var})', fieldType: 'textarea', placeholder: '{"caller": "${caller_id_number}"}' },
      { key: 'next', label: 'Next Node', fieldType: 'node_ref', required: true, hint: 'Node to go to after the webhook fires (fire-and-forget — does not wait for a meaningful response)' },
    ],
    luaHandler: `
local function exec_webhook(s, node)
  local url = interp(s, node.url) or ""
  if url == "" then
    freeswitch.consoleLog("ERR", "[ivr_executor] webhook node: empty url — skipping\\n")
    return node.next
  end
  -- Fire-and-forget to an arbitrary external URL — deliberately NOT routed
  -- through API_BASE/API_KEY (those are for this app's own internal API
  -- only). Same curl-via-io.popen pattern as every other HTTP call in this
  -- file, just without the internal auth header.
  local body = interp(s, node.body_template) or "{}"
  local safe_body = body:gsub("'", "'\\\\''")
  local cmd = string.format(
    "curl -s -m %d -X POST -H 'Content-Type: application/json' -d '%s' '%s' 2>/dev/null",
    HTTP_TIMEOUT, safe_body, url)
  local h = io.popen(cmd)
  if h then h:close() end
  return node.next
end`,
    apiEndpoint: null,
  },

  // ═══════════════════════════════════════════════════════════════════════════
  // Phase 5 — 3-scenario emergency flow node types.
  // Connection fields deliberately reuse the existing ref names (branches /
  // next / true_node / false_node) so the graph validator's refsOf(), the
  // canvas port strategies, and edge derivation all work with zero changes.
  // ═══════════════════════════════════════════════════════════════════════════

  {
    type: 'ers_ring_all',
    label: 'ERS Ring-All',
    icon: '📟',
    bg: '#3b1e2a', border: '#8a2a4a', color: '#fda4af',
    category: 'Emergency',
    description: 'Ring every tier responder simultaneously into one conference',
    ports: 'none',
    footnote: 'Rings all tier responders in parallel (continuous re-ring until any leg answers, recording on first join, caller identity shown on every phone). If the tier already has a live-occupied room, the caller bridges straight into it instead (rejoin). Call control ends here.',
    summaryTemplate: 'Config ${ers_configuration_id} · ${tier}',
    configSchema: [
      { key: 'ers_configuration_id', label: 'ERS Configuration', fieldType: 'ers_config_ref', required: true, hint: 'Pick from your ERS configurations — the internal ID is stored automatically' },
      { key: 'tier', label: 'Responder Tier', fieldType: 'select', required: true, options: [{ value: 'primary', label: 'Level 1 (Primary)' }, { value: 'secondary', label: 'Level 2 (Secondary)' }] },
      { key: 'ring_timeout_seconds', label: 'Ring timeout (seconds)', fieldType: 'number', min: 10, max: 7200, hint: 'Stop re-ringing after this many seconds with no answer. Leave blank for no limit (2h safety cap applies).' },
    ],
    luaHandler: `
local function exec_ers_ring_all(s, node)
  local cfg_id = node.ers_configuration_id
  if not cfg_id then
    freeswitch.consoleLog("ERR", "[ivr_executor] ers_ring_all: missing ers_configuration_id — hanging up\\n")
    speak(s, "This emergency service is not configured. Please call emergency services directly.")
    s:hangup("NORMAL_CLEARING")
    return nil
  end

  local d = post("/ers/ring-all", {
    configuration_id = cfg_id,
    tier             = node.tier or "primary",
    caller_number    = s:getVariable("caller_id_number") or "",
    caller_name      = s:getVariable("caller_id_name") or nil,
    emergency_number = s:getVariable("destination_number") or nil,
  })

  -- d.success == false means the backend rejected the request (e.g. no
  -- responders configured). Never fail silently — log ERR with the reason
  -- and play an audible fallback so the caller is not left in silence.
  if not d or not d.success then
    local reason = (d and d.reason) or "no_response"
    local err_detail = (d and d.error) or "no response from backend"
    freeswitch.consoleLog("ERR",
      "[ivr_executor] ers_ring_all: ring-all failed — reason=" .. reason ..
      " detail=" .. err_detail .. "\\n")
    if reason == "no_responders" then
      speak(s, "No emergency responders are currently configured for this service. Please call emergency services directly.")
    else
      speak(s, "The emergency response service is currently unavailable. Please call emergency services directly.")
    end
    s:hangup("NORMAL_CLEARING")
    return nil
  end

  if d.conference_room then
    s:setVariable("ers_incident_uuid", d.incident_uuid or "")
    -- Blocks until THIS leg leaves. The backend ring loop keeps re-ringing
    -- responders in parallel the whole time the caller waits in the room.
    s:execute("conference", d.conference_room .. "@default")
    if d.incident_uuid then
      post("/ers/incidents/" .. d.incident_uuid .. "/complete", {})
    end
  end
  return nil
end`,
    apiEndpoint: { method: 'POST', path: '/api/v1/internal/ers/ring-all' },
  },

  {
    type: 'ers_overflow_check',
    label: 'ERS Overflow Check',
    icon: '🚦',
    bg: '#2a2a3b', border: '#4a4a8a', color: '#c7d2fe',
    category: 'Emergency',
    description: 'Route by LIVE tier occupancy: Level 1 → Level 2 → queue',
    ports: 'branches',
    footnote: 'Occupancy is judged by the LIVE conference member count via FreeSWITCH, never the incident status column — a room with members is occupied even if its DB row was marked completed, and vice versa. Branch keys: primary (Level 1 free), secondary (Level 2 free), full (both occupied).',
    summaryTemplate: 'Config ${ers_configuration_id}',
    configSchema: [
      { key: 'ers_configuration_id', label: 'ERS Configuration', fieldType: 'ers_config_ref', required: true, hint: 'Pick from your ERS configurations — the internal ID is stored automatically' },
      { key: 'branches', label: 'Routes (primary / secondary / full)', fieldType: 'branches_map', required: true, hint: 'primary: Level 1 free · secondary: Level 2 free · full: both occupied' },
    ],
    luaHandler: `
local function exec_ers_overflow_check(s, node)
  local br = node.branches or {}
  local d = get("/ers/tier-status?configuration_id=" .. tostring(node.ers_configuration_id or 0))
  if not d or not d.success then
    freeswitch.consoleLog("ERR", "[ivr_executor] ers_overflow_check: tier-status failed — routing to full branch\\n")
    return br["full"]
  end
  if d.primary and not d.primary.occupied then
    return br["primary"]
  elseif d.secondary and not d.secondary.occupied then
    return br["secondary"]
  end
  return br["full"]
end`,
    apiEndpoint: { method: 'GET', path: '/api/v1/internal/ers/tier-status' },
  },

  {
    type: 'ers_overflow_wait',
    label: 'ERS Overflow Wait',
    icon: '⏳',
    bg: '#3b331e', border: '#8a742a', color: '#fde68a',
    category: 'Emergency',
    description: 'Hold in queue until a tier frees up (Level 1 priority)',
    ports: 'next',
    footnote: 'Plays the hold announcement, enqueues the caller, and polls tier occupancy (live member count). When a tier frees, the caller auto-connects with Level 1 priority. The Next Node is the FALLBACK when the wait cap is hit or the queue entry is cancelled.',
    summaryTemplate: 'Wait ${max_wait_seconds}s · Config ${ers_configuration_id}',
    configSchema: [
      { key: 'ers_configuration_id', label: 'ERS Configuration', fieldType: 'ers_config_ref', required: true, hint: 'Pick from your ERS configurations — the internal ID is stored automatically' },
      { key: 'hold_prompt_text', label: 'Hold announcement (TTS)', fieldType: 'textarea', placeholder: 'All emergency responders are currently engaged. Please remain on the line.' },
      { key: 'hold_audio_url', label: 'Hold audio URL (overrides TTS)', fieldType: 'audio_url', placeholder: '/media/hold.wav' },
      { key: 'max_wait_seconds', label: 'Max wait (seconds)', fieldType: 'number', min: 10, max: 3600, hint: 'After this, routes to the fallback Next Node' },
      { key: 'next', label: 'Fallback Node (wait cap / cancelled)', fieldType: 'node_ref', required: true },
    ],
    luaHandler: `
local function exec_ers_overflow_wait(s, node)
  local enq = post("/ers/overflow/enqueue", {
    configuration_id   = node.ers_configuration_id or 0,
    caller_number      = s:getVariable("caller_id_number") or "",
    caller_name        = s:getVariable("caller_id_name") or nil,
    destination_number = s:getVariable("destination_number") or nil,
  })
  if not enq or not enq.queue_id then
    freeswitch.consoleLog("ERR", "[ivr_executor] ers_overflow_wait: enqueue failed — falling back\\n")
    return node.next
  end

  local hold_file = resolve_audio(node.hold_audio_url)
  local hold_text = interp(s, node.hold_prompt_text)
  if hold_file then s:streamFile(hold_file)
  elseif hold_text ~= "" then speak(s, hold_text) end

  local max_wait = node.max_wait_seconds or 300
  local deadline = os.time() + max_wait

  while s:ready() and os.time() < deadline do
    local d = get("/ers/overflow/poll?queue_id=" .. tostring(enq.queue_id))
    if d and d.ready and d.conference_room then
      s:execute("conference", d.conference_room .. "@default")
      if d.incident_uuid then
        post("/ers/incidents/" .. d.incident_uuid .. "/complete", {})
      end
      return nil
    end
    if d and d.cancelled then return node.next end
    -- brief hold-tone loop between polls
    s:execute("playback", "silence_stream://3000")
  end

  return node.next
end`,
    apiEndpoint: { method: 'POST', path: '/api/v1/internal/ers/overflow/enqueue' },
  },

  {
    type: 'ens_blast_record',
    label: 'ENS Blast (PIN + Record)',
    icon: '📣',
    bg: '#1e333b', border: '#2a6a8a', color: '#93e3fd',
    category: 'Emergency',
    description: 'PIN-gate, record a message, broadcast to all contacts',
    ports: 'next',
    footnote: 'Full blast trigger in one node: collects and verifies the PIN (3 attempts), records the initiator\'s message, and broadcasts to every contact\'s extension AND mobile number. Next Node runs after the blast is confirmed started.',
    summaryTemplate: 'Config ${ens_configuration_id}',
    configSchema: [
      { key: 'ens_configuration_id', label: 'ENS Configuration', fieldType: 'ens_config_ref', hint: 'Leave blank to resolve from the dialed number' },
      { key: 'pin_prompt_text', label: 'PIN prompt (TTS)', fieldType: 'textarea', placeholder: 'Please enter your authorization PIN followed by pound.' },
      { key: 'record_prompt_text', label: 'Record prompt (TTS)', fieldType: 'textarea', placeholder: 'Record your emergency message after the tone. Press pound when finished.' },
      { key: 'max_record_seconds', label: 'Max recording (seconds)', fieldType: 'number', min: 5, max: 300, hint: 'Recording also stops immediately when the caller presses # or silence is detected.' },
      { key: 'silence_threshold', label: 'Silence threshold (ms)', fieldType: 'number', min: 10, max: 2000, hint: 'Energy below which audio is considered silence. Default 500.' },
      { key: 'silence_hits', label: 'Silence hits', fieldType: 'number', min: 1, max: 10, hint: 'Consecutive silence chunks required to auto-stop. Default 3.' },
      { key: 'next', label: 'Next Node (after blast starts)', fieldType: 'node_ref', required: true },
    ],
    luaHandler: `
local function exec_ens_blast_record(s, node)
  local dest = s:getVariable("destination_number") or ""

  -- PIN gate — /ens/verify-pin is the single source of truth (handles the
  -- "no PIN configured -> always authorized" case internally).
  local authorized = false
  for attempt = 1, 3 do
    local prompt = interp(s, node.pin_prompt_text)
    if prompt == "" then prompt = "Please enter your authorization PIN followed by pound." end
    speak(s, prompt)
    local pin = s:getDigits(8, "#", 10000)
    local verify = post("/ens/verify-pin", { trigger_number = dest, pin = pin or "" })
    if verify and verify.authorized then
      authorized = true
      break
    end
    speak(s, "Invalid PIN.")
  end
  if not authorized then
    speak(s, "Maximum authorization attempts exceeded. Goodbye.")
    s:hangup("CALL_REJECTED")
    return nil
  end

  -- Resolve configuration_id (node value, else lookup by dialed number)
  local cfg_id = node.ens_configuration_id
  if not cfg_id then
    local lookup = get("/ens/lookup?number=" .. url_encode(dest))
    if lookup and lookup.success and lookup.data then
      cfg_id = lookup.data.configuration_id
    end
  end
  if not cfg_id then
    freeswitch.consoleLog("ERR", "[ivr_executor] ens_blast_record: could not resolve configuration_id\\n")
    speak(s, "This notification service is not configured. Goodbye.")
    return nil
  end

  -- Record the initiator's message.
  -- execute("record") is used, not the Lua session recording API, because only the
  -- application variant supports a DTMF stop key (5th positional argument).
  -- The session API always runs until duration/silence regardless of keys pressed.
  local rec_dir = _api:execute("global_getvar", "recordings_dir") or "/var/lib/freeswitch/recordings"
  local fpath = rec_dir .. "/ens/ens_" .. tostring(cfg_id) .. "_" .. os.time() .. ".wav"
  os.execute("mkdir -p '" .. rec_dir .. "/ens'")
  local rprompt = interp(s, node.record_prompt_text)
  if rprompt == "" then rprompt = "Record your emergency message after the tone. Press pound when finished." end
  speak(s, rprompt)
  s:execute("playback", "tone_stream://%(500,0,640)")
  local max_rec  = node.max_record_seconds or 120
  local sil_thr  = node.silence_threshold  or 500
  local sil_hits = node.silence_hits        or 3
  s:execute("record", fpath .. " " .. max_rec .. " " .. sil_thr .. " " .. sil_hits .. " #")

  -- Broadcast — reaches every contact's extension AND mobile (see
  -- resolveEnsContacts in ensInternalController.js).
  local d = post("/ens/notifications", {
    configuration_id = cfg_id,
    triggered_via    = "PHONE",
    caller_number    = s:getVariable("caller_id_number") or nil,
    recording_file   = fpath,
  })

  if d and d.notification_uuid then
    s:setVariable("ens_notification_uuid", d.notification_uuid)
    speak(s, "Your emergency notification is now being sent to all contacts.")
  else
    freeswitch.consoleLog("ERR", "[ivr_executor] ens_blast_record: blast failed — " .. tostring(d and d.error or "no response") .. "\\n")
    speak(s, "There was a problem starting your notification. Please contact your administrator.")
  end

  return node.next
end`,
    apiEndpoint: { method: 'POST', path: '/api/v1/internal/ens/notifications' },
  },

  {
    type: 'ens_playback_gate',
    label: 'Playback Gate (Authorized)',
    icon: '🔐',
    bg: '#1e3b33', border: '#2a8a6a', color: '#99f6e4',
    category: 'Emergency',
    description: 'Authorized-caller check, then play the latest message',
    ports: 'true_false',
    footnote: 'Callers on the authorized list hear the latest recorded message if it is within the configured retention window (or "no active message" after expiry) and route to the True node; unauthorized callers are logged and route to the False node. Retention period is set in the ENS Configuration.',
    summaryTemplate: 'Config ${ers_configuration_id}',
    configSchema: [
      { key: 'ers_configuration_id', label: 'ERS Configuration', fieldType: 'ers_config_ref', required: true, hint: 'Pick from your ERS configurations — the internal ID is stored automatically' },
      { key: 'no_message_text', label: '"No active message" text (TTS)', fieldType: 'textarea', placeholder: 'There is no active emergency message at this time.' },
      { key: 'true_node', label: 'Authorized → Node', fieldType: 'node_ref', required: true },
      { key: 'false_node', label: 'Rejected → Node', fieldType: 'node_ref', required: true },
    ],
    luaHandler: `
local function exec_ens_playback_gate(s, node)
  local caller = s:getVariable("caller_id_number") or ""
  local d = get("/ers/playback/authorize?configuration_id=" .. tostring(node.ers_configuration_id or 0) ..
                "&caller=" .. url_encode(caller))

  if not d or not d.authorized then
    freeswitch.consoleLog("WARN", "[ivr_executor] ens_playback_gate: rejected caller " .. caller .. " (" .. tostring(d and d.reason or "no response") .. ")\\n")
    return node.false_node
  end

  if d.recording_file then
    s:streamFile(d.recording_file)
  else
    local msg = interp(s, node.no_message_text)
    if msg == "" then msg = "There is no active emergency message at this time." end
    speak(s, msg)
  end
  return node.true_node
end`,
    apiEndpoint: { method: 'GET', path: '/api/v1/internal/ers/playback/authorize' },
  },
];

export function getNodeType(type) {
  return NODE_TYPE_REGISTRY.find(n => n.type === type) || null;
}

// Public shape for the frontend — never leak Lua handler source over the API.
export function publicNodeTypes() {
  return NODE_TYPE_REGISTRY.map(({ type, label, icon, bg, border, color, category, description, ports, configSchema, footnote, summaryTemplate }) =>
    ({ type, label, icon, bg, border, color, category, description, ports, configSchema, footnote, summaryTemplate }));
}
