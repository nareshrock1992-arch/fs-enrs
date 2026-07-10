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
    description: 'Play an audio file',
    ports: 'next',
    configSchema: [
      { key: 'audio_url', label: 'Audio URL (local /media/ path)', fieldType: 'audio_url', placeholder: '/media/welcome.wav' },
      { key: 'audio_file_id', label: 'Audio File ID (alternative)', fieldType: 'number', min: 1 },
      { key: 'next', label: 'Next Node', fieldType: 'node_ref', required: true, hint: 'Node to go to after playing audio' },
    ],
    luaHandler: `
local function exec_play(s, node)
  local f = resolve_audio(node.audio_url)
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
    configSchema: [
      { key: 'variable_name', label: 'Variable Name', fieldType: 'mono_text', placeholder: 'gather_result', hint: 'Session variable that stores collected digits' },
      { key: 'max_digits', label: 'Max Digits', fieldType: 'number', min: 1, max: 11 },
      { key: 'timeout_seconds', label: 'Timeout (seconds)', fieldType: 'number', min: 1, max: 60 },
      { key: 'terminators', label: 'Terminators', fieldType: 'mono_text', placeholder: '#', hint: 'Keys that end collection (default #)' },
      { key: 'prompt_audio_url', label: 'Prompt Audio URL', fieldType: 'audio_url', placeholder: '/media/menu.wav' },
      { key: 'prompt_text', label: 'Prompt Text (TTS fallback)', fieldType: 'text', placeholder: 'Please enter your PIN' },
      { key: 'branches', label: 'Branches (key → target node)', fieldType: 'branches_map', hint: 'Use _default to catch any input not matched above', required: true },
    ],
    luaHandler: `
local function exec_gather(s, node)
  local br      = node.branches or {}
  local max_d   = node.max_digits      or 1
  local timeout = (node.timeout_seconds or 10) * 1000
  local terms   = node.terminators     or "#"
  local digits

  local pf = resolve_audio(node.prompt_audio_url)
  if pf then
    digits = s:playAndGetDigits(1, max_d, 3, timeout, terms, pf, "", "[0-9#*]+", "", 0)
  else
    local pt = interp(s, node.prompt_text)
    if pt ~= "" then speak(s, pt) end
    digits = s:getDigits(max_d, terms, timeout)
  end

  s:setVariable(node.variable_name or "gather_result", digits or "")
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
    configSchema: [
      { key: 'variable', label: 'Variable to check', fieldType: 'mono_text', required: true, placeholder: 'gather_result', hint: 'Session variable name (e.g. gather_result)' },
      {
        key: 'operator', label: 'Operator', fieldType: 'select', required: true,
        options: [
          { value: '==',                 label: '== equals' },
          { value: '!=',                 label: '!= not equals' },
          { value: 'contains',           label: 'contains' },
          { value: 'starts_with',        label: 'starts_with' },
          { value: 'ens_pin_valid',      label: 'ENS PIN valid (lookup + validate)' },
          { value: 'ens_callback_valid', label: 'ENS callback valid (recording replay)' },
        ],
      },
      {
        key: 'expected_value', label: 'Expected value', fieldType: 'mono_text', required: true,
        placeholder: 'expected value',
        hint: 'Static value or ${var_name} to compare against',
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
    configSchema: [
      { key: 'ens_configuration_id', label: 'ENS Configuration ID', fieldType: 'number', min: 1, hint: 'Leave blank if using ens_config_var' },
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
  local recording_file
  if node.recording_file_var and node.recording_file_var ~= "" then
    local rf = s:getVariable(node.recording_file_var) or ""
    if rf ~= "" then recording_file = rf end
  end

  local d = post("/ens/notifications", {
    configuration_id = cfg_id,
    triggered_via    = "PHONE",
    caller_number    = caller_number ~= "" and caller_number or nil,
    recording_file   = recording_file,
  })

  if d and d.notification_uuid then
    s:setVariable("ens_notification_uuid", d.notification_uuid)
    freeswitch.consoleLog("INFO", "[ivr_executor] ens node: blast triggered uuid=" .. d.notification_uuid .. "\\n")
  else
    freeswitch.consoleLog("ERR", "[ivr_executor] ens node: blast failed — " .. tostring(d and d.error or "no response") .. "\\n")
  end

  return node.next
end`,
    apiEndpoint: { method: 'POST', path: '/api/v1/internal/ens/notifications' },
  },

  {
    type: 'ers',
    label: 'Trigger ERS',
    icon: '🚨',
    bg: '#3b1e1e', border: '#8a2a2a', color: '#fca5a5',
    category: 'Emergency',
    description: 'Start ERS conference',
    ports: 'none',
    configSchema: [
      { key: 'ers_configuration_id', label: 'ERS Configuration ID', fieldType: 'number', min: 1, required: true },
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
    description: 'Record caller audio',
    ports: 'next',
    configSchema: [
      { key: 'variable_name', label: 'Variable name', fieldType: 'mono_text', required: true, placeholder: 'recorded_file_path', hint: 'Session var that stores the recorded file path' },
      { key: 'prompt_text', label: 'Prompt text (TTS)', fieldType: 'textarea', hint: 'Played before recording starts', placeholder: 'Please record your message after the tone. Press # when done.' },
      { key: 'prompt_audio_url', label: 'Prompt audio URL (overrides TTS)', fieldType: 'audio_url', placeholder: '/media/record_prompt.wav' },
      { key: 'max_seconds', label: 'Max seconds', fieldType: 'number', min: 1, max: 300 },
      { key: 'silence_threshold', label: 'Silence threshold (ms)', fieldType: 'number', min: 10, max: 2000, hint: 'Audio level below which is considered silence' },
      { key: 'silence_hits', label: 'Silence hits', fieldType: 'number', min: 1, max: 10, hint: 'How many silence chunks before stopping' },
      { key: 'record_dir', label: 'Record directory', fieldType: 'mono_text', placeholder: '/var/lib/freeswitch/recordings', hint: 'Default: /var/lib/freeswitch/recordings' },
      { key: 'next', label: 'Next Node', fieldType: 'node_ref', required: true, hint: 'Node to proceed to after recording' },
    ],
    luaHandler: `
local function exec_record_message(s, node)
  local rec_dir = node.record_dir
  if not rec_dir or rec_dir == "" then
    rec_dir = _api:execute("global_getvar", "recordings_dir") or "/var/lib/freeswitch/recordings"
    rec_dir = rec_dir .. "/ivr"
  end
  local fpath = rec_dir .. "/ivr_" .. s:getVariable("uuid") .. "_" .. os.time() .. ".wav"

  local pf = resolve_audio(node.prompt_audio_url)
  if pf then
    s:streamFile(pf)
  else
    local pt = interp(s, node.prompt_text) or ""
    if pt ~= "" then speak(s, pt) end
  end

  s:execute("playback", "tone_stream://%(500,0,640)")  -- recording beep
  s:recordFile(fpath,
    node.max_seconds       or 60,
    node.silence_threshold or 500,
    node.silence_hits      or 3)
  s:setVariable(node.variable_name or "recorded_file_path", fpath)
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
    configSchema: [
      { key: 'ers_configuration_id', label: 'ERS Configuration ID', fieldType: 'number', min: 1, required: true },
      { key: 'tier', label: 'Responder Tier', fieldType: 'select', required: true, options: [{ value: 'primary', label: 'Level 1 (Primary)' }, { value: 'secondary', label: 'Level 2 (Secondary)' }] },
    ],
    luaHandler: `
local function exec_ers_ring_all(s, node)
  local cfg_id = node.ers_configuration_id
  if not cfg_id then
    freeswitch.consoleLog("ERR", "[ivr_executor] ers_ring_all: missing ers_configuration_id — hanging up\\n")
    return nil
  end

  local d = post("/ers/ring-all", {
    configuration_id = cfg_id,
    tier             = node.tier or "primary",
    caller_number    = s:getVariable("caller_id_number") or "",
    caller_name      = s:getVariable("caller_id_name") or nil,
  })

  if d and d.conference_room then
    s:setVariable("ers_incident_uuid", d.incident_uuid or "")
    -- Blocks until THIS leg leaves. The backend ring loop keeps re-ringing
    -- responders in parallel the whole time the caller waits in the room.
    s:execute("conference", d.conference_room .. "@default")
    if d.incident_uuid then
      post("/ers/incidents/" .. d.incident_uuid .. "/complete", {})
    end
  else
    freeswitch.consoleLog("ERR", "[ivr_executor] ers_ring_all: ring-all failed — " .. tostring(d and d.error or "no response") .. "\\n")
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
    configSchema: [
      { key: 'ers_configuration_id', label: 'ERS Configuration ID', fieldType: 'number', min: 1, required: true },
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
    configSchema: [
      { key: 'ers_configuration_id', label: 'ERS Configuration ID', fieldType: 'number', min: 1, required: true },
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
    footnote: 'Full blast trigger in one node: collects and verifies the PIN (3 attempts), records the initiator’s message, and broadcasts to every contact’s extension AND mobile number. Next Node runs after the blast is confirmed started.',
    configSchema: [
      { key: 'ens_configuration_id', label: 'ENS Configuration ID', fieldType: 'number', min: 1, hint: 'Leave blank to resolve from the dialed number' },
      { key: 'pin_prompt_text', label: 'PIN prompt (TTS)', fieldType: 'textarea', placeholder: 'Please enter your authorization PIN followed by pound.' },
      { key: 'record_prompt_text', label: 'Record prompt (TTS)', fieldType: 'textarea', placeholder: 'Record your emergency message after the tone. Press pound when finished.' },
      { key: 'max_record_seconds', label: 'Max recording (seconds)', fieldType: 'number', min: 5, max: 300 },
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

  -- Record the initiator's message
  local rec_dir = _api:execute("global_getvar", "recordings_dir") or "/var/lib/freeswitch/recordings"
  local fpath = rec_dir .. "/ens/ens_" .. tostring(cfg_id) .. "_" .. os.time() .. ".wav"
  local rprompt = interp(s, node.record_prompt_text)
  if rprompt == "" then rprompt = "Record your emergency message after the tone. Press pound when finished." end
  speak(s, rprompt)
  s:execute("playback", "tone_stream://%(500,0,640)")
  s:recordFile(fpath, node.max_record_seconds or 120, 500, 3)

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
    footnote: 'The UUUU line: callers on the authorized list hear the latest recorded message if it is within its 24-hour window (or "no active message" after expiry) and route to the True node; unauthorized callers are logged and route to the False node.',
    configSchema: [
      { key: 'ers_configuration_id', label: 'ERS Configuration ID', fieldType: 'number', min: 1, required: true },
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
  return NODE_TYPE_REGISTRY.map(({ type, label, icon, bg, border, color, category, description, ports, configSchema, footnote }) =>
    ({ type, label, icon, bg, border, color, category, description, ports, configSchema, footnote }));
}
