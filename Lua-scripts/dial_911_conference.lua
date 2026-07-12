-- =============================================================================
-- dial_911_conference.lua
-- ERS Emergency Response System — Conference Bridge Handler
-- =============================================================================
--
-- Flow:
--   1. Lookup full ERS configuration from API (bridges, tiers, queue, auth)
--   2. Determine slot: Bridge 1 (primary) or Bridge 2 (secondary)
--   3. If a bridge is free:
--      a. Create incident record via API
--      b. Join caller into conference room
--      c. Invite tier responders (background originate)
--      d. Start recording if configured
--   4. If both bridges busy and queue enabled:
--      a. Create QUEUED incident
--      b. Play queue announcement + hold music loop
--      c. Poll status API every 3 s
--      d. Join conference when dequeued → invite tier responders
--   5. After caller leaves: complete incident via API
--
-- Dialplan example:
--   <extension name="ers_1222">
--     <condition field="destination_number" expression="^(1222)$">
--       <action application="lua" data="dial_911_conference.lua"/>
--     </condition>
--   </extension>
-- =============================================================================

local API_BASE      = os.getenv("ENRS_INTERNAL_API") or "http://127.0.0.1:4100/api/v1/internal"
local API_KEY       = os.getenv("FS_INTERNAL_KEY")   or ""
local REC_DIR       = os.getenv("ENRS_ERS_REC_DIR")  or "/opt/freeswitch/recordings/ers"
local TTS_ENGINE    = os.getenv("ENRS_TTS_ENGINE")   or "flite"
local TTS_VOICE     = os.getenv("ENRS_TTS_VOICE")    or "slt"
local HTTP_TIMEOUT  = 8
local POLL_MS       = 3000      -- queue poll interval in milliseconds
local RETRY_RING_S  = 30        -- default seconds between retry rings

local json_ok, json = pcall(require, "cjson")
if not json_ok then json = nil end

local function log(level, msg)
  freeswitch.consoleLog(level or "INFO", "[ERS_CONF] " .. tostring(msg) .. "\n")
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

local function http_patch(path, payload)
  local body = json and json.encode(payload) or "{}"
  local safe = body:gsub("'", "'\\''")
  local cmd  = string.format(
    "curl -sf -m %d -X PATCH -H 'Content-Type: application/json' -H 'X-Internal-Key: %s' -d '%s' '%s%s' 2>/dev/null",
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

-- Originate outbound call to a responder and bridge them into the conference.
-- Non-blocking: uses bgapi so this returns immediately.
local function invite_responder(number, conf_room, conf_profile, incident_uuid, gateway)
  local gw      = gateway or "sofia/gateway/primary"
  local profile  = conf_profile or "default"
  local dialstr  = string.format(
    "bgapi originate {ignore_early_media=true,call_timeout=30,origination_caller_id_number=ERS-RESP}%s/%s &conference(%s@%s)",
    gw, number, conf_room, profile
  )
  log("INFO", "Inviting " .. number .. " → " .. conf_room)
  session:execute(dialstr)

  -- Log the invitation to the API (best-effort — don't block on failure)
  http_patch("/ers/incidents/" .. incident_uuid .. "/responder", {
    responder_number = number,
    status           = "INVITED",
    joined_via       = "ORIGINATE",
    joined_at        = os.date("!%Y-%m-%dT%H:%M:%SZ"),
  })
end

local function invite_tier(responders, conf_room, conf_profile, incident_uuid, cfg)
  if not responders or #responders == 0 then
    log("WARN", "No responders configured for " .. conf_room)
    return
  end
  local gw = cfg and cfg.sip_gateway or nil
  for _, number in ipairs(responders) do
    invite_responder(number, conf_room, conf_profile, incident_uuid, gw)
  end
  log("INFO", "Invited " .. #responders .. " responders to " .. conf_room)
end

-- ── Main ──────────────────────────────────────────────────────────────────────

local dest        = session:getVariable("destination_number") or ""
local caller      = session:getVariable("caller_id_number")   or ""
local caller_name = session:getVariable("caller_id_name")     or ""

log("INFO", "ERS call: dest=" .. dest .. " caller=" .. caller)

-- 1. Lookup full ERS configuration from backend
--    Lua never has hardcoded logic — all decisions come from API response
local lookup = http_get("/ers/lookup?number=" .. url_encode(dest))

if not lookup or not lookup.success then
  log("ERR", "ERS lookup failed for number: " .. dest)
  session:answer()
  speak("The emergency response system is not configured for this number. Please dial 9-1-1 for life-threatening emergencies.")
  session:sleep(500)
  session:hangup("UNALLOCATED_NUMBER")
  return
end

local cfg = lookup.data
log("INFO", "ERS config loaded: id=" .. tostring(cfg.configuration_id) ..
    " name=" .. tostring(cfg.name) ..
    " slot=" .. tostring(cfg.slot) ..
    " can_accept=" .. tostring(cfg.can_accept))

session:answer()
session:sleep(400)

-- 2. Determine conference room, responders, and retry settings based on slot
local conf_room, responders, tier_retry_count, tier_retry_interval_sec

if cfg.slot == 1 then
  -- Use configured bridge number (e.g. 7000) as room name so participants
  -- can dial that extension to rejoin. Falls back to legacy name if not set.
  if cfg.primary_bridge_number and tostring(cfg.primary_bridge_number) ~= "" then
    conf_room = tostring(cfg.primary_bridge_number)
  else
    conf_room = string.format("ers_cfg%d_primary", cfg.configuration_id)
  end
  responders             = cfg.primary_responders or {}
  tier_retry_count       = cfg.primary_retry_count or 3
  tier_retry_interval_sec = cfg.primary_retry_interval_sec or RETRY_RING_S
  log("INFO", "Slot 1 — primary bridge room=" .. conf_room .. " responders=" .. #responders)
elseif cfg.slot == 2 then
  if cfg.secondary_bridge_number and tostring(cfg.secondary_bridge_number) ~= "" then
    conf_room = tostring(cfg.secondary_bridge_number)
  else
    conf_room = string.format("ers_cfg%d_secondary", cfg.configuration_id)
  end
  responders             = cfg.secondary_responders or {}
  tier_retry_count       = cfg.secondary_retry_count or 3
  tier_retry_interval_sec = cfg.secondary_retry_interval_sec or RETRY_RING_S
  log("INFO", "Slot 2 — secondary bridge room=" .. conf_room .. " responders=" .. #responders)
else
  -- Will be queued — use primary bridge number as placeholder (backend will
  -- assign the real room when the call is promoted from the queue)
  if cfg.primary_bridge_number and tostring(cfg.primary_bridge_number) ~= "" then
    conf_room = tostring(cfg.primary_bridge_number)
  else
    conf_room = string.format("ers_cfg%d_primary", cfg.configuration_id)
  end
  responders             = {}
  tier_retry_count       = cfg.primary_retry_count or 3
  tier_retry_interval_sec = cfg.primary_retry_interval_sec or RETRY_RING_S
  log("INFO", "Slot " .. cfg.slot .. " — will be queued, room=" .. conf_room)
end

local conf_profile = cfg.conference_profile or "default"
local is_queued    = not cfg.can_accept

-- 3. Create the incident record in the database
local incident_resp = http_post("/ers/incidents", {
  configuration_id = cfg.configuration_id,
  caller_number    = caller,
  caller_name      = caller_name ~= "" and caller_name or nil,
  conference_room  = conf_room,
  group_type       = (cfg.slot == 1) and "primary" or "secondary",
  recording_path   = nil,
  status           = is_queued and "QUEUED" or "ACTIVE",
})

if not incident_resp then
  log("ERR", "Failed to create ERS incident — API unreachable")
  speak("Emergency response system is temporarily unavailable. Please dial 9-1-1 for life-threatening emergencies.")
  session:hangup("SERVICE_UNAVAILABLE")
  return
end

local incident_uuid = incident_resp.incident_uuid or ""
log("INFO", "Incident created: uuid=" .. incident_uuid .. " queued=" .. tostring(is_queued))

-- 4. QUEUED path: play hold and poll until dequeued
if is_queued then
  if not cfg.queue_enabled then
    speak("All emergency response bridges are currently active and queue is disabled. Please call back shortly.")
    session:hangup("USER_BUSY")
    return
  end

  log("INFO", "Entering queue for incident " .. incident_uuid)

  -- Play queue announcement
  local q_audio    = cfg.queue_announcement_audio or ""
  local q_music    = cfg.queue_music_path or ""
  local q_timeout  = cfg.queue_timeout_sec or 0
  local wait_start = os.time()

  if q_audio ~= "" then
    session:streamFile(q_audio)
  else
    speak("All emergency response bridges are currently active. You are number " ..
          tostring(cfg.slot - cfg.max_concurrent_conferences) ..
          " in queue. Please remain on the line and do not hang up.")
  end

  -- Hold music + status polling loop
  while session:ready() do
    if q_timeout > 0 and (os.time() - wait_start) >= q_timeout then
      log("WARN", "Queue timeout (" .. q_timeout .. "s) reached for " .. incident_uuid)
      speak("You have been in queue longer than the maximum wait time. Goodbye.")
      session:hangup("NORMAL_CLEARING")
      return
    end

    -- Play hold music (a segment at a time) or sleep
    if q_music ~= "" then
      if session:ready() then session:execute("playback", q_music) end
    else
      session:sleep(POLL_MS)
    end

    -- Poll incident status
    local status_resp = http_get("/ers/incidents/" .. incident_uuid .. "/status")
    if status_resp then
      if status_resp.status == "ACTIVE" then
        -- We've been promoted out of queue
        conf_room  = status_resp.conference_room or conf_room
        log("INFO", "Dequeued → joining conference " .. conf_room)
        break
      elseif status_resp.status == "COMPLETED" then
        speak("The emergency has been resolved. Goodbye.")
        session:hangup("NORMAL_CLEARING")
        return
      end
    end
  end

  if not session:ready() then
    log("INFO", "Caller hung up while queued: " .. incident_uuid)
    return
  end

  -- When dequeued, invite primary responders to this caller's conference
  speak("An emergency bridge is now available. Connecting you now.")
  session:sleep(300)
  invite_tier(cfg.primary_responders or {}, conf_room, conf_profile, incident_uuid, cfg)
end

-- 5. ACTIVE path: join conference, invite responders, start recording

-- Start recording first (before conference join, so we capture everything)
local rec_path = nil
if cfg.record_conferences then
  local rec_dir = (cfg.recording_directory ~= "" and cfg.recording_directory) or REC_DIR
  local date_str = os.date("%Y-%m-%d")
  rec_path = string.format("%s/ers_%s_%s.wav", rec_dir, conf_room, date_str)
  session:execute("record_session", rec_path)
  log("INFO", "Recording to: " .. rec_path)
end

-- Invite tier responders (non-blocking)
if not is_queued and #responders > 0 then
  invite_tier(responders, conf_room, conf_profile, incident_uuid, cfg)
end

-- Announce before bridging
speak("Connecting to emergency response. Responders are being contacted. Please stay on the line.")
session:sleep(300)

-- Apply max duration limit if set
if cfg.max_conference_duration_min and cfg.max_conference_duration_min > 0 then
  session:execute("set", "conference_max_duration=" .. tostring(cfg.max_conference_duration_min * 60))
end

-- Join the conference — caller stays here until they disconnect
log("INFO", "Entering conference: " .. conf_room .. "@" .. conf_profile)
session:execute("conference", conf_room .. "@" .. conf_profile)

-- 6. Caller left the conference — complete incident
log("INFO", "Caller disconnected from conference " .. conf_room)

http_post("/ers/incidents/" .. incident_uuid .. "/complete", {
  recording_file = rec_path or nil,
})

log("INFO", "ERS incident " .. incident_uuid .. " completed")
session:hangup("NORMAL_CLEARING")
