# IVR Lua behaviour harness

A dev-only test harness that runs the **actual generated `ivr_executor.lua`**
(from `backend/src/utils/luaGenerator.js`) inside **Fengari** (a pure-JS Lua 5.3
VM, `devDependencies` only) with the executor's OS / HTTP / FreeSWITCH-session
boundary replaced by JavaScript mocks. No FreeSWITCH, no network, no
production-code change.

- Harness: `backend/src/__tests__/lua/executorHarness.js`
- Tests:   `backend/src/__tests__/lua/executor.harness.test.js`

## Run
```bash
cd backend && CI=true npx vitest run src/__tests__/lua/executor.harness.test.js
```

## Usage
```js
import { runExecutor, appsExecuted } from './executorHarness.js';

const { calls, vars, logs, httpLog } = runExecutor({
  graph: { entry_node_id: 'n1', nodes: { n1: { type: 'transfer', destination: '100' } } },
  vars:  { destination_number: '1222' },
  http:  { '/ivr/queue-eligibility': { reason: 'ELIGIBLE', available: 1 } }, // value | [queue] | fn | null(=failure)
  digits: ['1'],                 // getDigits / playAndGetDigits queue
  now: 1_000_000,                // fixed os.time()
  advanceOnPoll: 0,              // bump the clock on each /ivr/ request (drives deadline loops)
  readyAfter: Infinity,         // hang up after N session calls (caller disconnect)
  globalVars: { ENRS_FAILSAFE_EXT: '0' }, // freeswitch.API():execute('global_getvar', name)
});
appsExecuted(calls); // [['transfer','100 XML default'], ...]
```
`/ivr/lookup` is auto-answered with `graph` unless overridden in `http`.

## What the harness PROVES (deterministic, CI-safe)
- Node branch selection / dispatch (e.g. `queue_eligibility` reason → branch).
- Fail-closed routing on HTTP/parse failure (empty/`null` response → `CHECK_ERROR`, never `ELIGIBLE`).
- Caller-disconnect handling via `session:ready()` → `false` stopping execution.
- The exact app + args passed to `session:execute` / `streamFile` / `hangup`
  (e.g. the transfer dial string; the future overflow `bridge` dial string).
- Clock injection (`os.time`) ready for a future deadline node.

## What it does NOT prove — requires DEV live-call on FreeSWITCH / LuaJIT
- Real `session:execute("bridge", …)` first-answer, losing-leg cancellation,
  and `originate_disposition` / `bridge_hangup_cause` values.
- `playAndGetDigits` barge-in, `streamFile` interruption, Piper TTS output.
- Gateway dialing per destination type (Avaya group / external mobile / station).
- **Runtime parity:** Fengari is Lua **5.3**; production FreeSWITCH runs **LuaJIT
  (5.1)**. The harness proves logic/branching, not byte-identical runtime.

## Implementation note
fengari-interop delivers arguments reliably for **object methods called with
Lua's colon syntax**. `session:method()` and the `freeswitch` table work
directly; `io.popen` / `os.time` are exposed as methods on a harness object and
bound to the globals via a small Lua bootstrap. The executor's `require "cjson"`
fails under Fengari and transparently uses its own pure-Lua JSON fallback.

## Deadline-loop coverage (deferred)
No non-ERS registry node currently uses an `os.time()` absolute-deadline loop,
and ERS code is intentionally not used as a fixture. The harness already injects
`os.time` (and `advanceOnPoll`), so deadline-enforcement tests will be added with
the future `queue_wait` node.
