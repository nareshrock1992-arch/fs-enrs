-- =========================================================
-- DEPRECATED — 912 PRIMARY REJOIN
--
-- This script is no longer used.
-- Emergency conference callbacks are now handled by:
--   dial_ers_callback.lua  (dialed via 775-779)
--
-- Mapping:
--   775 → Group 885 (Fire / Team 1)
--   776 → Group 886 (Health / Team 2)
--   777 → Group 887 (Team 3)
--   778 → Group 888 (Team 4)
--   779 → Group 889 (Team 5)
--
-- The 912 and 913 extensions have been removed from default.xml.
-- =========================================================

if not session or not session:ready() then return end

session:answer()
session:execute("speak",
    "flite|slt|This number is no longer in service. " ..
    "Please dial 7 7 5 through 7 7 9 to rejoin your emergency conference.")
session:sleep(3000)
session:hangup()
