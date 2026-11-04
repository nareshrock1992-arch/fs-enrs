# Cycle 4 — Business Logic Compatibility and Release Readiness (2026-11-03)

Independent re-verification of the Cycle 2–3 changes against existing FS-ENRS behaviour. The previous reports were
not taken as evidence: the code, the diff against `7f849ed` and fresh test runs were.

Companion documents: `FINAL_BUSINESS_LOGIC_REGRESSION_MATRIX.md` (row-by-row classification),
`REAL_FREESWITCH_TEST_PLAN.md` (telephony tests still to run), `RELEASE_BLOCKERS.md`, `BEHAVIOUR_CHANGES.md`.

## 1. Starting state

| Item | Value |
|---|---|
| Branch | `feature/media-reporting-hardening` |
| HEAD | `7f849ed` (same as the remote branch); `main` at `6ab4dc6` |
| Working tree at start | 80 modified, 34 untracked; hashes of all 124 files recorded before any change |
| Git operations this cycle | none (no commit, push, merge, rebase, reset, stash, checkout) |

## 2. How it was verified

1. Read every changed backend file's diff against `7f849ed`, plus the generated executor's helpers.
2. Characterised the old behaviour where the new code differs. The ENS engine was characterised by running the
   **HEAD engine itself** and the working-tree engine through the same 15 event sequences on a disposable
   PostgreSQL database, then diffing the results.
3. Ran **every integration suite** on real PostgreSQL twice, on a HEAD copy and on the working tree, against
   the same disposable database. Previous cycles had not run these suites.
4. Ran the full backend unit and Lua suite, the frontend suite, lint and the production build, and the isolated
   end-to-end and security run (private network namespace, throw-away PostgreSQL 18, real Socket.IO).
5. Where a rule was stricter than the risk, narrowed it, added a characterization test and recorded it.

## 3. Defects found in the Cycle 2–3 work and fixed in this cycle

Each one would have changed an existing customer workflow without a security need.

| ID | Found | Existing behaviour restored | Security still closed | Test |
|---|---|---|---|---|
| C4-1 | The executor refused **any** whitespace in a transfer destination or context at call time | Author-written words (`1001 XML public` → context `public`), trailing spaces, empty variables, contexts with spaces: passed through unchanged | A substituted value that adds a word (`1000 inline`) is still refused | `executorSecurity`: 7 new cases |
| C4-2 | Publish refused whitespace in destination and context | Publishes as before | `inline` as the destination's dialplan word is refused (it would bypass the inline rule) | `ivrCycle3Boundaries`, e2e S-33 |
| C4-3 | ENS start-by-config returned 403 when the routed number is not an active registered number (for example a number deactivated while its dialplan is still deployed, or a legacy or transferred route). **An emergency blast from such an IVR would have stopped working** | Blast starts, with a warning | Refused when the routed number is registered to a different tenant; strict mode `ENS_REQUIRE_IVR_NUMBER=true` | `ivrCycle3Boundaries`: 2 new characterization cases |
| C4-4 | Conference control accepted only room names made of `[A-Za-z0-9_.@-]`; rooms with `+`, `:`, `#` would have answered 404 even to SUPER_ADMIN | Any name without whitespace or control characters | ESL command injection needs whitespace or a newline, both still refused | `conferenceTenantIsolation` |
| C4-5 | ERS caller name lost every `$`; an empty caller number was dropped from the responder leg | `$` kept; empty number passed empty, byte-for-byte as before | `'` `\` `{` `}` still removed (so `${` cannot form); injecting numbers still left out | `ersOriginateInjection` |
| C4-6 | ERS report summary counted responders **without observers**, unlike the per-incident rows and the detail screen | Counts every responder row, as before | — (not a security change) | `reportsRoutes` |
| C4-7 | Designer showed a stored `inline` dialplan as "XML" (removed from the list) | Shows the stored value; saving never changed it | — | code review |

Also corrected: the compatibility report text, IVR_AUDIT and SECURITY_REVIEW descriptions of the transfer rule, and a
stale comment in `ivrTrustBoundaries.test.js`.

## 4. IVR compatibility (brief items 1–12)

| # | Question | Answer | Class |
|---|---|---|---|
| 1 | Published inline transfers keep working | Yes; logged; block only with `ENRS_IVR_BLOCK_INLINE_TRANSFER=true` | CONDITIONAL |
| 2 | New inline transfers follow the publish rule | Refused in the dialplan field and as the destination's dialplan word | PASS |
| 3 | Ordinary `${variable}` unchanged | `interp` byte-for-byte; original test restored and passing | CONDITIONAL |
| 4 | Only command-execution forms blocked | `${name args}`, `${name(args)}`, `${a${b}}`. Plain `${var}` is untouched. They are made inert only at the transfer, built-in TTS and playback arguments. IVR templates are resolved by `interp` first, so only values are affected. Residual: an ENS announcement text or audio URL containing a deliberate API form loses it (matrix A4) | CONDITIONAL |
| 5 | Protected variables vs legitimate flows | Only 7 names and 3 prefixes the engine runs as commands; identity, routing, `sip_h_*`, conference and bridge variables stay writable (10 characterization cases) | CONDITIONAL |
| 6 | Transfer destinations | Compatible after C4-1 | CONDITIONAL |
| 7 | Dialplan types | Every dialplan except `inline` publishes (`XML`, `enum`, `xml`, custom) | PASS |
| 8 | Webhook | Same direct `curl` POST from the switch; only quoting of the URL changed | CONDITIONAL |
| 9 | Redirects | Followed again (up to 5) | PASS WITH CONFIGURATION |
| 10 | Redirect validation | Refuses loopback, link-local and metadata targets; private addresses are allowed unless `IVR_REST_BLOCK_PRIVATE=true` (corrected in Cycle 5; staging T-IVR-7/8 confirm both). Endpoints on the backend host itself would stop; the report lists fixed URLs, but URLs built from variables cannot be listed | NOT VERIFIED (customer endpoints unknown) |
| 11 | Number-pattern matching | Literal since Cycle 2 (asked for in the Cycle 2 brief); deliberate patterns stop matching; the report lists them | NOT VERIFIED (DEV data) |
| 12 | Flow-error handling | Hangs up by default; failsafe only with `ENRS_FAILSAFE_ON_FLOW_ERROR=true` | CONDITIONAL |

## 5. ENS reliability

The HEAD engine and the working-tree engine, the same scenarios, real PostgreSQL (matrix section B):

- **Identical** for answered, busy and no-answer with retry (same `retry_interval_sec` timing), non-retryable
  failure, retry exhausted, originate rejected while dialling, duplicate failed hangup, a queued retry then
  cancel, and an answered call ending after cancel.
- **Different only where HEAD is demonstrably wrong:**
  - a late originate result overwrote a scheduled retry and double-counted (failed + retried for one attempt);
  - an answered call was recorded failed;
  - three duplicate hangups counted three completions;
  - a hangup after cancel or expiry left a `queued` recipient that nothing would ever dial;
  - under concurrency, HEAD's counters read failed=10, busy=11, retried=11 for 10 recipients.
- The working tree counts each recipient once in every scenario, and the report SQL sums to the recipient count.
- A cancelled campaign has no `queued` or `dialing` row left, so it cannot continue retrying.
- Retry policy and timing are unchanged. One consequence needs real-call confirmation: where the hangup event
  arrives before the originate result, busy and no-answer recipients are now retried as configured, where HEAD
  failed them (RELEASE_BLOCKERS RB-1). *Cycle 5 update: staging confirmed the hangup-first order, found a remaining
  race (fixed as C5-2), and RB-1 was approved and closed on 2026-11-04 ("retry exactly as configured").*

New repository test: `backend/src/__tests__/integration/ensAttemptSettlement.test.js` (15 tests, real PostgreSQL,
follows the existing integration-test convention; no rows deleted).

## 6. Cross-tenant, ERS, reporting

See matrix sections C, D and E. Isolation is enforced in the backend: routes, socket rooms, internal API and
recordings. The UI is not relied on. SUPER_ADMIN keeps global access, including incident-less conferences.
Cycle 4 made no change to ERS responder selection, ring order or conference semantics.

## 7. Test results and baseline comparison

| Check | Result | vs baseline |
|---|---|---|
| Backend unit + Lua | 1967 tests, 23 failing | same 23 names as `7b40b59`; 0 new |
| Integration suites, real PostgreSQL | HEAD 188/243, working tree 203/258 | same 7 failing names, same 4 suites fail to load |
| ENS settlement integration | 15/15 | new |
| Frontend | 276/276; build OK; lint 0 errors | unchanged |
| Backend lint (changed files) | 20 errors, same as HEAD's versions | 0 new |
| Isolated e2e | functional 47/47, security 39/39 | unchanged |

Details and run notes: TEST_RESULTS.md, "Cycle 4". Raw artifacts are in the session scratchpad
(`evidence-iso`, `evidence-mission`), not in the repository.

## 7a. Files modified in this cycle

Backend: `nodeTypes/registry.js`, `validators/ivrValidator.js`, `controllers/internal/ensInternalController.js`,
`middleware/conferenceAccess.js`, `services/ersRingService.js`, `routes/v1/reports.js`, `scripts/ivr-compat-report.js`.
Tests: `integration/ensAttemptSettlement.test.js` (new), `lua/executorSecurity`, `unit/ivrCycle3Boundaries`,
`unit/ivrTrustBoundaries`, `unit/conferenceTenantIsolation`, `unit/ersOriginateInjection`, `unit/reportsRoutes`,
`unit/socketTenantIsolation`. Frontend: `components/ivr/panels/PropertyPanel.jsx`. Docs: the four new documents
plus BEHAVIOUR_CHANGES, BUG_TRACKER, CHANGELOG_AUTONOMOUS, IVR_AUDIT, SECURITY_REVIEW, TEST_RESULTS.
All of these files were already uncommitted changes from Cycles 2–3, except the new test and the four new documents.
`TENANT_UNIFICATION_PROMPT.md` (repository root) appeared during this cycle; it was not created or read here.

## 8. Release recommendation

**Safe to proceed to an isolated staging environment** (own FreeSWITCH, own database, no PSTN). Not ready for
production until RB-1 to RB-4 in RELEASE_BLOCKERS.md are closed (Cycle 5: RB-1 approved and closed, RB-2 closed for the tested flows; see RELEASE_BLOCKERS.md for the current list): real telephony tests, the ENS retry decision,
and the compatibility report run on DEV.
