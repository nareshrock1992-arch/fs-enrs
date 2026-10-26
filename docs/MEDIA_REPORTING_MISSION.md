# Media Library / Reporting mission — progress tracker

Branch: `feature/media-reporting-hardening` (created from `7b40b59`). Never merged to main by this mission.
WSL test checkout `/opt/freeswitch-ui/fs-enrs`: on `media-safety-remediation@7b40b59` with local edits
(tracked `backend/.env`, both lockfiles, untracked wavs/uploads) — it is the LIVE DEV runtime (Vite :8100 on
0.0.0.0 serves its source; backend :4100). Pulling there changes live DEV → needs a backend restart (approval).

## Phase checklist
- [x] Phase 0 — repo verified; server checkout inspected read-only. (Audit agents B/C/D were stopped
      before reporting: usage limit. Re-run them.)
- [x] Phase 1 — tenant isolation. Implemented + unit-tested (uncommitted at time of writing). Delivered:
  - `middleware/tenantScope.js`: `isValidTenantId`, `hasTenantContext`, `parseTenantParam`
    (malformed SUPER_ADMIN tenant_id → 400), `effectiveTenantId`/`requireTenantForWrite` fail closed (403).
  - `middleware/auth.js`: requireAuth/requireAuthOrToken reject tenant-less non-SA (403
    TENANT_CONTEXT_REQUIRED); new `requireAuthSelf` (logout only — D1 least privilege).
  - `middleware/mediaAccess.js`: signed links for tenant-less identities → 403.
  - `controllers/authController.js`: login/refresh refuse tenant-less non-SA; change-password rotates
    the refresh token.
  - `routes/v1/auth.js`: logout uses requireAuthSelf.
  - `routes/v1/users.js`: scope via effectiveTenantId; tenant admins can never read/update/delete
    SUPER_ADMIN rows; SA may assign tenant (D3); demotion/active tenant-less account requires tenant_id;
    password reset clears refresh_token_hash.
  - `controllers/mediaLibraryController.js`: emitMediaEvent tenant-scoped + sanitized (it is never wired:
    setSocketIO is not called); buildMediaFilter uses effectiveTenantId.
  - `controllers/recordingController.js`: buildRecordingFilter uses effectiveTenantId.
  - `services/socketService.js`: tenant-less sockets join no rooms; every authenticated socket joins
    `authenticated`; `emitInternal` without a tenant goes to `authenticated` only (was a global
    broadcast to unauthenticated sockets too), with a tenant to `tenant:X` + `role:SUPER_ADMIN`.
  - media access/stream/download/waveform require `canViewMedia`; recordings stream/download/waveform
    require `adminOrOp` (recordings.view).
  - `/uploads`: `express.static` replaced by `middleware/uploadsAccess.js` (auth + media.view + live
    media_files row in caller's tenant or shared; traversal/dotfile/symlink-escape → 404; no-store).
  - `asyncHandler` error log: `token`/`sig` redacted also when the name is percent-encoded; bcrypt
    hashes in SQL params redacted.
  - login: password is checked before account-state answers (no orphan/inactive-tenant enumeration).
  - upload duplicate check scoped to the caller's tenant (+ shared) — no cross-tenant 409 oracle.
  - Tests: `tenantIsolation.test.js` (30), `mediaTenantIsolation.test.js` (15), updated
    `mediaRecordingsRbac`, `recordingsList`. The DB emulators apply the tenant filter only when the SQL
    text contains the clause; mutation check (clause removed in a disposable clone) fails the suites:
    media getById 3 fail, users GET /:id 1, uploads 1, recordings 1.
  - Results: focused 4 files 139/139 pass; full backend 1591 tests, 24 failing = the known pre-existing
    baseline (conferenceProvider 1, ersCallerNamePresentation 8, gatewayFileProvider 4, eventBus 2,
    ivrGraphValidator 1, sofiaProvider 2, switchConfParser 2, varsParser 2, xmlGenerator 2). No new failure.
- [x] Phase 2 — isolated security run + independent review. PASS.
  - Isolated run (disposable WSL clone = `7b40b59` + this overlay, private network namespace with only
    `lo`, throw-away PostgreSQL 18 on 127.0.0.1:55432, backend :4200; DEV ports 5432/6379/8021/5000/
    4100/8100 verified unreachable; host verified unable to reach 4200/55432; everything removed after):
    functional 27/27, security 22/22 (S-1…S-22), 1 known observation (K-TOKEN: legacy `?token=` still
    accepted — deprecated, decision pending). In-namespace unit runs: backend focused 260/260, frontend
    focused 101/101, frontend full 233/233. Logs: 0 unhandled errors, 0 JWTs, 0 token/sig values,
    0 secret values, 0 postgres ERROR lines; all TCP connections loopback.
  - Harness bugs fixed on the way (test harness only, not application code): S-2 replayed the link on
    the same file; `l0.files` → `l0.json.files`; duplicate `const still`; S-5 SUPERVISOR upload used
    audio byte-identical to a tenant-A file (a correct same-tenant 409) → unique tone. New S-22 covers
    the tenant-scoped duplicate check (A=201 for B's audio, B=409 for its own).
  - Independent review (agent): items 1–6 of Phase 1 confirmed. Findings fixed: global socket broadcast,
    emulator strictness, symlink escape, login enumeration, encoded-name/hash log leaks, cross-tenant
    dedupe 409. Accepted/documented (not changed):
    - Revocation window: an access JWT (15 min) or a signed media link (≤ 1 h) stays valid until expiry
      after a user is deactivated/demoted/moved; refresh is refused immediately. Closing it needs a
      per-request user lookup or token versioning — a design decision, not in this mission.
    - ERS/ENS/campaign `emitInternal` callers still pass no tenant → all authenticated sockets of every
      tenant receive them. Per-tenant scoping touches telephony controllers (out of scope).
    - Platform config writable by tenant ADMIN — product decision (see Decisions).
- [x] Phase 3 — Reporting. PASS.
  - Backend `routes/v1/reports.js`: playback access log tenant-scoped (via the ERS configuration in
    `audit_logs.details`); ERS detail recording = same tenant, `incident_uuid` → exact path → room only
    inside the incident window (ended_at / cancelled_at / now while ACTIVE / start+2 min); responders no
    longer duplicated per group (groups joined); ENS delivery names only from the own tenant (one row);
    filters validated → 400 (dates `YYYY-MM-DD`, from ≤ to, org_id int, status token, uuid ids — incl.
    `ens-campaigns/:id`, which is a UUID); malformed paging → defaults; `/ers` + `/ens-campaigns` return
    a `summary` over the whole filtered set.
  - Frontend: ERS/ENS report summary from the server (was page-derived); error state + Retry, stale rows
    cleared, latest-request guard; legacy Notification Report statuses = DB CHECK values, CSV RFC 4180 +
    formula-safe; sidebar hides Reports/Recordings/Media Library for roles the API refuses
    (`reports.view` = adminOrOp, `visibleNav`).
  - Docs: 18-reporting-guide (params, statuses, metrics incl. `no_answer_count` = not answered incl.
    still-INVITED, DB-timezone day bounds, summary), 14-recording-guide, media-rbac.
  - Review agent findings fixed: campaign id is UUID (was a 400 regression), cancelled-incident window,
    Retry page, uuid cast for index use; boot-scan recording limit documented.
  - Tests: `reportsRoutes.test.js`, `reportState.test.js`; isolated e2e R-1…R-9 against real PostgreSQL.
  - Note: `errorHandler` logs every error incl. 4xx as "UNHANDLED ERROR" (pre-existing, unchanged) — the
    4 blocks in the e2e log are R-7's deliberate 400s.
- [ ] Phase 4 — trash/restore/audit, ZIP (store-only, no new dep), undeploy design. Where-used DONE: `GET /media-library/:id/references` (media.view, tenant 404, other-tenant refs only counted, scan failure 503); e2e F-21/S-23.
- [ ] Phase 5 — regression baseline. Lockfile part DONE: `backend/package-lock.json` +46/−0 (fengari
      0.1.5, fengari-interop 0.1.4, readline-sync 1.4.10, sprintf-js 1.1.3, tmp 0.2.7 — declared in
      package.json since 6327a96 but missing from the lock); clean `npm ci` exit 0, lock unchanged after.
- [ ] Phase 6 — commit/push feature branch; server pull gated (live DEV).
- [ ] Phase 7 — DEV release package.

## Decisions taken (least privilege)
- D1: tenant-less accounts may only log out. D2: malformed SUPER_ADMIN tenant_id → 400.
- D3: SUPER_ADMIN may set tenant_id on non-SA users; demoting a SA requires one.
- Platform config (tenant ADMIN can change platform-wide config): left unchanged — changing it could lock out
  single-tenant operators; needs a product decision.
- ERS/ENS/campaign socket broadcasts without tenant: out of scope (telephony), documented only.
