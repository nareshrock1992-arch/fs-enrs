# Final Business Logic Regression Matrix (Cycle 4, 2026-11-03)

Compares committed behaviour (`7f849ed`, what DEV runs) with the working tree after Cycle 4. Evidence is from this
cycle's runs, not from earlier reports (see TEST_RESULTS.md, "Cycle 4").

**Classes:** **PASS** verified and compatible · **PASS WITH CONFIGURATION** compatible after documented
configuration · **CONDITIONAL** automated verification passed, real telephony verification remains ·
**FAIL** regression or unresolved defect · **NOT VERIFIED** insufficient evidence.

Every Lua (executor) row is at best CONDITIONAL. The executor ran under Fengari with a fake engine API, never on
FreeSWITCH (REAL_FREESWITCH_TEST_PLAN.md). "Executor" evidence refers to `__tests__/lua/executorSecurity.test.js`.

## A. IVR

| # | Existing behaviour (7f849ed) | Current behaviour | Security reason for the difference | Affected workflow | Configuration | Evidence | Risk | Class |
|---|---|---|---|---|---|---|---|---|
| A1 | Published inline transfer runs | Runs; WARN logged | — | none | Optional block: engine global `ENRS_IVR_BLOCK_INLINE_TRANSFER=true` | Executor: "already-published inline transfer still runs", "…blocks it" | Low | CONDITIONAL (T-IVR-5) |
| A2 | New inline transfer publishes | Refused at publish (`dialplan` field, also `inline` as the destination's 2nd word) with a field-scoped message | `inline` runs arbitrary applications on the shared switch | Admins republishing such a flow must pick XML | none | `ivrCycle3Boundaries`, e2e S-33 | Low (publish-time only, listed by compat report) | PASS |
| A3 | `${var}` substituted by `interp` | Unchanged byte-for-byte | — | none | none | `sayVariableFallback` (original text), executor "interp substitutes values exactly as before" | Low | CONDITIONAL (T-IVR-7) |
| A4 | Engine expanded `${name args}` / `${name(args)}` inside values that reach `transfer`, built-in TTS, playback | Those forms are made inert (the `${` is dropped) only at those three engine arguments and in a variable read by the play node; plain `${var}` kept. Publish refuses the forms in any field | Expansion runs a command on the switch host (a caller name could run `system`) | A flow author who deliberately used an API form (e.g. `${strftime(...)}`) in an **ENS announcement text in built-in-TTS fallback mode** or an **ENS audio URL** loses it; IVR fields are already resolved by `interp` first, so IVR templates are unaffected | none | Executor "built-in TTS fallback never receives an API-form", "transfer … cannot carry `${api(args)}`" | Low: only with Piper unset or a hand-typed ENS audio URL | CONDITIONAL (T-IVR-8) |
| A5 | Any variable writable | Only variables the engine runs as commands (`api_hangup_hook`, `api_reporting_hook`, `api_after_bridge`, `api_on_*`, `execute_on_*`, `exec_after_bridge_*`, `bridge_pre_execute_*`) and `uuid` are refused; identity, call-control, `sip_h_*`, conference and bridge variables stay writable | Writing a hook variable runs a command when the hook fires | Flows writing those names (none known; compat report lists them) | none | Executor 6 refused / 10 still writable; `ivrCycle3Boundaries` | Low | CONDITIONAL (T-IVR-9) |
| A6 | Transfer destination passed as is (split on whitespace by the engine) | Same, **except** a substituted value that adds a word is refused (call ends as on any node error). Author-written words (`1001 XML public`), trailing spaces, empty variables, surrounding whitespace in a value: unchanged. **Cycle 4 narrowing:** Cycle 3 refused all whitespace | A value with a space could pick the dialplan (`1000 inline` → arbitrary apps) | Only a value that adds a word | none | Executor: 4 characterization cases + "variable cannot add words…" | Low | CONDITIONAL (T-IVR-3/4) |
| A7 | Any dialplan / context | Any dialplan except `inline` publishes; contexts unrestricted (Cycle 4 removed the Cycle 3 whitespace rule on the context, which is author-written and never caller-controlled) | — | none | none | `ivrCycle3Boundaries` "dialplans publish as before", "destinations and contexts with spaces publish as before"; executor "context with a space" | Low | PASS (publish) / CONDITIONAL (call) |
| A8 | Webhook: direct `curl` POST from the switch; URL inside single quotes unescaped | Same request, same host; URL shell-escaped and passed with `--url` | A `'` in the URL ended the shell word (command injection) | none | none | Executor 3 webhook tests (shell parse) | Low | CONDITIONAL (T-IVR-6) |
| A9 | REST proxy followed redirects (fetch default) | Followed, up to 5; each new address checked; credentials dropped on host change; 303 / 301-302-after-POST become GET | Redirect to an internal address (SSRF) | An integration redirecting more than 5 times, or to a private/loopback/metadata address | Optional: `IVR_CRED_<NAME>_TENANT_IDS`, `IVR_CRED_REQUIRE_TENANT_SCOPE` (both off by default) | `ivrCycle3Boundaries` redirect tests | Medium: depends on customers' REST endpoints (compat report lists fixed URLs the proxy refuses) | PASS WITH CONFIGURATION |
| A10 | (redirect validation) | Refuses only loopback, link-local and metadata targets, at DNS and connect time; private addresses allowed unless `IVR_REST_BLOCK_PRIVATE=true` (corrected in Cycle 5) | as A9 | Integrations calling the backend host itself | none (opt-in: `IVR_REST_BLOCK_PRIVATE`) | `ivrCycle3Boundaries`, `ivrTrustBoundaries`; staging T-IVR-7/8 (private 10.77.0.10 allowed, loopback redirect refused) | Low: only endpoints on the backend host itself stop | PASS (staging) for the rule; NOT VERIFIED against real customer endpoints |
| A11 | Bound numbers matched as regular expressions (`7100\|7101`, `.*`) | Matched literally; numbers restricted to `[+0-9*#A-Za-z_-]` on create/update | `.*` bound by one tenant captured every call on the platform | Any number that was a deliberate pattern | Re-bind each intended number explicitly | `ivrTrustBoundaries`; e2e F-31 (`pattern_numbers`) | **High until the compat report is run on DEV** | NOT VERIFIED (data on DEV unknown) |
| A12 | Broken flow (missing node, unknown type, step cap) hangs up | Hangs up; reason logged | — | none | Optional failsafe: `ENRS_FAILSAFE_ON_FLOW_ERROR=true` + `ENRS_FAILSAFE_EXT` | Executor 3 cases × default/opt-in | Low | CONDITIONAL (T-IVR-10/11) |
| A13 | Designer showed an unlisted dialplan (e.g. stored `inline`) as "XML" | Shows the stored value, marked "current value, not offered for new nodes"; saving does not change it | — | display only | none | Code review (React `select` value unchanged either way); not viewed in a browser | Low | NOT VERIFIED (no browser run this cycle) |
| A14 | ENS lookups from the executor sent only the dialled number | Also send `ivr_number`; backend answers 404 only when both numbers are registered to different tenants | A flow could point `destination_number` at another tenant's ENS number | none (same tenant, unregistered number, older executors unchanged) | none | e2e S-34; `ivrCycle3Boundaries` | Low | PASS |

## B. ENS outcomes (real PostgreSQL)

Before/after: the same 15 event sequences driven through the HEAD engine and the working-tree engine on a disposable
database (`evidence-iso/ens-compare-{head,wt}.json`). New repository test `integration/ensAttemptSettlement.test.js`:
15/15 on real PostgreSQL.

| # | Outcome | HEAD | Working tree | Reason for difference | Class |
|---|---|---|---|---|---|
| B1 | Answered | completed, counted once | identical | — | PASS |
| B2 | Busy, attempts left | queued + retry after `retry_interval_sec`, busy+1, retried+1 | identical (timing checked: 55–60 s for 60 s) | — | PASS |
| B3 | No answer, attempts left | queued + retry, no_answer+1 | identical | — | PASS |
| B4 | Non-retryable failure | failed, failed+1 | identical | — | PASS |
| B5 | Retry exhausted (busy on last attempt) | failed / USER_BUSY, reported busy | identical | — | PASS |
| B6 | Retry successful | (not separable at HEAD; same SQL) | completed on attempt 2, one recipient, answered, 1 retry | — | PASS |
| B7 | Originate rejected while dialing | failed / ORIGINATE_ERROR, no retry | identical | — | PASS |
| B8 | Busy hangup, **then** originate `-ERR USER_BUSY` | **failed / ORIGINATE_ERROR with a retry still scheduled; failed+1 and retried+1 for one attempt** | queued + retry (the configured retry policy), counted once | Defect: the late originate result overwrote the retry and double-counted | **PASS (staging) — RB-1 closed.** The real switch sends the hangup first; with C5-2 the configured retry stands every time (T-ENS-3…6). Behaviour approved 2026-11-04 (ENS_RETRY_BEHAVIOUR_DECISION.md) |
| B9 | Answered call, originate `-ERR`, then hangup | **failed; answered+1 and failed+1** | completed | Defect: an answered call was recorded failed | CONDITIONAL |
| B10 | Duplicate hangup ×3 (answered) | **completed_count = 3** for one recipient | completed_count = 1 | Defect: double counting | PASS |
| B11 | Duplicate hangup ×3 (failed) | counted once | identical | — | PASS |
| B12 | Campaign cancelled, then a retryable hangup | **queued with a retry in a cancelled campaign (never dialled, reported "pending" forever)** | skipped (what cancel gives every queued recipient) | Defect: orphaned recipient | PASS (cannot continue retrying: no `queued` row remains) |
| B13 | Retry queued, then cancel | skipped | identical | — | PASS |
| B14 | Cancel, then answered call ends | completed | identical | — | PASS |
| B15 | Expired, then retryable hangup | **queued in a finished campaign** | expired | Defect: orphaned recipient | PASS |
| B16 | Concurrent: hangup + originate `-ERR` + hangup, 10 recipients | **counters failed=10, busy=11, retried=11 for 10 recipients (2 rows failed)** | each attempt settled once: failed + retried = 10, rows match counters, report sums to 10 | Defect: race | PASS (counting). Outcome order: settled by the hangup since C5-2 (integration test, real-switch order, 15/15 retried); RB-1 approved and closed |

Recipients are counted once in every scenario; the report SQL (`CAMPAIGN_OUTCOMES_JOIN`) sums to the recipient
count; retry timing and policy are unchanged (`retry_interval_sec`, `max_attempts`, retryable cause list identical).

## C. Cross-tenant protection (backend-enforced)

| # | Check | Evidence | Class |
|---|---|---|---|
| C1 | Tenant A cannot read Tenant B's ENS campaigns / reports | integration `campaignAuthorization` (same results HEAD vs WT), e2e R-8, unit `tenantIsolation` | PASS |
| C2 | Tenant A cannot start Tenant B's notification (UI API, IVR start-by-config with a session-variable config, ENS lookup) | e2e S-32, S-34; `ivrCycle3Boundaries` (Cycle 4: an unregistered routed number is no longer refused — see D-4 in CYCLE4_COMPATIBILITY_REPORT.md) | PASS |
| C3 | Tenant A cannot control Tenant B's conferences | `conferenceTenantIsolation`, e2e S-26 | PASS |
| C4 | Tenant A cannot access Tenant B's recordings | `mediaTenantIsolation`, `mediaRecordingsRbac`, e2e media checks | PASS |
| C5 | Tenant A cannot receive Tenant B's socket events | `socketTenantIsolation`, e2e S-27–S-29, S-31 | PASS |
| C6 | Tenant ADMIN keeps tenant operations (IVR, ENS, ERS, contacts, users, reports, own conferences) | e2e functional suite; `platformAuthorization` | PASS |
| C7 | SUPER_ADMIN global access incl. ownerless emergency conferences | `conferenceTenantIsolation` ("SUPER_ADMIN controls any room…"), e2e S-30 | PASS |
| C8 | Conference room names | Cycle 4: any name without whitespace/control characters is controllable (Cycle 2/3 limited it to `[A-Za-z0-9_.@-]`, which would have hidden rooms like `+9665…`) | `conferenceTenantIsolation` characterization | PASS |
| C9 | Tenant users and incident-less (manual) rooms | 404 for tenant users (by the Cycle 2 brief); SUPER_ADMIN unaffected | `conferenceTenantIsolation` | PASS WITH CONFIGURATION (operational: manual rooms are SUPER_ADMIN's) |

## D. Emergency Response System

| # | Area | Change since 7f849ed | Evidence | Class |
|---|---|---|---|---|
| D1 | Responder selection (tier contacts + groups, merged, de-duplicated) | none (`resolveTierResponders` untouched) | diff review; integration `ersRingAllPhase5` same results HEAD vs WT | CONDITIONAL |
| D2 | Ring order / re-ring waves / tier timeout | none | diff review | CONDITIONAL (T-ERS-2) |
| D3 | Busy / no-answer handling | none | diff review | CONDITIONAL (T-ERS-3) |
| D4 | Caller identity | Name: `'` `\` `{` `}` removed (was `'` `\` `}`); `$` kept (Cycle 4 narrowing). Number: digits/+/-/. kept; a plain token (`anonymous`) and an empty number pass as before (Cycle 4 restored the empty case); only a value that could add a variable is left out | `ersOriginateInjection`; baseline-failing `ersCallerNamePresentation` (same 8 failures as at 7b40b59) | CONDITIONAL (T-ERS-4) |
| D5 | Conference creation and participant handling | none (only the tenant tag on socket events) | diff review, integration `trackParticipant` fails identically on HEAD and WT | CONDITIONAL |
| D6 | Emergency conference controls | Tenant scoping + input checks; commands unchanged | `conferenceTenantIsolation` | CONDITIONAL (T-ERS-6) |
| D7 | Notifications / reporting | Live events carry the tenant (only that tenant and SUPER_ADMIN receive them) | `socketTenantIsolation` | PASS |

## E. Reporting and data integrity

| # | Check | Result | Class |
|---|---|---|---|
| E1 | ENS campaign totals | Report and campaign cards count each recipient once by final outcome (Cycle 2 change, documented); old counters still returned unchanged on the campaign API | PASS |
| E2 | Recipient outcomes | One outcome per recipient; matches B-table | PASS |
| E3 | ERS responder outcomes | Summary `responders` again counts every responder row incl. observers (**Cycle 4 revert**: Cycle 2/3 excluded observers in the summary only, so it disagreed with the per-incident rows and the detail screen) | PASS |
| E4 | Retry counts | `retries` = attempts − 1 per recipient; counters unchanged | PASS |
| E5 | Completion dates | unchanged | PASS |
| E6 | Time zones | Date filters use the database session time zone, as before; exports state it | PASS |
| E7 | Tenant filtering | `effectiveTenantId` on every report and export | PASS |
| E8 | SUPER_ADMIN global reporting | unchanged | PASS |
| E9 | Excel exports | New (additive); built and parsed in e2e R-11–R-16 | NOT VERIFIED in real Excel |
| E10 | API compatibility | Only additive fields (`outcomes`, `entity_types`, optional `ivr_number`) | PASS |
| E11 | Data | No migration, no schema change, no destructive statement | PASS |
