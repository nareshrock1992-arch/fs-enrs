# Final Release Readiness (Cycle 5, 2026-11-04)

Release candidate: uncommitted working tree on `feature/media-reporting-hardening`, HEAD `7f849ed` (same as remote),
81 modified and 36 untracked files. Nothing committed, pushed, merged or deployed.

## 1. Recommendation

| Target | Ready? | Why |
|---|---|---|
| Isolated staging | **Yes; done.** | The release candidate ran on a disposable FreeSWITCH with real SIP signalling, ESL, conference, recording and DTMF; two defects found there are fixed and re-verified |
| DEV (after commit and Deploy) | **Yes, once you authorise the commit and Deploy** (RB-1 approved 2026-11-04), with the deployment steps in section 5 | Same code as staging; DEV is the place to run the compatibility report (RB-3, RB-4) |
| Production | **No, not yet.** | Gates 4 and 5 below have no evidence yet: DEV compatibility data, and one supervised test on the customer's real trunk (RB-8). One decision is open (RB-5); RB-1 is approved and closed |

## 2. Release gates

| # | Gate | Evidence | Status |
|---|---|---|---|
| 1 | **Code-level verification** | Diff against `7f849ed` reviewed. Compatibility rules narrowed in Cycles 4–5. No change to recipient selection, ring order, retry policy values, conference semantics or report definitions | PASS |
| 2 | **Automated integration verification** | Backend 1972 tests, 23 failing, same names as before. Integration on real PostgreSQL: same 7 failures on HEAD and the tree. ENS settlement 17/17. Frontend 276/276. e2e functional 47/47, security 39/39 | PASS (automated) |
| 3 | **Real FreeSWITCH telephony verification** | Disposable FreeSWITCH 1.10.12: IVR 12/12, ENS 10/10, ERS 6/7. The remaining one is pre-existing O-1, unchanged from HEAD. HEAD compared on the same switch | PASS (staging), simulated endpoints only |
| 4 | **DEV compatibility verification** | `scripts/ivr-compat-report.js` not run (no DEV access in this mission). Real number patterns, stored flows, REST endpoints and credentials unknown | NOT TESTED |
| 5 | **Production readiness** | Needs gates 1–4, the RB-5 decision, and one supervised test on the customer trunk (RB-8). RB-1 is approved and closed (retry exactly as configured) | NOT READY |

## 3. Classification summary

| Area | PASS (staging) | PASS (automated) | CONDITIONAL | FAIL (regression) | NOT TESTED |
|---|---|---|---|---|---|
| IVR | execution, DTMF, variables, webhook, REST rules, XML and inline transfer, number matching, failsafe off/on, publish, deploy (C5-1) | protected variables, `${name args}` neutralisation, credentials scope (Fengari / unit) | inline block switch; failsafe in production (needs extension); DEV pattern numbers | — | `ENRS_IVR_BLOCK_INLINE_TRANSFER=true` on a switch; TTS prompts |
| ENS | outbound call, answered, busy, no answer, failed (404), 603, configured retry, retry exhaustion, cancel during retry, duplicate and delayed events (C5-2) | expiry by campaign timeout (integration) | — (RB-1 approved: retry exactly as configured; O-3 "0 = no retries" stays a separate open business-rule question) | — | gateway / PAI / PSTN cause codes; stale-dialing crash recovery (no test anywhere) |
| ERS | responder selection, ring order, caller ID, conference, controls, recording, report, tenant isolation | overflow / queue nodes (unit and Lua tests) | — | — | real handsets; rejoin and queue overflow on a switch |
| UI / reports | designer inline, edit + publish, SUPER_ADMIN, tenant ADMIN, audit, ENS / ERS screens, Excel 16, date ranges, totals, time zones, tenant filter, dark theme | — | RB-5 permission decision | — | other browsers / phone layout this cycle |

No item is classed FAIL (actual regression) at the end of Cycle 5. The one regression found (C5-1) is fixed and
re-verified on the switch.

## 4. Configuration

None is required to release; all defaults keep existing behaviour. Full table: STAGING_VERIFICATION_REPORT.md
section 6. In short:

- **Safe to enable when ready:** `ENRS_FAILSAFE_ON_FLOW_ERROR` (once a staffed `ENRS_FAILSAFE_EXT` exists) and
  `IVR_CRED_<NAME>_TENANT_IDS` / `_ALLOWED_HOSTS` per credential (once the owners are known).
- **Only after the DEV compatibility report is clean:** `ENRS_IVR_BLOCK_INLINE_TRANSFER`, `IVR_CRED_REQUIRE_TENANT_SCOPE`
  and `IVR_REST_BLOCK_PRIVATE`.
- **Not for the first release:** `ENS_REQUIRE_IVR_NUMBER`. It can stop emergency blasts from executors that have not
  been redeployed, or from deactivated numbers.

## 5. Deployment steps when approved (for DEV first)

1. Commit and push on the feature branch (your action; not done here).
2. Deploy the backend and frontend as usual. No database migration is part of this change.
3. In the UI, **Deploy** each IVR flow once. This regenerates the executor; since C5-1 this also works for flows
   published before the new rules.
4. Run `node scripts/ivr-compat-report.js` on DEV (read-only). Re-bind any listed pattern numbers, and plan to
   republish listed flows with their owners.
5. One supervised call per service on the DEV / UAT trunk (RB-8), with ESL logging on. Confirm the hangup-then-result
   order seen in staging.

## 6. Unresolved risks

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| Customer trunk sends causes or event order not seen in staging (e.g. 480, 487, early media) | Medium | ENS outcome for those causes. The configured policy still decides, but via the real cause | RB-8 test; ESL tap during the first DEV campaign |
| More retry calls than customers are used to (HEAD skipped them at random) | High where retries are configured | Recipients may receive up to Max Attempts calls | Accepted: RB-1 approved (retry exactly as configured). Tell customers before release; configurations are not changed by us |
| DEV flows or numbers relying on regex patterns | Unknown | Calls to pattern numbers stop matching after Deploy | Compat report before Deploy (RB-3) |
| Flows listed by the compat report cannot be republished unchanged | Unknown | Admins must edit them before the next publish (they keep running) | Report, then plan |
| Pre-existing O-1…O-6 | — | Reporting detail, gauge, configuration ambiguity, secret at rest, audit coverage | Product backlog |
