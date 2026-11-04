// Channel variables an IVR flow must not write.
//
// Only variables that make SIPCommunication EXECUTE something later in the call are
// protected (api_hangup_hook=system ..., execute_on_answer=..., exec_after_bridge_app,
// bridge_pre_execute_*), plus the call UUID, which the executor puts into file paths on a
// shell command line. A flow author, a caller's digits, or an external API response mapped
// into a variable must not be able to set them.
//
// Deliberately NOT protected (zero-regression rule): identity and call-control variables
// such as destination_number, caller_id_number, effective_caller_id_*, origination_*,
// hangup_after_bridge, transfer_after_bridge, conference_* — flows may set these for
// legitimate reasons. Cross-tenant misuse of destination_number is refused by the
// backend instead (ENS lookup tenant check), which leaves same-tenant behaviour unchanged.
//
// The same rule is generated into the Lua executor (luaGenerator.js) so flows that were
// published before this check keep the protection at call time.

export const PROTECTED_VAR_NAMES = [
  'uuid', 'call_uuid',
  'api_hangup_hook', 'api_reporting_hook', 'api_after_bridge',
  'exec_after_bridge_app', 'exec_after_bridge_arg',
];

// Prefixes of variables whose value SIPCommunication runs as an API command or application.
export const PROTECTED_VAR_PREFIXES = ['api_on_', 'execute_on_', 'bridge_pre_execute_'];

export function isProtectedVarName(name) {
  const n = String(name || '').toLowerCase();
  if (PROTECTED_VAR_NAMES.includes(n)) return true;
  return PROTECTED_VAR_PREFIXES.some((p) => n.startsWith(p));
}

// Lua source for the same rule, embedded in the generated executor.
export function protectedVarsLua() {
  const list = (a) => a.map((s) => `"${s}"`).join(', ');
  return [
    `local PROTECTED_VAR_NAMES = {}`,
    `for _, n in ipairs({ ${list(PROTECTED_VAR_NAMES)} }) do PROTECTED_VAR_NAMES[n] = true end`,
    `local PROTECTED_VAR_PREFIXES = { ${list(PROTECTED_VAR_PREFIXES)} }`,
    `local function is_protected_var(name)`,
    `  local n = string.lower(tostring(name or ""))`,
    `  if PROTECTED_VAR_NAMES[n] then return true end`,
    `  for _, p in ipairs(PROTECTED_VAR_PREFIXES) do if n:sub(1, #p) == p then return true end end`,
    `  return false`,
    `end`,
  ].join('\n');
}
