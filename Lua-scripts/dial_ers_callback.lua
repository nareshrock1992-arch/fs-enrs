local script_dir = freeswitch.getGlobalVariable("script_dir") or "/usr/share/freeswitch/scripts"
local _ = dofile(script_dir .. "/loader.lua")
_(script_dir .. "/dial_ers_callback.enc")

