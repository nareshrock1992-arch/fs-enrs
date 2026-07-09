-- =============================================================================
-- blast_call.lua
-- ENS Emergency Notification — Blast Trigger
-- =============================================================================
--
-- Flow:
--   1. Lookup configuration via API
--   2. If PIN required → collect DTMF → verify-pin API
--   3. Play prompt → record blast message
--   4. POST /internal/ens/campaign/start → backend manages outbound
--   5. Confirm and disconnect
--
-- Dialplan example:
--   <extension name="ens_blast">
--     <condition field="destination_number" expression="^(1888)$">
--       <action application="lua" data="blast_call.lua"/>
--     </condition>
--   </extension>
-- =============================================================================

local API_BASE     = os.getenv("ENRS_INTERNAL_API") or "http://127.0.0.1:4100/api/v1/internal"
local API_KEY      = os.getenv("FS_INTERNAL_KEY")   or ""
local REC_DIR      = os.getenv("ENRS_REC_DIR")      or "/opt/freeswitch/recordings/ens"
local TTS_ENGINE   = os.getenv("ENRS_TTS_ENGINE")   or "flite"
local TTS_VOICE    = os.getenv("ENRS_TTS_VOICE")    or "slt"
local HTTP_TIMEOUT = 8

local json_ok, json = pcall(require, "cjson")
if not json_ok then json = nil end

local function log(level, msg)
  freeswitch.consoleLog(level or "INFO", "[BLAST] " .. tostring(msg) .. "\n")
end

local function url_encode(s)
  return (tostring(s or "")):gsub("[^%w%-%.%_%~]", function(c)
    return string.format("%%%02X", string.byte(c))
  end)
end

local function http_get(path)
  local cmd = string.format(
    'curl -sf -m %d -H "X-Internal-Key: %s" "%s%s" 2>/dev/null',
    HTTP_TIMEOUT, API_KEY, API_BASE, path
  )
  local h = io.popen(cmd)
  local raw = h and h:read("*a") or ""
  if h then h:close() end
  if raw == "" or not json then return nil end
  local ok, d = pcall(json.decode, raw)
  return ok and d or nil
end

local function http_post(path, payload)
  local body = json and json.encode(payload) or "{}"
  local safe = body:gsub("'", "'\\''")
  local cmd  = string.format(
    "curl -sf -m %d -X POST -H 'Content-Type: application/json' -H 'X-Internal-Key: %s' -d '%s' '%s%s' 2>/dev/null",
    HTTP_TIMEOUT, API_KEY, safe, API_BASE, path
  )
  local h = io.popen(cmd)
  local raw = h and h:read("*a") or ""
  if h then h:close() end
  if raw == "" or not json then return nil end
  local ok, d = pcall(json.decode, raw)
  return ok and d or nil
end

local function speak(text)
  if text and text ~= "" and session:ready() then
    session:execute("speak", TTS_ENGINE .. "|" .. TTS_VOICE .. "|" .. text)
  end
end

local function collect_digits(timeout_ms, max_len)
  session:execute("read", string.format("%d %d %s noname %d #", 1, max_len or 10, "", timeout_ms or 7000))
  return session:getVariable("read_result") or ""
end

-- ── Main ──────────────────────────────────────────────────────────────────────

local dest   = session:getVariable("destination_number") or ""
local caller = session:getVariable("caller_id_number")   or ""

log("INFO", "ENS blast triggered: dest=" .. dest .. " caller=" .. caller)

-- 1. Lookup configuration (no hardcoded logic — everything from API)
local lookup = http_get("/ens/lookup?number=" .. url_encode(dest))

if not lookup or not lookup.success then
  log("ERR", "ENS lookup failed for number: " .. dest)
  session:answer()
  speak("This emergency notification number is not configured. Please contact your system administrator.")
  session:sleep(500)
  session:hangup("UNALLOCATED_NUMBER")
  return
end

local cfg = lookup.data
log("INFO", "ENS config: id=" .. tostring(cfg.configuration_id) ..
    " name=" .. tostring(cfg.name) ..
    " pin_required=" .. tostring(cfg.pin_required))

session:answer()
session:sleep(400)

-- 2. PIN verification (if configured)
if cfg.pin_required then
  local verified = false
  local attempts = 0
  local max_attempts = 3

  repeat
    if attempts == 0 then
      speak("Welcome to the Emergency Notification System. Please enter your authorization PIN followed by the pound key.")
    else
      speak("Incorrect PIN. Please try again.")
    end

    local entered = collect_digits(8000, 8)

    if entered == "" then
      speak("No PIN entered. Goodbye.")
      session:hangup("NORMAL_CLEARING")
      return
    end

    local verify = http_post("/ens/verify-pin", {
      trigger_number = dest,
      pin            = entered,
    })

    if verify and verify.authorized then
      log("INFO", "PIN authorized: " .. dest)
      verified = true
    else
      attempts = attempts + 1
      log("WARN", "PIN attempt " .. attempts .. " failed for " .. dest)
    end
  until verified or attempts >= max_attempts

  if not verified then
    log("WARN", "Max PIN attempts exceeded: " .. dest .. " from " .. caller)
    speak("Maximum authorization attempts exceeded. Goodbye.")
    session:hangup("CALL_REJECTED")
    return
  end
end

-- 3. Record blast message
local timestamp    = os.time()
local safe_caller  = caller:gsub("[^%d]", "")
local rec_filename = string.format("ens_%d_%s_%d.wav", cfg.configuration_id, safe_caller, timestamp)
local rec_path     = REC_DIR .. "/" .. rec_filename

speak("You are now connected to the Emergency Notification System. Please record your emergency message after the tone. Press the pound key when finished.")
session:sleep(600)

-- Beep
session:execute("playback", "tone_stream://%(800,200,440)")
session:sleep(100)

-- Record (max 180 s, stop on #, silence detection after 3 s)
session:execute("record", rec_path .. " 180 500 3 #")
session:sleep(400)

-- Verify recording has meaningful content
local rec_size = 0
local fh = io.open(rec_path, "rb")
if fh then
  rec_size = fh:seek("end") or 0
  fh:close()
end

if rec_size < 5000 then
  log("WARN", "Recording too short (bytes=" .. rec_size .. ") — aborting campaign")
  speak("Your message was too short to process. Please call back and record a longer message.")
  session:hangup("NORMAL_CLEARING")
  return
end

log("INFO", "Recording saved: " .. rec_path .. " bytes=" .. rec_size)

-- 4. Start the outbound campaign
speak("Thank you. Starting your emergency notification now. Please stay on the line for confirmation.")
session:sleep(400)

local campaign = http_post("/ens/campaign/start", {
  trigger_number = dest,
  recording_file = rec_path,
  caller_number  = caller,
})

if not campaign or not campaign.success then
  local err_msg = campaign and campaign.error or "no response from server"
  log("ERR", "Campaign start failed: " .. err_msg)
  speak("There was a problem starting your notification. Please contact your administrator or try again.")
  session:hangup("NORMAL_CLEARING")
  return
end

local destinations = campaign.total_destinations or 0
log("INFO", "Campaign started: id=" .. tostring(campaign.campaign_id) ..
    " destinations=" .. tostring(destinations))

-- 5. Confirmation and disconnect
local confirm_msg
if destinations == 0 then
  confirm_msg = "Your emergency notification has been registered. No contacts are currently configured."
elseif destinations == 1 then
  confirm_msg = "Your emergency notification has been sent to 1 contact."
else
  confirm_msg = string.format("Your emergency notification has been sent to %d contacts.", destinations)
end

speak(confirm_msg .. " Thank you.")
session:sleep(600)

session:hangup("NORMAL_CLEARING")
