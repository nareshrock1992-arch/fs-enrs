# Staging Verification Report (Cycle 5, 2026-11-04)

Companion documents: REAL_FREESWITCH_TEST_RESULTS.md (per test), ENS_RETRY_BEHAVIOUR_DECISION.md,
FINAL_RELEASE_READINESS.md, RELEASE_BLOCKERS.md.

## 1. Starting state and restrictions kept

| Item | Value |
|---|---|
| Branch / HEAD | `feature/media-reporting-hardening` at `7f849ed` (same as the remote branch) |
| Working tree at start | 80 modified, 36 untracked (checked with Windows git before any work) |
| Working tree at end | 81 modified, 36 untracked. The new modified file is `backend/src/services/deploymentEngine.js` (C5-1). The four new documents are inside the already-untracked `docs/enterprise/` |
| Git operations | none (no commit, push, merge, rebase, reset, stash, checkout, clean) |
| DEV / production / remote databases / customer systems | not accessed. All runs were in a private network namespace where host ports 5432, 6379, 8021, 5060, 5080, 5000, 4100 and 8100 were unreachable |
| Host FreeSWITCH (pid 282) | never contacted; same pid before and after every run |
| Compatibility switches | none enabled. `ENRS_FAILSAFE_ON_FLOW_ERROR` / `ENRS_FAILSAFE_EXT` were set on the **disposable** switch for test T-IVR-12b only (the brief lists failsafe enabled) and reset immediately (checked) |
| Data | synthetic only; every database, switch config and recording directory deleted after each run |

## 2. Defects found by staging and fixed

| ID | Found | Kind | Fix | Business rule changed? | Evidence |
|---|---|---|---|---|---|
| C5-1 | **Deploy** of an IVR version published before the Cycle 2–3 publish rules (inline transfer, `${name args}`, protected variable) returned 422. HEAD deployed it. Effect: such a flow could not be deployed after binding a new number, nor redeployed to regenerate the executor. The calls themselves kept working | Regression from Cycles 2–3 | Deploy re-checks an already-published version only with the rules it was published under; the newer rules become warnings shown on the Deployment screen. Publish is unchanged. The executor still enforces the rules during the call | No; HEAD's deploy behaviour is restored | T-IVR-DEPLOY, T-IVR-4; unit +5 |
| C5-2 | ENS: on the real switch, `CHANNEL_HANGUP` and `-ERR <cause>` arrive milliseconds apart and were settled concurrently. The originate path often won and failed recipients whose hangup had scheduled the configured retry. HEAD has the same race, plus double counting | Reliability defect, at HEAD and in the Cycle 4 fix | The hangup settles the attempt; the originate result settles it only if no hangup arrives within 2 s (no channel), as before | No; the configured policy is applied reliably. Approved 2026-11-04 (RB-1 closed; ENS_RETRY_BEHAVIOUR_DECISION.md) | T-ENS-3…9; integration 17/17 |

## 3. Pre-existing observations (not changed; for the product owner)

| ID | Observation | Effect | Recommendation |
|---|---|---|---|
| O-1 | ERS ring-all: busy / no-answer responder legs never join, so `ersChannelMap` never gets them. They show `INVITED` during the call, then `MISSED`, with no hang-up cause | Report cannot tell busy from no answer for responders | Product decision; would need responder-leg tracking at originate |
| O-2 | `processCampaign` sets the live `dialing_count` gauge from dialing **and** answered rows on a new peak, after `onCallAnswer` already subtracted the answered ones | Gauge can stay one high on a finished campaign; completion and reports use recipient rows | Low; fix when the gauge is next touched |
| O-3 | ENS screen: "Max Attempts — 0 = no retries"; engine: `max_attempts \|\| 3` (0 → 3 attempts) | A configuration of 0 retries three times | Business-rule decision; use 1 for "no retry" meanwhile |
| O-4 | `esl_connections` stores the ESL password in clear; the dev seed prints the seed admin password | Secret at rest in the database; seed output | Security backlog (`SECURITY_REVIEW.md`) |
| O-5 | Report screens show times in the viewer's browser time zone; exports and date filters use the database time zone (stated in the export) | A viewer far from the database zone may see a "today" filter boundary shifted | Document for operators; no change |
| O-6 | IVR publish / deploy are not written to the audit log (also at HEAD) | No audit trail for flow changes | Backlog |

## 4. IVR, ENS, ERS on the switch

Summary (details per test: REAL_FREESWITCH_TEST_RESULTS.md):

- **IVR (12/12):**
  - normal execution, DTMF, variable substitution;
  - webhook, sent directly from the switch by curl;
  - REST: redirect to an allowed address followed; redirect to loopback refused;
  - XML transfer; existing inline transfer;
  - literal number matching, including `+` and near misses;
  - failsafe disabled (hangs up) and enabled (transfers);
  - publish refuses a new inline transfer; deploy works.
- **ENS (10/10):**
  - answered, busy, no answer, 404, 603, busy-then-answer, no channel;
  - campaign totals;
  - replayed events;
  - cancel during a pending retry.
  - HEAD on the same switch: 5/10.
- **ERS (6/7, plus O-1):**
  - ring-all wave and order;
  - caller ID with `$`;
  - conference;
  - mute, play and kick;
  - recording (530 KB);
  - completion;
  - tenant-scoped report.

## 5. UI and reporting (in-app browser and Excel)

Loopback-only stack (`127.0.0.1`: PostgreSQL 55432, backend 4200, Vite 8200), restored from the staging database, so
the screens show the **real call outcomes**. ESL pointed at a closed port; generated test logins (stored 0600).

| Check | Result | Class |
|---|---|---|
| Designer preserves an existing inline value | Legacy flow's Transfer node shows "inline (current value, not offered for new nodes)" and the destination unchanged | PASS (staging) |
| Normal IVR editing and publishing | Edited a node description; autosaved; **Publish v2** confirmed; status "Published v2" | PASS (staging) |
| SUPER_ADMIN access | Administration menu (Users, Tenants, Audit Log, General Settings, Telephony Gateways, Config Center); tenant switcher; audit across tenants | PASS (staging) |
| Tenant ADMIN access | IVR, reports, own tenant data; `/audit` redirects to the dashboard (API 403), as documented for Cycle 2 | PASS (staging), RB-5 decision |
| Audit logs | Exports (user, rows, filters, tenant), conference controls (role, command, tenant) and conference joins recorded | PASS (staging); O-6 |
| ENS report | "4 campaigns, 3/16 contacts answered"; per-campaign recipient outcomes. The HEAD-engine campaign also shows correct recipient numbers, despite its inflated counters | PASS (staging) |
| ERS report | 1 incident, 1/3 responders answered, recorded, 38 s, completed | PASS (staging) |
| Excel | Six exports opened read-only in **Microsoft Excel 16.0** through COM in a separate hidden instance, closed without saving. All opened with no repair prompt. Sheets: Summary / Campaigns / Recipients and Summary / Incidents / Responders / Participants | PASS (staging) |
| Date ranges | `from=to=2026-11-04` includes the calls; `2026-11-05` gives 0 rows (screen and Excel); `from > to` gives 400 | PASS (staging) |
| Totals | Excel and screen recipient rows equal the database rows (16 ENS recipients, 1 ERS incident with 3 responders) | PASS (staging) |
| Time zones | Exports state "Date filters use time zone: UTC" and label columns "(UTC)"; screens use the browser zone (O-5) | PASS (staging) |
| Tenant filtering | Tenant B: ENS and ERS screen, API and Excel all empty; tenant B gets 404 on tenant A's conference | PASS (staging) |
| Dark theme | ENS report and navigation readable | PASS (staging) |

No business logic was changed to make a screen or report look right.

## 6. Compatibility configuration review

All defaults keep existing behaviour; none was enabled.

| Setting | Where | Default | Effect when enabled | Safe to enable when | Migration / redeploy | Customer workflow affected |
|---|---|---|---|---|---|---|
| `ENRS_FAILSAFE_ON_FLOW_ERROR` (+ `ENRS_FAILSAFE_EXT`, `ENRS_FAILSAFE_PROMPT`) | FreeSWITCH global variable (`vars.xml` or `global_setvar`) | unset → a broken flow hangs up | Broken flow (missing node, unknown type, node error, step cap) plays the prompt and transfers to the failsafe extension | A staffed failsafe extension exists in `default` (verified in staging, T-IVR-12b) | Executor from this release (Deploy) | Callers of broken flows are transferred instead of disconnected |
| `ENRS_IVR_BLOCK_INLINE_TRANSFER` | FreeSWITCH global variable | unset → inline transfers run (logged WARN) | Inline transfer raises a node error (then hang up, or failsafe) | The compatibility report on DEV lists **no** inline transfer, or they are republished with XML | Deploy | Flows still using inline transfer stop transferring |
| `ENS_REQUIRE_IVR_NUMBER` | Backend env | `false` → unregistered routed numbers and old executors still start blasts (warning) | start-by-config without `ivr_number` → 400; routed number not active and registered → 403 | Every executor redeployed (sends `ivr_number`) **and** every routed number is an active registered number | Deploy on every switch first | Emergency blasts from old executors or deactivated numbers **stop**. Highest risk; not recommended for the first release |
| `IVR_CRED_<NAME>_TENANT_IDS` | Backend env, per credential | unset → any tenant's flow may use the credential | Only flows on numbers owned by the listed tenants may use it | The owning tenants of each credential are known | none | REST nodes of other tenants using that credential take their error branch |
| `IVR_CRED_REQUIRE_TENANT_SCOPE` | Backend env | `false` | Credentials **without** a `_TENANT_IDS` scope are refused | Every credential has a scope | none | Any REST node using an unscoped credential takes its error branch |
| `IVR_CRED_<NAME>_ALLOWED_HOSTS` | Backend env | unset | Credential sent only to the listed hosts | Hosts known | none | Calls to other hosts with that credential refused |
| `IVR_REST_BLOCK_PRIVATE` | Backend env | `false` → private addresses allowed (staging: 10.77.0.10 worked) | REST node refuses private addresses | No tenant uses an on-premise REST endpoint | none | On-premise CRM / API integrations stop |

## 7. Tests and baseline

| Check | Result | vs baseline |
|---|---|---|
| Staging (real switch) | 28/29 working tree; HEAD 5/10 ENS | first run |
| Backend unit + Lua | 1972 tests, 23 failing | same 23 names as Cycle 4 |
| Integration, real PostgreSQL | HEAD 188/243; tree 205/260 | same 7 failures |
| Focused, frontend, e2e | 603/603; 123/123; 276/276; functional 47/47, security 39/39 | unchanged |
| Backend lint (Cycle 5 files) | 0 new errors (`campaignEngine.js` keeps its 1 HEAD error) | unchanged |

## 8. Files changed in Cycle 5

- **Code:**
  - `backend/src/services/campaignEngine.js` (C5-2)
  - `backend/src/utils/ivrGraphValidator.js` (C5-1)
  - `backend/src/validators/ivrValidator.js` (C5-1, plus a comment correction)
  - `backend/src/services/deploymentEngine.js` (C5-1; newly modified)
- **Tests:**
  - `backend/src/__tests__/unit/ivrCycle3Boundaries.test.js` (+5)
  - `backend/src/__tests__/integration/ensAttemptSettlement.test.js` (+2, one test retitled and tightened)
- **Docs:**
  - new: ENS_RETRY_BEHAVIOUR_DECISION, REAL_FREESWITCH_TEST_RESULTS, STAGING_VERIFICATION_REPORT, FINAL_RELEASE_READINESS
  - updated: BEHAVIOUR_CHANGES, BUG_TRACKER, CHANGELOG_AUTONOMOUS, CYCLE4_COMPATIBILITY_REPORT, FINAL_BUSINESS_LOGIC_REGRESSION_MATRIX, REAL_FREESWITCH_TEST_PLAN, RELEASE_BLOCKERS, TEST_RESULTS

The staging harness (`stg/`) and all evidence are in the session scratchpad, not in the repository.
