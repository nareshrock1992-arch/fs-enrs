-- =============================================================================
-- ens_playback_handler.lua
-- ENS Emergency Notification — On-Demand Playback Handler
-- =============================================================================
--
-- Entry point: FreeSWITCH dialplan for ENS playback numbers (e.g. 1999).
-- Contacts call this number to hear the latest emergency notification recording.
--
-- Flow:
--   1. GET /internal/ens/lookup?number=<dest> — fetch ENS config
--   2. GET /internal/ens/campaigns/latest?configuration_id=<id>
--      Returns: recording_file + status (NO_CAMPAIGN / EXPIRED / active)
--   3. NO_CAMPAIGN or no recording_file → speak cfg.no_pending_msg
--   4. EXPIRED → speak cfg.expiry_announcement
--   5. Active → speak intro, play recording_file, log playback
--      GET /internal/ens/campaigns/<id>/playback-log?caller=<number>
--   6. Offer replay: "Press 1 to replay" (6 s DTMF wait)
--   7. Speak goodbye and hangup
--
-- Dialplan example:
--   <extension name="ens_playback_1999">
--     <condition field="destination_number" expression="^(1999)$">
--       <action application="answer"/>
--       <action application="lua" data="ens_playback_handler.lua"/>
--     </condition>
--   </extension>
--
-- Environment variables (set in /etc/freeswitch/vars.xml or shell):
--   ENRS_INTERNAL_API  — backend base URL (default: http://127.0.0.1:4100/api/v1/internal)
--   FS_INTERNAL_KEY    — X-Internal-Key header value (required)
--   ENRS_TTS_ENGINE    — TTS engine (default: flite)
--   ENRS_TTS_VOICE     — TTS voice (default: slt)
-- =============================================================================

local API_BASE     = os.getenv("ENRS_INTERNAL_API") or "http://127.0.0.1:4100/api/v1/internal"
local API_KEY      = os.getenv("FS_INTERNAL_KEY")   or ""
local TTS_ENGINE   = os.getenv("ENRS_TTS_ENGINE")   or "flite"
local TTS_VOICE    = os.getenv("ENRS_TTS_VOICE")    or "slt"
local HTTP_TIMEOUT = 8

local json_ok, json = pcall(require, "cjson")
if not json_ok then json = nil end

local function log(level, msg)
  freeswitch.consoleLog(level or "INFO", "[ENS_PLAY] " .. tostring(msg) .. "\n")
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

local function speak(text)
  if text and text ~= "" and session:ready() then
    session:execute("speak", TTS_ENGINE .. "|" .. TTS_VOICE .. "|" .. text)
  end
end

local function collect_digit(timeout_ms)
  session:execute("read", string.format("0 1 %s noname %d #", "", timeout_ms or 5000))
  return session:getVariable("read_result") or ""
end

-- ── Main ──────────────────────────────────────────────────────────────────────

local dest   = session:getVariable("destination_number") or ""
local caller = session:getVariable("caller_id_number")   or ""

log("INFO", "ENS playback: dest=" .. dest .. " caller=" .. caller)

-- 1. Lookup ENS configuration for this playback number
local lookup = http_get("/ens/lookup?number=" .. url_encode(dest))

if not lookup or not lookup.success then
  log("ERR", "ENS lookup failed for playback number: " .. dest)
  session:answer()
  speak("This playback number is not configured. Please contact your system administrator.")
  session:sleep(500)
  session:hangup("UNALLOCATED_NUMBER")
  return
end

local cfg = lookup.data
log("INFO", "ENS playback config: id=" .. tostring(cfg.configuration_id) ..
    " name=" .. tostring(cfg.name))

-- Default messages (overridden by config values if set)
local no_pending_msg = (cfg.no_pending_msg and cfg.no_pending_msg ~= "")
                       and cfg.no_pending_msg
                       or  "There are no pending emergency notifications at this time."
local expiry_msg     = (cfg.expiry_announcement and cfg.expiry_announcement ~= "")
                       and cfg.expiry_announcement
                       or  "This emergency notification has expired."

session:answer()
session:sleep(400)

-- 2. Fetch the latest campaign recording.
--    Backend resolves: is there an active/recent campaign? Is the recording within
--    the retention window? Returns recording_file path + status.
local latest = http_get(
  "/ens/campaigns/latest?configuration_id=" .. url_encode(tostring(cfg.configuration_id))
)

-- 3. Handle response states
local played      = false
local rec_file    = nil
local campaign_id = nil

if not latest or not latest.success then
  log("WARN", "No campaign data returned for config " .. tostring(cfg.configuration_id))
  speak(no_pending_msg)

elseif latest.status == "NO_CAMPAIGN" or not latest.recording_file then
  log("INFO", "No pending campaign for config " .. tostring(cfg.configuration_id))
  speak(no_pending_msg)

elseif latest.status == "EXPIRED" then
  log("INFO", "Latest campaign is expired: " .. tostring(latest.campaign_id))
  speak(expiry_msg)

else
  -- Active recording found — play it
  rec_file    = latest.recording_file
  campaign_id = latest.campaign_id
  log("INFO", "Playing recording: " .. tostring(rec_file) ..
      " campaign=" .. tostring(campaign_id))

  speak("You are about to hear the latest emergency notification.")
  session:sleep(500)
  session:execute("playback", rec_file)
  played = true

  -- Log that this caller heard the notification (best-effort)
  http_get(
    "/ens/campaigns/" .. url_encode(tostring(campaign_id)) ..
    "/playback-log?caller=" .. url_encode(caller)
  )
end

-- 4. Offer replay if we played something
if played and session:ready() then
  session:sleep(400)
  speak("To replay this message press 1. Otherwise stay on the line to hang up.")
  local digit = collect_digit(6000)
  if digit == "1" and rec_file then
    log("INFO", "Caller " .. caller .. " requested replay")
    session:sleep(300)
    session:execute("playback", rec_file)
  end
end

session:sleep(400)
speak("Goodbye.")
session:sleep(300)
session:hangup("NORMAL_CLEARING")
