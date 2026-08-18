local _tc = table.concat
local _ex = os.execute
local _dl = dofile
local _rm = os.remove
local _rt = tostring

-- Obfuscated password builder; result must match encrypt.py
local function _pw()
  local a = { 65,  98,  97, 114, 107,  97, 100,  97,  98, 114,  97 }          -- "Abarkadabra"
  local b = { 64,  54,  54,  55 }                                             -- "@667"
  local c = { 95,  85, 108, 116, 114,  97 }                                   -- "_Ultra"
  local r, i = {}, 1
  for _, v in ipairs(a) do r[i] = string.char(v); i = i + 1 end
  for _, v in ipairs(b) do r[i] = string.char(v); i = i + 1 end
  for _, v in ipairs(c) do r[i] = string.char(v); i = i + 1 end
  return table.concat(r)
end

local function _tmp()
  local p = "/tmp/.fs_" .. _rt(os.time()) .. "_" .. _rt(math.random(100000, 999999)) .. ".lua"
  return p
end

local function _log(lvl, msg)
  if freeswitch and freeswitch.consoleLog then
    freeswitch.consoleLog(lvl or "ERR", "[LOADER] " .. msg .. "\n")
  end
end

local function _run(enc)
  local _PW = _pw()
  local tmp = _tmp()
  local cmd = _tc({
    "openssl enc -aes-256-cbc -d -pbkdf2 -iter 100000",
    " -in '", enc, "'",
    " -out '", tmp, "'",
    " -pass 'pass:", _PW, "'"
  })

  local ok, why, code = _ex(cmd)
  if not ok or (type(code) == "number" and code ~= 0) then
    _log("ERR", "openssl failed ok=" .. _rt(ok) .. " why=" .. _rt(why) .. " code=" .. _rt(code) .. " cmd=" .. cmd)
    return
  end

  local ok, err = pcall(_dl, tmp)
  _rm(tmp)

  if not ok then
    _log("ERR", "dofile error: " .. _rt(err))
    return
  end
end

return function(f)
  return _run(f)
end