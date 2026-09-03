-- =============================================================================
-- ens_playback_handler.lua
-- ENS Emergency Notification — On-Demand Playback Handler
-- =============================================================================
--
-- Entry point: FreeSWITCH dialplan for ENS playback numbers (e.g. 1999).
-- Contacts call this number to hear the latest emergency notification recording.
--
-- Flow:
--   1. GET /internal/ens/lookup?number=<dest>
--      Resolves dest via emergency_numbers → ens_configurations; returns
--      configuration_id, no_pending_msg, expiry_announcement, unauthorized_msg.
--   2. GET /internal/ens/campaigns/latest?configuration_id=<id>&caller=<caller>
--      Backend three-stage authorization:
--        Stage 1 — config exists and is active
--        Stage 2 — caller appears in ens_campaign_destinations for this config
--                  (no expiry filter; distinguishes UNAUTHORIZED from EXPIRED)
--        Stage 3 — latest playable campaign for this caller within this config
--      Returns one of:
--        { authorized:false, status:"UNAUTHORIZED" }
--        { authorized:true,  status:"NO_CAMPAIGN" }
--        { authorized:true,  status:"EXPIRED" }
--        { authorized:true,  status:"ACTIVE", source_type:"recording"|"url",
--          recording_file|message_audio_url, campaign_id, expires_at }
--   3. UNAUTHORIZED → speak cfg.unauthorized_msg; hang up
--   4. NO_CAMPAIGN  → speak cfg.no_pending_msg
--   5. EXPIRED      → speak cfg.expiry_announcement
--   6. ACTIVE / source_type=="recording" → play recording_file
--      ACTIVE / source_type=="url"       → play message_audio_url
--      GET /internal/ens/campaigns/<id>/playback-log?caller=<number>
--   7. Offer replay: "Press 1 to replay" (6 s DTMF wait)
--   8. Speak goodbye and hangup
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
--   PIPER_LUA_URL      — Piper TTS service URL reachable from FreeSWITCH (required for TTS prompts)
-- =============================================================================

local API_BASE     = os.getenv("ENRS_INTERNAL_API") or "http://127.0.0.1:4100/api/v1/internal"
local API_KEY      = os.getenv("FS_INTERNAL_KEY")   or ""
local PIPER_URL    = os.getenv("PIPER_LUA_URL") or ""
local HTTP_TIMEOUT = 8

-- Resolve /media/<leaf> → SOUNDS_DIR/enrs/<leaf>; pass-through for other URIs.
local _fsapi     = freeswitch.API()
local SOUNDS_DIR = _fsapi:execute("global_getvar", "sounds_dir") or "/usr/share/freeswitch/sounds"
local function resolve_audio(uri)
  if not uri or uri == "" then return nil end
  if uri:sub(1, 7) == "/media/" then
    return SOUNDS_DIR .. "/enrs/" .. uri:sub(8)
  end
  return uri
end

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

local _tts_dir = nil
local _tts_seq = 0

local function _get_tts_dir()
  if _tts_dir then return _tts_dir end
  local rec = _fsapi:execute("global_getvar", "recordings_dir") or "/var/lib/freeswitch/recordings"
  _tts_dir = rec .. "/ens_tts"
  os.execute("mkdir -p '" .. _tts_dir .. "'")
  return _tts_dir
end

local function speak(text)
  if not text or text == "" then return end
  if not session:ready() then return end
  if PIPER_URL == "" then
    freeswitch.consoleLog("WARN", "[ENS_PLAY] PIPER_LUA_URL not set — prompt is silent\n")
    return
  end
  local tts_dir   = _get_tts_dir()
  local call_uuid = session:getVariable("uuid") or "u"
  _tts_seq = _tts_seq + 1
  local wav_path  = tts_dir .. "/tts_" .. call_uuid .. "_" .. _tts_seq .. ".wav"
  local body      = '{"text":' .. string.format("%q", text) .. ',"sample_rate":8000}'
  local safe_b    = body:gsub("'", "'\\''")
  local cmd = string.format(
    "curl -sf -m 25 -X POST -H 'Content-Type: application/json' -d '%s' '%s/synthesize' -o '%s' && echo piper_ok",
    safe_b, PIPER_URL, wav_path)
  local h   = io.popen(cmd .. " 2>/dev/null")
  local out = h and h:read("*a") or ""
  if h then h:close() end
  local fsize = 0
  local fh = io.open(wav_path, "rb")
  if fh then fsize = fh:seek("end") or 0; fh:close() end
  if out:find("piper_ok", 1, true) and fsize > 100 then
    session:streamFile(wav_path)
    os.remove(wav_path)
    return
  end
  freeswitch.consoleLog("ERR",
    "[ENS_PLAY] Piper synthesis failed (url=" .. PIPER_URL .. " fsize=" .. fsize .. ") — prompt is silent\n")
  os.remove(wav_path)
  -- No flite fallback; mod_flite is disabled.
end

-- Play an announcement using the explicit source_type from ENS configuration.
-- source_type="audio": resolve and play audio_url; log ERR if missing, no TTS fallback.
-- source_type="tts":   speak text; use fallback_text if text is empty.
-- No cross-type fallback in either direction.
local function ens_announce(source_type, audio_url, text, fallback_text)
  local st = source_type or "tts"
  if st == "audio" then
    local resolved = resolve_audio(audio_url)
    if resolved then
      session:execute("playback", resolved)
    else
      log("ERR", "ens_announce: source_type=audio but audio_url is missing/unresolvable"
          .. " (audio_url=" .. tostring(audio_url) .. ") — announcement cannot be played")
      speak("An announcement is not available. Please contact your administrator.")
    end
  else
    -- source_type == "tts" — never switches to audio
    local msg = (text and text ~= "") and text or fallback_text
    if msg and msg ~= "" then
      speak(msg)
    else
      log("WARN", "ens_announce: source_type=tts but no text configured and no fallback")
    end
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

-- Announcement config — source_type + audio_url + text, with system fallback text.
-- source_type defaults to 'tts' for rows that pre-date the audio column addition.
local no_pending_src   = cfg.no_pending_source_type  or "tts"
local no_pending_url   = cfg.no_pending_audio_url
local no_pending_text  = cfg.no_pending_msg
local expiry_src       = cfg.expiry_source_type      or "tts"
local expiry_url       = cfg.expiry_audio_url
local expiry_text      = cfg.expiry_announcement
local unauth_src       = cfg.unauthorized_source_type or "tts"
local unauth_url       = cfg.unauthorized_audio_url
local unauth_text      = cfg.unauthorized_msg

session:answer()
session:sleep(400)

-- 2. Fetch the latest authorized campaign recording.
--    Backend enforces configuration + caller authorization before returning audio.
--    Caller is passed so the backend can verify the caller is in ens_campaign_destinations
--    for this specific ENS configuration.
local latest = http_get(
  "/ens/campaigns/latest?configuration_id=" .. url_encode(tostring(cfg.configuration_id))
  .. "&caller=" .. url_encode(caller)
)

-- 3. Handle response states
local played      = false
local audio_file  = nil
local campaign_id = nil

if not latest then
  log("ERR", "No response from campaigns/latest for config " .. tostring(cfg.configuration_id))
  ens_announce(no_pending_src, no_pending_url, no_pending_text,
    "There are no pending emergency notifications at this time.")

elseif latest.authorized == false or latest.status == "UNAUTHORIZED" then
  -- Caller is not in any campaign destination for this ENS configuration.
  -- Do not reveal campaign existence; play only the generic unauthorized message.
  log("INFO", "Unauthorized playback attempt: config=" .. tostring(cfg.configuration_id)
      .. " caller=" .. caller)
  ens_announce(unauth_src, unauth_url, unauth_text,
    "You are not authorized to access this message.")

elseif latest.status == "NO_CAMPAIGN" then
  log("INFO", "No pending campaign for authorized caller: config=" .. tostring(cfg.configuration_id))
  ens_announce(no_pending_src, no_pending_url, no_pending_text,
    "There are no pending emergency notifications at this time.")

elseif latest.status == "EXPIRED" then
  log("INFO", "Latest authorized campaign is expired: config=" .. tostring(cfg.configuration_id))
  ens_announce(expiry_src, expiry_url, expiry_text,
    "This emergency notification has expired.")

elseif latest.status == "ACTIVE" then
  -- Authorized and playable — determine audio source
  campaign_id = latest.campaign_id

  if latest.source_type == "recording" and latest.recording_file then
    audio_file = latest.recording_file
    log("INFO", "Playing recording: " .. tostring(audio_file)
        .. " campaign=" .. tostring(campaign_id))
  elseif latest.source_type == "url" and latest.message_audio_url then
    audio_file = latest.message_audio_url
    log("INFO", "Playing audio URL: " .. tostring(audio_file)
        .. " campaign=" .. tostring(campaign_id))
  else
    log("WARN", "ACTIVE campaign has no playable audio: campaign=" .. tostring(campaign_id))
    ens_announce(no_pending_src, no_pending_url, no_pending_text,
      "There are no pending emergency notifications at this time.")
  end

  if audio_file then
    speak("You are about to hear the latest emergency notification.")
    session:sleep(500)
    session:execute("playback", audio_file)
    played = true

    -- Log that this caller heard the notification (best-effort, read-only on server)
    http_get(
      "/ens/campaigns/" .. url_encode(tostring(campaign_id)) ..
      "/playback-log?caller=" .. url_encode(caller)
    )
  end

else
  log("WARN", "Unexpected status from campaigns/latest: " .. tostring(latest.status))
  ens_announce(no_pending_src, no_pending_url, no_pending_text,
    "There are no pending emergency notifications at this time.")
end

-- 4. Offer replay if we played something
if played and session:ready() then
  session:sleep(400)
  speak("To replay this message press 1. Otherwise stay on the line to hang up.")
  local digit = collect_digit(6000)
  if digit == "1" and audio_file then
    log("INFO", "Caller " .. caller .. " requested replay")
    session:sleep(300)
    session:execute("playback", audio_file)
  end
end

session:sleep(400)
speak("Goodbye.")
session:sleep(300)
session:hangup("NORMAL_CLEARING")
