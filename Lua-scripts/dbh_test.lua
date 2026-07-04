-- Test MySQL connection with DBH
dbh = freeswitch.Dbh("mysql://freeswitch_user:your_password@localhost/freeswitch_db")

if dbh:connected() then
    freeswitch.consoleLog("INFO", "✅ Connected to MySQL successfully!\n")
else
    freeswitch.consoleLog("ERR", "❌ Failed to connect to MySQL!\n")
end
