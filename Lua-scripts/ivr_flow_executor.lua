-- =============================================================================
-- ivr_flow_executor.lua
-- Generic IVR Flow Graph Executor for fs-enrs
-- =============================================================================
--
-- Replaces all hardcoded ENS/ERS Lua IVR flows.
-- Fetches a published flow graph from the backend API and executes it
-- node-by-node using a simple loop — no recursion, cycle-safe (MAX_LOOP guard).
--
-- FreeSWITCH dialplan usage:
--   <extension name="ivr_flow">
--     <condition field="destination_number" expression="^(1[2-9]\d\d)$">
--       <action application="lua" data="ivr_flow_executor.lua"/>
--     </condition>
--   </extension>
--
-- The executor reads the dialed number from the session channel variable
-- "destination_number" and looks up the bound IVR flow via the internal API.
--
-- Supported node types:
--   say, play, gather, condition, record_message, set_variable,
--   ens, ers, goto, transfer, hangup
-- =============================================================================

-- ── Configuration ─────────────────────────────────────────────────────────────

local API_BASE   = os.getenv("ENRS_INTERNAL_API") or "http://127.0.0.1:4100/api/v1/internal"
local API_KEY    = os.getenv("FS_INTERNAL_KEY")   or ""
local REC_DIR    = os.getenv("ENRS_REC_DIR")      or "/var/lib/freeswitch/recordings"
local TTS_ENGINE = os.getenv("ENRS_TTS_ENGINE")   or "flite"
local TTS_VOICE  = os.getenv("ENRS_TTS_VOICE")    or "slt"
local MAX_LOOP   = 100   -- prevents runaway graphs from looping forever
local HTTP_TIMEOUT = 8   -- curl timeout in seconds

-- ── Logging ───────────────────────────────────────────────────────────────────

local function log(level, msg)
  freeswitch.consoleLog(level or "INFO", "[IVR_EXEC] " .. tostring(msg) .. "\n")
end

-- ── URL encoding ──────────────────────────────────────────────────────────────

local function url_encode(s)
  s = tostring(s or "")
  return s:gsub("[^%w%-%.%_%~]", function(c)
    return string.format("%%%02X", string.byte(c))
  end)
end

-- ── JSON (cjson is bundled with FreeSWITCH) ───────────────────────────────────

local json_ok, json = pcall(require, "cjson")
if not json_ok then
  -- fallback: minimal JSON decoder using load() — works for flat objects
  log("WARN", "cjson not available, using minimal decoder")
  json = {
    decode = function(s)
      local fn = load("return " .. s:gsub('(%b{})%s*:', function(k)
        return k .. "=" end):gsub('"([^"]+)"', "'%1'"))
      return fn and fn() or nil
    end,
    encode = function(t)
      local parts = {}
      for k, v in pairs(t) do
        local val
        if type(v) == "string" then val = '"' .. v:gsub('"', '\\"') .. '"'
        elseif type(v) == "number" then val = tostring(v)
        elseif type(v) == "boolean" then val = tostring(v)
        elseif v == nil then val = "null"
        end
        if val then parts[#parts+1] = '"' .. k .. '":' .. val end
      end
      return "{" .. table.concat(parts, ",") .. "}"
    end
  }
end

-- ── HTTP helpers ──────────────────────────────────────────────────────────────
-- Use curl via io.popen — works reliably in FreeSWITCH Lua environment.
-- The internal API is on localhost so latency is negligible.

local function curl_exec(method, url, body_json)
  local h_ct  = string.format('-H "Content-Type: application/json"')
  local h_key = string.format('-H "X-Internal-Key: %s"', API_KEY)
  local cmd

  if method == "GET" then
    cmd = string.format(
      'curl -s -m %d %s %s "%s" 2>/dev/null',
      HTTP_TIMEOUT, h_ct, h_key, url
    )
  else
    -- Escape single quotes in body
    local safe_body = (body_json or "{}"):gsub("'", "'\\''")
    cmd = string.format(
      "curl -s -m %d -X %s %s %s -d '%s' '%s' 2>/dev/null",
      HTTP_TIMEOUT, method, h_ct, h_key, safe_body, url
    )
  end

  local handle = io.popen(cmd)
  local result = (handle and handle:read("*a")) or ""
  if handle then handle:close() end

  if result == "" then
    log("WARN", method .. " " .. url .. " returned empty response")
    return nil
  end

  local ok, data = pcall(json.decode, result)
  if not ok then
    log("ERR", "JSON decode failed for " .. method .. " " .. url .. ": " .. tostring(data))
    return nil
  end
  return data
end

local function http_get(path)
  return curl_exec("GET", API_BASE .. path)
end

local function http_post(path, payload)
  local body = json.encode(payload or {})
  return curl_exec("POST", API_BASE .. path, body)
end

local function http_patch(path, payload)
  local body = json.encode(payload or {})
  return curl_exec("PATCH", API_BASE .. path, body)
end

-- ── Variable interpolation ────────────────────────────────────────────────────
-- Resolves ${var_name} references in strings using session channel variables.

local function resolve(session, s)
  return (tostring(s or "")):gsub("%${([^}]+)}", function(k)
    return tostring(session:getVariable(k) or "")
  end)
end

-- ── TTS helper ────────────────────────────────────────────────────────────────

local function speak(session, text)
  if text and text ~= "" and session:ready() then
    session:execute("speak", TTS_ENGINE .. "|" .. TTS_VOICE .. "|" .. text)
  end
end

-- ── Node handlers ─────────────────────────────────────────────────────────────
-- Each handler receives (session, node) and returns the ID of the next node
-- to execute, or nil to end the session.

-- say — TTS prompt
local function handle_say(session, node)
  if not session:ready() then return nil end
  speak(session, resolve(session, node.text))
  return node.next
end

-- play — stream audio file
local function handle_play(session, node)
  if not session:ready() then return nil end
  local path = node.audio_url or ""
  if path ~= "" then
    session:streamFile(path)
  end
  return node.next
end

-- gather — collect DTMF digits into variable_name, then route by branch
local function handle_gather(session, node)
  if not session:ready() then return nil end

  local var_name    = node.variable_name or "gather_result"
  local max_digits  = node.max_digits or 1
  local timeout_ms  = (node.timeout_seconds or 10) * 1000
  local terminators = node.terminators or "#"
  local prompt_file = node.prompt_audio_url or ""
  local prompt_text = resolve(session, node.prompt_text or "")
  local branches    = node.branches or {}

  -- Play TTS prompt if no audio file specified
  if prompt_text ~= "" and prompt_file == "" then
    speak(session, prompt_text)
  end

  -- Collect digits
  local digits = session:playAndGetDigits(
    1,           -- min_digits (1 so # alone works as "no input")
    max_digits,  -- max_digits
    3,           -- max_tries
    timeout_ms,  -- timeout in ms
    terminators, -- terminators
    prompt_file, -- prompt audio (empty string = no replay)
    "",          -- invalid_file
    var_name,    -- channel variable to store result
    "\\d*"       -- regexp
  )

  digits = tostring(digits or "")
  session:setVariable(var_name, digits)
  log("INFO", "gather: collected '" .. digits .. "' → " .. var_name)

  -- Branch resolution priority:
  --   1. Exact digit match
  --   2. _default catch-all
  --   3. invalid branch
  if digits == "" then
    return branches["timeout"] or branches["invalid"] or nil
  end

  local next_node = branches[digits]
  if not next_node or next_node == "" then
    next_node = branches["_default"]
  end
  if not next_node or next_node == "" then
    next_node = branches["invalid"]
  end
  return next_node
end

-- condition — evaluate session variable against expected_value
--   operator == | != | contains | starts_with | ens_pin_valid | ens_callback_valid
local function handle_condition(session, node)
  if not session:ready() then return nil end

  local val      = tostring(session:getVariable(node.variable) or "")
  local expected = resolve(session, node.expected_value or "")
  local op       = node.operator or "=="
  local match    = false

  if op == "==" then
    match = (val == expected)

  elseif op == "!=" then
    match = (val ~= expected)

  elseif op == "contains" then
    match = (val:find(expected, 1, true) ~= nil)

  elseif op == "starts_with" then
    match = (val:sub(1, #expected) == expected)

  elseif op == "ens_pin_valid" then
    -- expected_value is the ENS access number (or ${destination_number})
    local ens_num = expected
    if ens_num == "" then
      ens_num = session:getVariable("destination_number") or ""
    end

    log("INFO", "ens_pin_valid: lookup for number=" .. ens_num)
    local resp = http_get("/ens/lookup?number=" .. url_encode(ens_num))

    if resp and resp.success and resp.data then
      local cfg = resp.data
      local expected_pin = tostring(cfg.pin or "")
      match = (val == expected_pin)

      if match then
        -- Store ENS config data as session variables for downstream ens node
        session:setVariable("ens_configuration_id",  tostring(cfg.configuration_id or ""))
        session:setVariable("ens_retry_count",        tostring(cfg.retry_count or 3))
        session:setVariable("ens_retry_delay",        tostring(cfg.retry_delay_seconds or 30))
        session:setVariable("ens_blast_clid",         tostring(cfg.blast_clid or ""))
        session:setVariable("ens_reply_clid",         tostring(cfg.reply_clid or ""))
        session:setVariable("ens_max_concurrent",     tostring(cfg.max_concurrent or 5))
        log("INFO", "ens_pin_valid: PIN matched, config_id=" .. tostring(cfg.configuration_id))
      else
        log("INFO", "ens_pin_valid: PIN mismatch (entered='" .. val .. "')")
      end
    else
      log("ERR", "ens_pin_valid: lookup failed for " .. ens_num)
      match = false
    end

  elseif op == "ens_callback_valid" then
    -- expected_value is the reply_clid of the ENS configuration
    -- Checks whether the calling number is in the blast list and recording is still valid
    local reply_clid  = expected
    local caller      = session:getVariable("caller_id_number") or ""

    log("INFO", "ens_callback_valid: reply_clid=" .. reply_clid .. " caller=" .. caller)
    local resp = http_get(
      "/ens/callbacks/authorize?reply_clid=" .. url_encode(reply_clid) ..
      "&caller=" .. url_encode(caller)
    )

    if resp and resp.authorized then
      session:setVariable("ens_recording_file",    resp.recording_file or "")
      session:setVariable("ens_notification_uuid", resp.notification_uuid or "")
      session:setVariable("ens_delivery_id",       tostring(resp.delivery_id or ""))
      match = true
      log("INFO", "ens_callback_valid: authorized, recording=" .. tostring(resp.recording_file))
    else
      local reason = (resp and resp.reason) or "unknown"
      log("INFO", "ens_callback_valid: not authorized, reason=" .. reason)
      session:setVariable("ens_callback_deny_reason", reason)
      match = false
    end

  else
    log("WARN", "condition: unknown operator '" .. op .. "', treating as false")
    match = false
  end

  return match and node.true_node or node.false_node
end

-- record_message — record caller audio, save path to variable_name
local function handle_record_message(session, node)
  if not session:ready() then return nil end

  local var_name   = node.variable_name or "recorded_file_path"
  local rec_dir    = node.record_dir or REC_DIR
  local max_sec    = node.max_seconds or 60
  local sil_thresh = node.silence_threshold or 500
  local sil_hits   = node.silence_hits or 3

  -- Ensure recording directory exists
  os.execute("mkdir -p " .. rec_dir)

  -- Build unique filename: <dir>/<timestamp>_<uuid>.wav
  local filename = rec_dir .. "/" .. tostring(os.time()) .. "_" .. session:get_uuid() .. ".wav"

  -- Play prompt before recording
  local prompt_file = node.prompt_audio_url or ""
  local prompt_text = resolve(session, node.prompt_text or "")
  if prompt_file ~= "" then
    session:streamFile(prompt_file)
  elseif prompt_text ~= "" then
    speak(session, prompt_text)
  end

  -- Brief beep before recording starts (standard courtesy tone)
  session:execute("playback", "tone_stream://%(500,0,440)")

  -- Record: path max_len silence_thresh silence_hits
  log("INFO", "record_message: recording to " .. filename)
  session:execute("record", filename .. " " .. max_sec .. " " .. sil_thresh .. " " .. sil_hits)

  -- Store the path in the named session variable
  session:setVariable(var_name, filename)
  log("INFO", "record_message: stored path in " .. var_name)

  return node.next
end

-- set_variable — set a FreeSWITCH channel variable (supports ${ref} interpolation)
local function handle_set_variable(session, node)
  if not session:ready() then return nil end
  local value = resolve(session, node.value or "")
  session:setVariable(node.variable, value)
  log("INFO", "set_variable: " .. tostring(node.variable) .. " = " .. value)
  return node.next
end

-- ens — trigger ENS blast via internal API
--   Reads configuration_id from ens_configuration_id field OR ens_config_var session var.
--   Reads recording_file from recording_file_var session var.
local function handle_ens(session, node)
  if not session:ready() then return nil end

  -- Resolve configuration ID
  local config_id
  if node.ens_configuration_id and node.ens_configuration_id ~= "" and
     node.ens_configuration_id ~= 0 then
    config_id = tonumber(node.ens_configuration_id)
  elseif node.ens_config_var and node.ens_config_var ~= "" then
    config_id = tonumber(session:getVariable(node.ens_config_var))
  end

  if not config_id then
    log("ERR", "ens node: could not resolve configuration_id — skipping blast")
    return node.next
  end

  -- Resolve recording file
  local recording_file = nil
  if node.recording_file_var and node.recording_file_var ~= "" then
    local rf = session:getVariable(node.recording_file_var) or ""
    if rf ~= "" then recording_file = rf end
  end

  local caller_number = session:getVariable("caller_id_number") or ""

  log("INFO", "ens node: triggering blast config_id=" .. config_id ..
    " recording=" .. tostring(recording_file))

  local resp = http_post("/ens/notifications", {
    configuration_id = config_id,
    triggered_via    = "PHONE",
    caller_number    = caller_number ~= "" and caller_number or nil,
    recording_file   = recording_file,
  })

  if resp and resp.notification_uuid then
    session:setVariable("ens_notification_uuid", resp.notification_uuid)
    log("INFO", "ens node: blast triggered, uuid=" .. resp.notification_uuid)
  else
    local err = (resp and resp.error) or "no response from API"
    log("ERR", "ens node: blast failed — " .. err)
  end

  return node.next
end

-- ers — transfer to ERS conference handling
--   Sets ers_configuration_id_override if needed, then transfers to ERS dialplan.
local function handle_ers(session, node)
  if not session:ready() then return nil end

  local config_id
  if node.ers_configuration_id then
    config_id = tostring(node.ers_configuration_id)
  elseif node.ers_config_var and node.ers_config_var ~= "" then
    config_id = session:getVariable(node.ers_config_var) or ""
  end

  if config_id and config_id ~= "" then
    session:setVariable("ers_configuration_id_override", config_id)
  end

  -- Transfer to ERS dialplan extension (handled by dial_911_conference)
  log("INFO", "ers node: transferring to ERS dialplan (config=" .. tostring(config_id) .. ")")
  session:execute("transfer", "911 XML default")
  return nil  -- transfer hands off control; executor stops
end

-- goto — jump to target_node_id (no side effects)
local function handle_goto(session, node)
  log("INFO", "goto: → " .. tostring(node.target_node_id))
  return node.target_node_id
end

-- transfer — transfer call to an extension/context
local function handle_transfer(session, node)
  if not session:ready() then return nil end
  local dest     = resolve(session, node.destination or "")
  local dialplan = node.dialplan or "XML"
  local context  = node.context or "default"

  if dest == "" then
    log("ERR", "transfer node: empty destination — skipping")
    return nil
  end

  log("INFO", "transfer: → " .. dest .. " " .. dialplan .. " " .. context)
  session:execute("transfer", dest .. " " .. dialplan .. " " .. context)
  return nil  -- transfer hands off control; executor stops
end

-- hangup — optionally play goodbye audio, then hang up
local function handle_hangup(session, node)
  if node.play_audio_url and node.play_audio_url ~= "" and session:ready() then
    session:streamFile(node.play_audio_url)
  end
  log("INFO", "hangup node: ending call")
  session:hangup("NORMAL_CLEARING")
  return nil
end

-- ── Handler dispatch table ────────────────────────────────────────────────────

local HANDLERS = {
  say            = handle_say,
  play           = handle_play,
  gather         = handle_gather,
  condition      = handle_condition,
  record_message = handle_record_message,
  set_variable   = handle_set_variable,
  ens            = handle_ens,
  ers            = handle_ers,
  goto           = handle_goto,
  transfer       = handle_transfer,
  hangup         = handle_hangup,
}

-- ── ENS callback log helper ───────────────────────────────────────────────────
-- Called after the ens_callback_valid condition succeeds and recording plays.
-- This is invoked by post-execution hook in the flow, not a node handler.

local function log_ens_callback(session)
  local notif_uuid   = session:getVariable("ens_notification_uuid") or ""
  local caller       = session:getVariable("caller_id_number")      or ""
  local reply_clid   = session:getVariable("ens_reply_clid")        or ""
  local delivery_id  = tonumber(session:getVariable("ens_delivery_id") or "0")

  if notif_uuid == "" or delivery_id == 0 then return end

  http_post("/ens/callbacks", {
    notification_uuid = notif_uuid,
    caller_number     = caller,
    reply_clid        = reply_clid,
    delivery_id       = delivery_id,
    replayed_at       = os.date("!%Y-%m-%dT%H:%M:%SZ"),
  })
  log("INFO", "ENS callback logged for " .. notif_uuid)
end

-- ── Main executor ─────────────────────────────────────────────────────────────

-- Read dialed number from session
local dest_number = session:getVariable("destination_number") or ""
if dest_number == "" then
  log("ERR", "destination_number channel variable is empty")
  session:hangup("UNALLOCATED_NUMBER")
  return
end

log("INFO", "IVR executor starting — destination=" .. dest_number)

-- Fetch the published flow graph from backend
local lookup = http_get("/ivr/lookup?number=" .. url_encode(dest_number))
if not lookup or not lookup.entry_node_id then
  log("ERR", "No published IVR flow bound to " .. dest_number)
  session:hangup("UNALLOCATED_NUMBER")
  return
end

local nodes      = lookup.nodes or {}
local current_id = lookup.entry_node_id
local loop_count = 0

log("INFO", "Flow: " .. tostring(lookup.flow_name) .. " v" ..
  tostring(lookup.version_number) .. " entry=" .. current_id)

-- Answer the call before starting the IVR
session:answer()
session:sleep(200)  -- brief settle pause after answer

-- Track whether the caller received an ENS callback replay (for post-execution hook)
local was_ens_callback = false

-- ── Node execution loop ───────────────────────────────────────────────────────

while current_id and loop_count < MAX_LOOP do
  if not session:ready() then
    log("INFO", "Session ended by remote party at node=" .. current_id)
    break
  end

  local node = nodes[current_id]
  if not node then
    log("ERR", "Node '" .. current_id .. "' not found in graph — ending")
    break
  end

  loop_count = loop_count + 1
  log("INFO", "[" .. loop_count .. "] node=" .. current_id .. " type=" .. tostring(node.type))

  -- Detect ENS callback replay (play node after ens_callback_valid condition)
  if node.type == "play" and session:getVariable("ens_notification_uuid") ~= "" then
    was_ens_callback = true
  end

  local handler = HANDLERS[node.type]
  if not handler then
    log("ERR", "No handler for node type '" .. tostring(node.type) .. "' — ending")
    break
  end

  -- Execute handler with error boundary
  local ok, next_id = pcall(handler, session, node)
  if not ok then
    log("ERR", "Handler error at node '" .. current_id .. "': " .. tostring(next_id))
    break
  end

  current_id = next_id
end

if loop_count >= MAX_LOOP then
  log("ERR", "MAX_LOOP (" .. MAX_LOOP .. ") reached — possible cycle, hanging up")
  if session:ready() then session:hangup("NORMAL_CLEARING") end
end

-- Post-execution: log ENS callback replay if it happened
if was_ens_callback and session:getVariable("ens_notification_uuid") ~= "" then
  log_ens_callback(session)
end

log("INFO", "IVR executor done — " .. loop_count .. " nodes executed")
