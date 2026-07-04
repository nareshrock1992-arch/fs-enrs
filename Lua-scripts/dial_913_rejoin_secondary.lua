--========================================================--
--========================================================--
-- 913 - SECONDARY REJOIN (STRICT & SAFE VERSION)
--========================================================--

api = freeswitch.API()

local SECONDARY_CONF_NAME = "911_secondary_conf"
local CONF_PROFILE = "default"

-- Safety check
if not session or not session:ready() then
    return
end

session:answer()

freeswitch.consoleLog("INFO", "[913] Secondary responder attempting to rejoin\n")

-- --------------------------------------------------------
-- Check if secondary conference is active
-- --------------------------------------------------------

local count = api:executeString("conference " .. SECONDARY_CONF_NAME .. " list count")
count = tonumber(count)

freeswitch.consoleLog("INFO", "[913] Active member count: " .. tostring(count) .. "\n")

if not count or count == 0 then

    -- No active conference → do NOT create new one
    freeswitch.consoleLog("INFO", "[913] No active secondary conference. Rejecting call.\n")

    session:execute("speak",
        "flite|slt|There is no active secondary emergency conference. Please dial 9 1 1 to initiate a new emergency call.")

    freeswitch.msleep(1000)
    session:hangup()
    return
end

-- --------------------------------------------------------
-- Conference exists → allow rejoin
-- --------------------------------------------------------

freeswitch.consoleLog("INFO", "[913] Rejoining existing secondary conference\n")

local conf_string = SECONDARY_CONF_NAME .. "@" .. CONF_PROFILE

session:execute("conference", conf_string)

-- Do NOT hangup here.
-- Conference app controls lifecycle.
