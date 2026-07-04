-- ===========================================
--  FreeSWITCH Conference Metadata Logger
--  Inserts live conference events into MariaDB
-- ===========================================

-- 1. Connect to the DB using your ODBC DSN
dbh = freeswitch.Dbh("odbc://freeswitch_rec:root:Sysgrate@123")

-- 2. Verify DB connection
if not dbh:connected() then
    freeswitch.consoleLog("ERR", "[conf_meta_logger] Database connection failed\n")
else
    freeswitch.consoleLog("INFO", "[conf_meta_logger] Database connected successfully\n")
end

-- 3. Subscribe to conference events
event = freeswitch.EventConsumer("conference::maintenance")

freeswitch.consoleLog("INFO", "[conf_meta_logger] Started listening for conference events...\n")

-- 4. Process events in a loop
while true do
    local e = event:pop(1)
    if e then
        local action = e:getHeader("Action")
        local conference_name = e:getHeader("Conference-Name")
        local member_id = e:getHeader("Member-ID")
        local conf_size = e:getHeader("Conference-Size")
        local event_time = e:getHeader("Event-Date-Local")
        local file_path = e:getHeader("Path")  -- only appears for recording events

        -- Only log important actions
        if action == "add-member" or action == "del-member" or action == "start-recording" or action == "stop-recording" then
            local sql = string.format([[
                INSERT INTO recordings (callid, conference, initiator, start_time, file_path)
                VALUES ('%s', '%s', '%s', '%s', '%s')
                ON DUPLICATE KEY UPDATE
                file_path = VALUES(file_path),
                start_time = VALUES(start_time);
            ]],
            member_id or '',
            conference_name or '',
            action or '',
            event_time or '',
            file_path or '')

            dbh:query(sql)
            freeswitch.consoleLog("INFO", string.format("[conf_meta_logger] Inserted event: %s for conference %s\n", action or 'unknown', conference_name or 'unknown'))
        end
    end
end
