# Test Results

## Cycle 5 — 2026-11-04 (working tree on `7f849ed`, after C5-1 and C5-2)

| # | Check | Result | Baseline comparison |
|---|---|---|---|
| 1 | **Real FreeSWITCH staging** (disposable 1.10.12, private netns, simulated endpoints) | Working tree 28/29: IVR 12/12, ENS 10/10, ERS 6/7. The one is the pre-existing ERS limitation O-1 (busy / no-answer legs get no hang-up cause); same code at HEAD | HEAD on the same switch: ENS 5/10 (lost retries, double counts, cancel leaves `failed`) |
| 2 | Backend unit + Lua (full) | 1972 tests, 23 failing | Same 23 names as Cycle 4 (and within the base `7b40b59` list); 5 new tests pass |
| 3 | Integration suites, real PostgreSQL | HEAD 188/243, working tree 205/260 (+17 = ENS settlement) | Same 7 failing names; the same suites fail to load |
| 4 | ENS settlement integration | 17/17 (2 new: real-switch order with concurrent settlement; originate result before hangup) | — |
| 5 | Focused backend / frontend stages (in netns) | 603/603; 123/123; frontend full 276/276 | unchanged |
| 6 | Isolated e2e | functional 47/47, security 39/39, 1 known observation | unchanged |
| 7 | Excel | 6 exports opened read-only in Excel 16.0 via COM: no repair prompt; filters, time zone (UTC), tenant scope and totals match the database | first time |
| 8 | Browser (in-app, loopback stack restored from the staging database) | Designer shows stored `inline`; edit + publish v2; tenant ADMIN refused Audit Log; SUPER_ADMIN audit across tenants; ENS / ERS report screens match exports; dark theme | — |
| 9 | Backend lint, files changed in Cycle 5 | `campaignEngine.js` 1 error (same 1 at HEAD); `ivrGraphValidator.js`, `ivrValidator.js`, `deploymentEngine.js`, both test files: 0 | 0 new |

Run notes: staging runs 1–3 found C5-1 (deploy regression), a staging-config error (run 2 ENS void) and C5-2 (ENS
race); run 4 is final. Details and raw evidence: REAL_FREESWITCH_TEST_RESULTS.md; scratchpad `evidence-stg`,
`evidence-stg-run3`, `evidence-ui-c5`, `evidence-mission/cycle5*`.

## Cycle 4 — 2026-11-03 (working tree on `7f849ed`)

| # | Check | Result | Baseline comparison |
|---|---|---|---|
| 1 | Backend unit + Lua (full) | 1967 tests, 23 failing | Same 23 names as `7b40b59` and the previous runs; 0 new |
| 2 | Frontend (full) | 276/276 | unchanged |
| 3 | Lint | Frontend 0 errors (793 older warnings). Backend changed/new files: 20 errors in total, the same 20 as HEAD's versions of those files (all `no-undef` for Node globals / one `no-useless-catch` in files that already had them); new files 0 | 2 test files that had picked up `URL` errors were fixed |
| 4 | Production frontend build | OK (to `/tmp`, repository untouched) | — |
| 5 | Isolated e2e functional (throw-away PostgreSQL 18, private network namespace) | 47/47 | unchanged count; S-33 extended |
| 6 | Isolated e2e security | 39/39, 1 known observation (legacy `?token=`) | unchanged |
| 7 | Socket.IO auth + tenant isolation | `socketTenantIsolation` (unit, in-namespace focused stage 598/598) and e2e S-27–S-29, S-31 pass | — |
| 8 | IVR compatibility regressions | `executorSecurity` (Fengari), `ivrCycle3Boundaries`, `ivrTrustBoundaries`, `sayVariableFallback`, `ivrRecordNode`, `ivrGraphValidator`: 216/216 | 7 new characterization cases |
| 9 | ENS retry / cancellation on real PostgreSQL | New `integration/ensAttemptSettlement.test.js` 15/15; HEAD-vs-tree comparison of 15 scenarios (matrix B) | HEAD engine run on the same database |
| 10 | Cross-tenant ENS lookup / start | e2e S-32, S-34; unit `ivrCycle3Boundaries` | — |
| — | **All integration suites on real PostgreSQL** (first time in this mission) | HEAD copy: 243 tests, 188 passed, 7 failing. Working tree: 258, 203 passed, 7 failing (+15 = the new ENS test) | **Identical failure names**; the same 4 suites fail to load on both (Redis absent, obsolete `ens_configurations.destination_number` column in `internal-api.test.js`, two hook errors) |

Run notes: the final isolated run was the fourth. Run 2 had two stages end with SIGTERM before any test ran, and in
run 3 the WSL distribution restarted mid-run (systemd boot at 11:02 in the journal). Both are environment events.
Run 4, with the same code, passed every stage. The WSL-side `git status` counts line-ending differences as changes;
the Windows `git status` (80 modified, 36 untracked) is authoritative.

Not proven by any of this (all since covered in Cycle 5; RB-1 approved and closed): real calls, the engine's Lua, ESL event order (RELEASE_BLOCKERS RB-1), Excel, the browser
(no browser run this cycle; the one UI change is a dropdown display fix).

## Compatibility revision — 2026-11-03

After the zero-regression requirement, the Cycle 3 fixes were narrowed (see BEHAVIOUR_CHANGES.md) and everything
re-run:

| Check | Result |
|---|---|
| Backend unit + Lua (full) | 1955 tests, 23 failing, **0 new** (same names as base `7b40b59`) |
| Frontend | 276/276; build OK; lint 0 errors |
| Isolated e2e | Functional 47/47, security 39/39 (new S-34; F-30, F-31, S-33 now also check the preserved behaviour), 1 known observation |
| In-namespace stages | Backend 434/434 (exit 0 now), frontend 123/123 and 276/276 |
| Restored tests | `restApiNode` (webhook) and `sayVariableFallback` (`interp` byte-for-byte) are back to their original text and pass |
| Characterization tests added | Broken flow hangs up by default; inline transfer still runs; identity and call-control variables writable; plain `${var}` kept; webhook is still a direct POST; originate rejection while dialing still fails without retry; `anonymous` caller ID still passed; same-tenant ENS lookup unchanged; REST redirects followed |

The browser check from Cycle 3 was not repeated; this revision changed no screen except the password checklist
(one rule fewer) and the query helper (`''` sent again).

## Cycle 3 — 2026-11-02 (uncommitted, on top of `7f849ed`)

| Check | Result |
|---|---|
| Backend unit + Lua (full) | 1929 tests, 23 failing, **0 new**: the same 23 names as Cycle 2 and as base `7b40b59` |
| Frontend | 277/277 |
| Frontend production build | OK |
| Lint | Frontend 0 errors (793 older warnings). New backend files 0 problems |
| Isolated e2e (private network namespace, throw-away PostgreSQL 18, real Socket.IO) | Functional 47/47, security 38/38, 1 known observation (legacy `?token=`) |
| New e2e checks | S-31 malformed socket messages do not stop the backend · S-32 cross-tenant ENS start refused, no campaign created · S-33 IVR publish rules through the API · F-30 ENS attempt settling on real SQL · F-31 compatibility report finds a stored legacy flow |
| Mutation check | The 16 executor security tests fail on the pre-Cycle-3 `registry.js` and pass on the fixed one |
| In-namespace unit stages | Backend focused 434/434, frontend 119/119 and 254/254 at that time. The focused stage exited 1 with all tests passing: an unhandled rejection (F-25), now fixed |

### Browser verification (first time in this mission)

In-app browser against a disposable local stack: PostgreSQL, backend and Vite bound to 127.0.0.1; telephony, Redis and
TTS pointed at closed ports; synthetic data for two tenants and all roles. Checked: sign-in, regrouped menu for
SUPER_ADMIN and tenant ADMIN, `/audit` refused to ADMIN, Audit Log filters and keyboard-opened details, shared confirm
dialog (focus, Escape, nothing deleted), IVR designer showing the new rule violations, phone layout (375 px) with the
slide-over menu, ENS Campaigns, change-password checklist and server refusal. Two bugs were found this way (F-28 empty
"All" tab, F-33 clipped designer toolbar) and fixed.

### Changes made after the last e2e / browser run

`eslService` emit catch, campaign API outcomes and the shared outcome module, two pinned-source test updates, and
docs. They are covered by unit tests; the campaign outcome SQL was run on the disposable database by hand. The running
test backend in the browser session predated the campaign API change, so the new campaign card numbers were not seen
in the browser.

## What this does not prove

- No real call, conference or SIPCommunication connection was used. The Lua executor ran under Fengari (Lua 5.3),
  not the engine's Lua; `luac5.2` is not installed here.
- The `-ERR` originate result that F-24 relies on is documented engine behaviour, not observed.
- `${...}` second-stage expansion and `api_hangup_hook` behaviour rest on documented engine behaviour.
- Exports have still not been opened in real Excel; dark theme was not viewed; the database was a fresh install.

## Cycle 2 — 2026-11-02

Backend 1845 tests, 23 failing, 0 new; frontend 254/254; e2e functional 45/45, security 35/35. Nothing was viewed in a
browser in Cycle 2. Raw artifacts for all cycles are in the session scratchpad, not in the repository.
