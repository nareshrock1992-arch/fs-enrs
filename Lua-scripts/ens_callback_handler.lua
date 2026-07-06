-- =============================================================================
-- ens_callback_handler.lua
-- ENS Callback Replay Handler
-- =============================================================================
--
-- Handles inbound calls to the ENS reply_clid number (contacts calling back).
-- Checks whether the caller is in the blast list and recording is < 24h old.
-- If authorized: plays recording and logs the callback.
-- If expired/unauthorized: plays a default "no active emergency" message.
--
-- FreeSWITCH dialplan usage:
--   <extension name="ens_callback">
--     <condition field="destination_number" expression="^(1300)$">
--       <action application="set" data="reply_clid=1300"/>
--       <action application="lua" data="ens_callback_handler.lua"/>
--     </condition>
--   </extension>
--
-- Note: If the reply_clid number is bound to an IVR flow in the builder,
-- the ivr_flow_executor.lua will handle it instead using ens_callback_valid
-- condition nodes. This script is the standalone fallback for numbers not
-- yet migrated to the visual IVR builder.
-- =============================================================================

local API_BASE    = os.getenv("ENRS_INTERNAL_API") or "http://127.0.0.1:4100/api/v1/internal"
local API_KEY     = os.getenv("FS_INTERNAL_KEY")   or ""
local TTS_ENGINE  = os.getenv("ENRS_TTS_ENGINE")   or "flite"
local TTS_VOICE   = os.getenv("ENRS_TTS_VOICE")    or "slt"
local HTTP_TIMEOUT = 8

local function log(level, msg)
  freeswitch.consoleLog(level or "INFO", "[ENS_CALLBACK] " .. tostring(msg) .. "\n")
end

local function url_encode(s)
  return (tostring(s or "")):gsub("[^%w%-%.%_%~]", function(c)
    return string.format("%%%02X", string.byte(c))
  end)
end

local json_ok, json = pcall(require, "cjson")
if not json_ok then json = nil end

local function http_get(path)
  local cmd = string.format(
    'curl -s -m %d -H "Content-Type: application/json" -H "X-Internal-Key: %s" "%s%s" 2>/dev/null',
    HTTP_TIMEOUT, API_KEY, API_BASE, path
  )
  local handle = io.popen(cmd)
  local raw = (handle and handle:read("*a")) or ""
  if handle then handle:close() end
  if raw == "" or not json then return nil end
  local ok, data = pcall(json.decode, raw)
  return ok and data or nil
end

local function http_post(path, payload)
  local body = json and json.encode(payload) or "{}"
  local safe = body:gsub("'", "'\\''")
  local cmd = string.format(
    "curl -s -m %d -X POST -H \"Content-Type: application/json\" -H \"X-Internal-Key: %s\" -d '%s' '%s%s' 2>/dev/null",
    HTTP_TIMEOUT, API_KEY, safe, API_BASE, path
  )
  local handle = io.popen(cmd)
  local raw = (handle and handle:read("*a")) or ""
  if handle then handle:close() end
  if raw == "" or not json then return nil end
  local ok, data = pcall(json.decode, raw)
  return ok and data or nil
end

local function speak(text)
  if text and text ~= "" and session:ready() then
    session:execute("speak", TTS_ENGINE .. "|" .. TTS_VOICE .. "|" .. text)
  end
end

-- ── Main ──────────────────────────────────────────────────────────────────────

local reply_clid   = session:getVariable("reply_clid") or session:getVariable("destination_number") or ""
local caller       = session:getVariable("caller_id_number") or ""

if reply_clid == "" then
  log("ERR", "reply_clid not set — cannot authorize callback")
  session:hangup("UNALLOCATED_NUMBER")
  return
end

log("INFO", "ENS callback: reply_clid=" .. reply_clid .. " caller=" .. caller)

session:answer()
session:sleep(200)

-- Authorize callback
local resp = http_get(
  "/ens/callbacks/authorize?reply_clid=" .. url_encode(reply_clid) ..
  "&caller=" .. url_encode(caller)
)

if not resp then
  log("ERR", "API unreachable during callback authorize")
  speak("The emergency notification system is currently unavailable. Please try again later.")
  session:hangup("NORMAL_CLEARING")
  return
end

if not resp.authorized then
  local reason = resp.reason or "unknown"
  log("INFO", "Callback denied: " .. reason)

  if reason == "recording_expired" then
    speak("The emergency notification recording has expired. No active emergency alert is available.")
  elseif reason == "not_in_blast_list" then
    speak("Your number is not registered for this emergency notification.")
  else
    speak("There is no active emergency notification at this time.")
  end

  session:hangup("NORMAL_CLEARING")
  return
end

-- Authorized — play recording
local recording_file   = resp.recording_file or ""
local notification_uuid = resp.notification_uuid or ""
local delivery_id      = resp.delivery_id or 0

log("INFO", "Callback authorized: playing recording " .. recording_file)

speak("You have an emergency notification message.")
session:sleep(500)

if recording_file ~= "" then
  session:streamFile(recording_file)
else
  speak("The emergency notification recording is no longer available.")
end

session:sleep(500)
speak("To hear this message again, please hang up and call back.")

-- Log the callback replay
if notification_uuid ~= "" and delivery_id ~= 0 then
  http_post("/ens/callbacks", {
    notification_uuid = notification_uuid,
    caller_number     = caller,
    reply_clid        = reply_clid,
    delivery_id       = delivery_id,
    replayed_at       = os.date("!%Y-%m-%dT%H:%M:%SZ"),
  })
  log("INFO", "Callback logged: uuid=" .. notification_uuid)
end

session:hangup("NORMAL_CLEARING")
