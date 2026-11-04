# Autonomous Changelog

All entries are uncommitted working-tree changes on top of `7f849ed`.

## Cycle 1 — 2026-10-31

### Conference tenant isolation and ESL safety (F-01, F-02, F-03, F-05, F-06)
- **Problem:** any tenant ADMIN or SUPERVISOR could control any tenant's live conference; request values reached ESL commands unchecked.
- **Root cause:** control routes trusted `:room`; conferences carry no tenant; ESL commands are plain text.
- **Files:** new `services/conferenceOwnership.js`, `middleware/conferenceAccess.js`; `routes/v1/monitoring.js`, `controllers/monitoringController.js`, `services/eslService.js`.
- **Details:** ownership from the latest ERS incident using the room; 404 otherwise; line-break guard in `eslCommandTimeout`; recording paths limited to the recording directory; `debug/conf-sync` is SUPER_ADMIN only.
- **Tests:** `conferenceTenantIsolation.test.js`; e2e S-26.
- **Limits:** rooms with no incident are SUPER_ADMIN only; no real ESL or call was involved.

### Socket event routing (F-04, F-08)
- **Problem:** conference and channel events reached every socket, including sockets not logged in.
- **Files:** `services/eslService.js`, `frontend/src/api/socket.js`.
- **Details:** conference events go to the owning tenant and SUPER_ADMIN, channel events to SUPER_ADMIN (the UI does not use them), others to authenticated sockets. An expired token on reconnect refreshes once.
- **Tests:** `eslSocketRouting.test.js` covers routing and the line-break guard. **The browser token refresh has no test yet.**

### Reporting and Excel (F-07)
- **Problem:** no Excel export; campaign counters count attempts, not recipients.
- **Files:** new `utils/xlsxWriter.js`, `components/ui/ExportButton.jsx`; `routes/v1/reports.js`, `frontend/src/api/client.js`, `pages/reports/*`.
- **Tests:** `xlsxWriter.test.js`, `reportsRoutes.test.js`, `reportState.test.js`; e2e R-10 to R-14.
- **Limits:** not opened in real Excel; report pages not viewed in a browser.

## Release note

These changes are not in `docs/releases/DEV-media-reporting-hardening.md`. If they ship, its schema check must add the
new columns read by the exports, and its "what changes" table needs updating.

## Cycle 2 — 2026-11-02

Each item's problem, cause and files are in `ENTERPRISE_AUDIT.md`, `IVR_AUDIT.md` and `SECURITY_REVIEW.md`.

- **Sockets:** `services/socketService.js`, `frontend/src/api/socket.js`, `store/authStore.js`. Tests: `socketTenantIsolation`, `toast`; e2e S-27 to S-29.
- **Live events:** new `services/eventTenant.js`; ENS/ERS internal controllers, `ersController.js`, `campaignEngine.js`, `ersRingService.js`.
- **Conferences:** `middleware/conferenceAccess.js` (SUPER_ADMIN rule, audit), `routes/v1/ers.js`, `routes/v1/monitoring.js`, `controllers/ersController.js`, `controllers/monitoringController.js`.
- **Authorization:** `routes/v1/{settings,platformConfig,deployment,gateways,ivr}.js`; `SettingsPage`, `DeploymentDashboard`, `Sidebar`, `App`. Tests: `platformAuthorization`; e2e S-30.
- **IVR:** `utils/xmlGenerator.js`, `controllers/serviceController.js`, `controllers/internal/ivrRestController.js`, `utils/ivrGraphValidator.js`, `.env.example`. Tests: `ivrTrustBoundaries`.
- **Reporting:** `routes/v1/reports.js`, new `utils/xlsxWorker.js`, `ReportContactUsage.jsx`. Tests: `xlsxWriter`; e2e R-15, R-16.
- **Admin UI:** new `components/ui/Toast.jsx` (20 files moved off `alert()`), new `routes/v1/audit.js`, `pages/admin/AuditLog.jsx`.
- **Test corrections:** `ivrGraphValidator` fixture count; `tenantIsolation` no-tenant routing (intended change); `campaignEngineTts` mocks the tenant lookup (it had shifted a fixed mock sequence); `reportsRoutes` skips the time-zone query in the tenant scan. No assertion on tenant behaviour was weakened.

## Cycle 3 — 2026-11-02

Problems and causes are in `ENTERPRISE_AUDIT.md` (F-23 to F-33) and `IVR_AUDIT.md` (IVR-6 to IVR-8, IVR-12 to IVR-17).

- **IVR executor:** `utils/luaGenerator.js` (`no_expand`, `CALL_NUMBER`, `set_var`, failsafe on broken flows), `nodeTypes/registry.js` (webhook via proxy, transfer guard, protected writes, `ivr_number`), new `utils/ivrProtectedVars.js`. Tests: `lua/executorSecurity`, harness reads the request target.
- **IVR publish rules:** `validators/ivrValidator.js` (field-scoped rules, `nodeSecurityIssues`), `utils/ivrGraphValidator.js` (exports `API_EXPANSION_RE`). Tests: `ivrCycle3Boundaries`, `ivrTrustBoundaries` (expansion cases moved to a field only that rule covers).
- **REST proxy:** `controllers/internal/ivrRestController.js` (`pinnedFetch`, `makeCheckedLookup`, tenant scope, mapping filter, 1 MiB cap).
- **ENS:** `controllers/internal/ensInternalController.js` (tenant check), `services/campaignEngine.js` (`settleAttempt`, `originateCause`), new `services/ensOutcomes.js`, `controllers/campaignController.js` (outcomes). e2e S-32, F-30.
- **ERS:** `services/ersRingService.js` (`callerIdentityVars`). Test: `ersOriginateInjection`.
- **Sockets / ESL:** `services/socketService.js` (safe `authenticate`), `services/eslService.js` (caught emit). Tests: `socketTenantIsolation`, `recordingFSM` fake io; e2e S-31.
- **Passwords:** new `validators/passwordPolicy.js`; `routes/v1/users.js`, `controllers/authController.js`. Test: `passwordPolicy`.
- **Audit API:** `routes/v1/audit.js` returns record types.
- **Compatibility:** new read-only `backend/scripts/ivr-compat-report.js`; e2e F-31. `.env.example`: three new optional settings.
- **Frontend:** `ConfirmDialog` (`confirmAction`, `ConfirmHost`), `Modal`, `Drawer`, `Table`, `StatCard`, `AppShell`, `Sidebar`, new `layout/navigation.js`, `ChangePasswordDialog`, `passwordRules.js`, `Header`, `api/client.js` (`qs`), `AuditLog` + `auditFormat.js`, `CampaignDashboard` + `campaignCounts.js`, `BuilderToolbar`, `Dashboard`, 20 pages for confirmations, 10 for notices or labels. Tests: `toast` (no `confirm()`), `auditFormat`, `apiQuery`, `campaignCounts`, `passwordRules`, `reportState` (real menu).
- **Test corrections:** `restApiNode` and `sayVariableFallback` pinned the exact old webhook and `interp` source, which were the vulnerable code; they now assert the new behaviour. `ivrRecordNode` T9 expects the guarded write. No tenant or security assertion was loosened.

## Compatibility revision — 2026-11-03

Under the zero-regression requirement every Cycle 3 change was re-checked against existing behaviour; the ones that
went further than the security fix needed were narrowed or made opt-in. Full list: `BEHAVIOUR_CHANGES.md`.

- **Executor:** `interp` restored; command-form `${...}` made inert only at engine arguments (`no_api_expand`); failsafe on a broken flow opt-in (`ENRS_FAILSAFE_ON_FLOW_ERROR`); inline transfer still runs unless `ENRS_IVR_BLOCK_INLINE_TRANSFER`; transfer refuses only whitespace; webhook back to its direct `curl`, URL escaped and passed with `--url`; ENS lookups send the routed number.
- **Protected variables:** only command-running names and `uuid` (`utils/ivrProtectedVars.js`).
- **Validator:** transfer destination/context refuse whitespace only; any dialplan except `inline`; webhook scheme rule removed.
- **REST proxy:** redirects followed again with checks; fetch()'s default headers and decompression; 10 MiB cap; mapping names unrestricted except command-running ones.
- **ENS:** `ensLookup` cross-tenant 404 with `ivr_number`; engine keeps `ORIGINATE_ERROR` for rejections while dialing, ignores rejections of answered calls, `skipped` / `expired` after cancel / expiry.
- **ERS:** plain non-numeric caller IDs pass through again.
- **Passwords:** no maximum. **Frontend:** checklist without the maximum; `qs()` sends `''` again.
- **Compatibility report:** service numbers whose dialplan meaning changed; fixed REST URLs the proxy refuses.
- **Tests:** `restApiNode` and `sayVariableFallback` restored to the original text; characterization tests added (see TEST_RESULTS).

## Cycle 4 — compatibility verification and release readiness — 2026-11-03

Independent re-verification; see `CYCLE4_COMPATIBILITY_REPORT.md`. No git operation, no database or DEV access.

- **Executor transfer** (`nodeTypes/registry.js`): refuses only a substituted value that adds a word; author-written words, trailing spaces and contexts pass unchanged; `inline` named as the destination's dialplan word follows the inline policy.
- **Validator** (`validators/ivrValidator.js`): whitespace rules on destination / context removed; `inline` as the destination's dialplan word refused.
- **ENS start-by-config** (`ensInternalController.js`): refuses only a routed number registered to another tenant; an unregistered routed number starts the blast with a warning (strict with `ENS_REQUIRE_IVR_NUMBER=true`).
- **Conference access** (`middleware/conferenceAccess.js`): any room name without whitespace or control characters.
- **ERS caller identity** (`ersRingService.js`): `$` kept in names; empty number passed empty.
- **ERS report** (`routes/v1/reports.js`): summary `responders` counts every responder row again.
- **Designer** (`PropertyPanel.jsx`): a stored value missing from a dropdown is shown as it is.
- **Compatibility report** text and IVR_AUDIT / SECURITY_REVIEW updated to the narrowed rules.
- **Tests:** new `integration/ensAttemptSettlement.test.js` (15, real PostgreSQL); characterization cases in `executorSecurity`, `ivrCycle3Boundaries`, `conferenceTenantIsolation`, `ersOriginateInjection`; stale comment fixed in `ivrTrustBoundaries`.
- **Docs:** `CYCLE4_COMPATIBILITY_REPORT.md`, `FINAL_BUSINESS_LOGIC_REGRESSION_MATRIX.md`, `REAL_FREESWITCH_TEST_PLAN.md`, `RELEASE_BLOCKERS.md`; BEHAVIOUR_CHANGES, TEST_RESULTS, BUG_TRACKER updated.

## Cycle 5 — isolated FreeSWITCH staging and business acceptance — 2026-11-04

Real calls on a disposable FreeSWITCH 1.10.12 in a private network namespace; see `STAGING_VERIFICATION_REPORT.md`.
No git operation, no DEV or production access; no compatibility switch enabled (the failsafe global was set on the
disposable switch for its one test and reset).

- **C5-1 Deploy** (`utils/ivrGraphValidator.js`, `validators/ivrValidator.js`, `services/deploymentEngine.js`): Deploy re-checks an already-published version only with the rules it was published under (`PublishedNodeSchema` / `PublishedGraphSchema`); the later security rules become warnings. Publish is unchanged. Stale validator comment corrected.
- **C5-2 ENS settlement** (`services/campaignEngine.js`): the hangup is noted when its event arrives and settles the attempt; the originate result settles it only when no hangup comes within 2 s (no channel).
- **Tests:** `ivrCycle3Boundaries` +5 (deploy of published versions); `integration/ensAttemptSettlement` +2 (real-switch order, concurrent; result before hangup).
- **RB-1 approved and closed (2026-11-04):** "retry exactly as configured", as a business-behaviour decision. No code or configuration changed by the approval; the "0 = no retries" discrepancy (O-3) stays open separately. Docs updated for consistency.
- **Docs:** `ENS_RETRY_BEHAVIOUR_DECISION.md`, `REAL_FREESWITCH_TEST_RESULTS.md`, `STAGING_VERIFICATION_REPORT.md`, `FINAL_RELEASE_READINESS.md`; BEHAVIOUR_CHANGES, BUG_TRACKER, RELEASE_BLOCKERS, TEST_RESULTS, CYCLE4_COMPATIBILITY_REPORT (REST private-address wording), REAL_FREESWITCH_TEST_PLAN updated.

