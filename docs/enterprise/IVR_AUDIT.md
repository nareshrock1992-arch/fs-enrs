# IVR Audit

Cycle 2 (2026-11-02) read the validator, generators and REST proxy. Cycle 3 (same date) read **all 21 node
handlers in `nodeTypes/registry.js` line by line**, the generated executor (`utils/luaGenerator.js`), the save /
publish path (`controllers/ivrController.js`), the designer's validation display (`components/ivr/panels/*`),
the ENS start-by-config endpoint, the REST proxy and the ERS ring service. No call was placed; the executor was
run in the Fengari Lua harness with the session, HTTP and shell mocked.

## Fixed in Cycle 3

Revised on 2026-11-03 under the zero-regression requirement: each fix is now the narrowest one that closes the hole,
and existing flows keep their call-time behaviour except where noted. Details of what was rolled back are in
`BEHAVIOUR_CHANGES.md`.

| ID | Severity | Finding | Fix | Tests |
|---|---|---|---|---|
| IVR-14 | Critical | `webhook` put its URL on a shell command line **unescaped**: a quote in it, from a flow author or via `${caller_id_name}` from any caller, ran commands on the telephony host | The URL is escaped like the body already was and passed with `--url` (a value starting with `-` stays a URL). Same direct request, same host as before | `lua/executorSecurity` (shell-parses the command), `restApiNode` (original test, unchanged, passes) |
| IVR-13 | Critical | Any variable was writable, including ones the engine runs: `api_hangup_hook=system ...`, `execute_on_answer`, `exec_after_bridge_app`, `bridge_pre_execute_*`. Writing `uuid` reached the shell (TTS file paths) | Those names and `uuid` are refused at publish, dropped by the REST proxy, and skipped at call time (`set_var`). All other variables stay writable | `lua/executorSecurity` (incl. characterization of writable names), `ivrCycle3Boundaries` |
| IVR-16 | Critical | `transfer` offered `inline`, which runs arbitrary applications; the argument is split on spaces, so a variable value `1000 inline` injected it | New `inline` transfers refused at publish; existing ones still run (logged) unless the engine global `ENRS_IVR_BLOCK_INLINE_TRANSFER=true`. Cycle 4: at call time only a substituted value that adds a word to the destination is refused (author-written words such as `1001 XML public` work as before); at publish only `inline` as the destination's dialplan word is refused | `lua/executorSecurity`, `ivrCycle3Boundaries`, e2e S-33 |
| IVR-15 | High | A caller value such as `${system id}` reaching an engine argument was a second-stage command | Where text becomes an engine argument (transfer, built-in TTS, playback) the command form `${name args}` / `${name(args)}` is made inert. `interp` and plain `${var}` are unchanged | `lua/executorSecurity`, `sayVariableFallback` (original test, unchanged, passes) |
| IVR-12 | High | A flow could start another tenant's ENS blast: via `ens_config_var`, or by pointing `destination_number` at another tenant's ENS number before an ENS node | The executor sends the routed number (`ivr_number`, captured before any node runs). Start-by-config refuses (403) and ENS lookup answers "not found" (404) only when the two belong to different tenants. Same tenant, standalone scripts and older executors unchanged | e2e S-32, S-34, `ivrCycle3Boundaries` |
| IVR-6 | High | Credentials are server-wide and usable by any tenant | Optional `IVR_CRED_<NAME>_TENANT_IDS`; unscoped credentials keep working unless `IVR_CRED_REQUIRE_TENANT_SCOPE=true` | `ivrCycle3Boundaries` |
| IVR-7 | Medium | DNS checked before the request (rebinding) | Connect-time address check. Requests otherwise as before: fetch()'s default headers, gzip/deflate/br decoded, redirects followed (up to 5) with every new address checked and credential headers dropped on a host change; 10 MiB response cap | `ivrCycle3Boundaries` (real local sockets) |
| IVR-8 | Medium | A broken flow ends the call silently | **Default unchanged (hang up)**; the reason is now logged. Engine global `ENRS_FAILSAFE_ON_FLOW_ERROR=true` sends such calls to the existing failsafe instead | `lua/executorSecurity` (both modes) |
| IVR-17 | High | ERS ring-all put a caller number with no digits raw into the unquoted originate block (`x,execute_on_answer=...`) | A plain token (`anonymous`, `restricted`) still passes; anything else is left out | `ersOriginateInjection` |

## Fixed in Cycle 2 (still verified)

IVR-1 dialplan literal numbers, IVR-2 REST address rules, IVR-3 no redirects, IVR-4 `${api args}` refused, IVR-5 test
fixture. All their tests still pass.

## Compatibility

Nothing is rewritten in stored data. `node backend/scripts/ivr-compat-report.js` (read-only SELECTs) lists, for every
flow's draft and latest published version, what the new publish rules refuse, fixed REST URLs the proxy refuses,
ENS-from-variable and credential uses to review, and **service numbers whose dialplan meaning changed** with literal
matching (Cycle 2). **It has not been run against DEV.**

| Change | Next publish of a stored flow | Calls on an already-published flow (after Deploy) |
|---|---|---|
| Command-running variable / `uuid` write | Refused, field named | Write skipped and logged; the flow continues |
| `inline` transfer | Refused, field named | Runs as before (logged) unless `ENRS_IVR_BLOCK_INLINE_TRANSFER=true` |
| Whitespace in transfer destination/context | Refused | Refused (the call ends as on any node error) |
| `${name args}` anywhere | Refused (Cycle 2) | Made inert where it reaches an engine argument |
| Webhook | Unchanged | Same request; URL escaped |
| ENS across tenants | — | Refused (never legitimate) |
| Broken flow | — | Hangs up as before; failsafe opt-in |

The executor change reaches calls only when it is regenerated (Deploy).

## Open

| ID | Severity | Finding |
|---|---|---|
| IVR-9 | Medium | Validator FK checks turn a query failure into a warning (kept by the 2026-10-21 decision) |
| IVR-10 | Medium | The internal API key is on the curl command line, visible in the host's process list while a request runs |
| IVR-11 | Medium | No execution history (calls, nodes, digits, outcomes) is stored; no IVR report can be built |
| IVR-18 | Medium | `play` with a dynamic source plays whatever path a session variable holds; another tenant's recording could be played if its path were known. Paths include the call UUID, so guessing is impractical |
| IVR-19 | Low | The standalone scripts in `Lua-scripts/` (`ens_blast_trigger`, `ens_playback_handler`, `ers_conference_bridge`) were read for shell and originate sinks: escaping matches the executor's, and the originate name strips `' } \`. They still keep `$` and `{` in caller names. Not changed: they have no test harness and run outside the IVR designer |
| IVR-20 | Low | `npm run verify:lua` needs `luac5.2`, which is not installed here; Lua was compiled and run under Fengari (Lua 5.3) only |

## Verified sound

- Every node's HTTP call to the backend goes through `http_request` / `internal_post_t`, which escape the JSON body
  for the shell; GET URLs are built from `url_encode`d values or backend-issued IDs.
- Recording file names come from the call UUID (now protected) and `os.time()`.
- Gather digits are limited to `[0-9*#]`; numeric node fields are clamped at call time.
- `queue_eligibility` / `queue_wait` send the queue name to the backend, which uses only read-only callcenter lists.
- ERS nodes require a numeric configuration written into the node, checked against the tenant at publish.
- The designer has no validation of its own: it shows the backend's messages beside the field they name, so the
  two cannot disagree. New rules carry field paths for that reason.
- Save keeps per-node errors non-blocking (drafts can be fixed later); publish runs the full rules.
