# Release Blockers (updated Cycle 5, 2026-11-04)

Scope: the uncommitted working tree on `feature/media-reporting-hardening` (HEAD `7f849ed`).

**Isolated staging:** passed (REAL_FREESWITCH_TEST_RESULTS.md, STAGING_VERIFICATION_REPORT.md).
**Production:** not ready. RB-3 and RB-4 need DEV access, which this mission does not have. RB-5 needs your
decision. RB-8 needs a test on the customer's real telephony path. RB-1 is closed (approved business decision,
2026-11-04); that approval covers the ENS retry behaviour only and closes no other blocker.

| ID | Blocks | Item | Status after Cycle 5 | How to close | Owner |
|---|---|---|---|---|---|
| RB-1 | — | ENS retry behaviour | **APPROVED / CLOSED (2026-11-04): an approved business-behaviour decision, not a defect fix.** Decision: "retry exactly as configured". The evidence: the real switch sends the hangup before the originate result; HEAD loses configured retries at random and over-counts failures; the working tree (C5-2) follows the configured policy exactly. Approval conditions: the Cycle 5 `settleAttempt` is kept; `max_attempts`, `retry_interval_sec` and `RETRYABLE_CAUSES` are unchanged; no additional retries are added and no setting changes meaning; no customer configuration is changed; the "0 = no retries" discrepancy (O-3) stays open as a separate pre-existing business-rule issue (ENS_RETRY_BEHAVIOUR_DECISION.md) | Closed | You (approved) |
| RB-2 | — | Lua executor never run on FreeSWITCH | **Closed for the tested flows**: play, gather/DTMF, set_variable, webhook, REST, XML and inline transfer, failsafe off/on, ERS ring-all, all on FreeSWITCH 1.10.12 | — (remaining node types: section 5 of the results) | — |
| RB-3 | Production | Literal number matching not checked against DEV data | Open. Staging confirms the literal match (including `+` numbers) and that near-miss numbers reach no flow | Run `node scripts/ivr-compat-report.js` on DEV (read-only); re-bind any listed `pattern_numbers` | You (DEV access) |
| RB-4 | Production | Compatibility report not run on DEV | Open, **narrower**. Since C5-1, flows the report lists still deploy and run; only **republishing** them is refused. The REST proxy refuses only loopback / link-local / metadata (private allowed unless `IVR_REST_BLOCK_PRIVATE=true`) | Run the report; plan republishing of listed flows with their owners | You (DEV access) |
| RB-5 | Decision | Cycle 2 permission changes (tenant ADMIN global settings / Config Center write and audit log; incident-less conference control) | Unchanged; seen in the browser this cycle (tenant ADMIN redirected from Audit Log) | Confirm, or ask for them to be reverted | You |
| RB-6 | Configuration | Opt-in switches | All default off = existing behaviour (FINAL_RELEASE_READINESS.md section 4) | Decide per environment; none needed to release | You |
| RB-7 | — | Excel, dark theme, designer dropdown not viewed | **Closed**: six exports opened read-only in Excel 16.0 (no repair, contents match the database); dark theme viewed; designer shows a stored `inline` value | — | — |
| RB-8 | Production | Customer telephony path not exercised | Staging used simulated SIP endpoints. Gateways, Avaya/Cisco trunks, PAI, PSTN cause codes and real handsets were not used (not allowed) | One supervised test call per service (ENS busy + no answer, ERS ring-all, one IVR) on the customer's DEV/UAT trunk after deployment, recording the ESL order as in staging | You + customer |

## Not blockers (resolved, baseline or pre-existing)

- 23 backend unit failures and 7 integration failures (plus the same suites that fail to load: Redis absent, an
  obsolete `ens_configurations.destination_number` column, two hook errors) are pre-existing and identical on HEAD.
- Cycle 4 over-strict rules (C4-1 to C4-7) and Cycle 5 defects (C5-1 deploy, C5-2 ENS race) are fixed in the working tree.
- Pre-existing observations O-1 to O-6 (BUG_TRACKER.md, STAGING_VERIFICATION_REPORT.md) are unchanged behaviour,
  recorded for the product owner. O-3 ("0 = no retries" on screen vs `max_attempts || 3` in the engine) is a separate
  business-rule question; it is not part of RB-1 and is deliberately not fixed.
