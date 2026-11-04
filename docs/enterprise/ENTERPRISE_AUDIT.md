# FS-ENRS Enterprise Audit

Living document. Started 2026-10-31 on `feature/media-reporting-hardening` @ `7f849ed`, working tree only
(no commits, no pushes, nothing deployed). "Verified" means read in code and, where stated, tested.
Earlier hardening work is in `docs/MEDIA_REPORTING_MISSION.md`.

## Coverage so far

| Area | State |
|---|---|
| Repository, routes, auth, RBAC, tenant model | Audited (static + tests) |
| Live conference control (monitoring) | Audited; critical defects fixed |
| Socket.IO event exposure | Audited; all event paths tenant-scoped (Cycle 2) |
| ENS campaign data model and outcomes | Audited; reporting now uses recipient records |
| ERS incident data model | Audited for reporting |
| Reporting and Excel export | Exports added for ENS and ERS |
| ESL command construction | Audited; central line-break guard added |
| IVR validation, generators, REST node | Audited, see IVR_AUDIT.md |
| IVR node handlers (`registry.js`), generated executor, designer validation display | Audited line by line (Cycle 3), see IVR_AUDIT.md |
| ENS campaign engine (retries, cancellation, duplicate events) | Audited (Cycle 3); attempt settling fixed |
| Password policy, CSRF, session tokens | Audited (Cycle 3) |
| Frontend: navigation, dialogs, notices, Audit Log, ENS Campaigns, Dashboard, designer toolbar, list actions | Changed and **viewed in a browser** (Cycle 3, disposable local stack) |
| Frontend: remaining screens (ENS/ERS config forms, Contacts, Users, Settings, Media, Monitoring widgets) | Not reviewed screen by screen |
| TTS integration | **Not audited yet** |
| Upload validation | Covered by the earlier media mission; not re-audited |
| Performance (queries, bundles, memory) | **Not measured yet** |

## Findings

| ID | Severity | Finding | Status |
|---|---|---|---|
| F-01 | Critical | 19 `/monitoring/conferences/:room` control routes had no tenant check: a tenant ADMIN or SUPERVISOR could terminate, kick, mute, record or invite into another tenant's live emergency conference | Fixed |
| F-02 | Critical | Request values went unescaped into one-line ESL commands; a line break could start a second ESL command (`text`, `dial_string`, `extension`, `audio_path`, `path`, `level`) | Fixed: central guard + route validation |
| F-03 | High | `GET /monitoring/conferences` returned every tenant's rooms and caller numbers to any logged-in role | Fixed |
| F-04 | High | `eslService.emit` used `io.emit`: conference and channel events (caller numbers) reached every socket, including sockets not logged in | Fixed: tenant + SUPER_ADMIN routing |
| F-05 | High | `record/start` accepted any caller-supplied path, so SIPCommunication could be told to write any file it can write | Fixed: recording directory only |
| F-06 | Medium | `eslService.js` used `logger` without importing it; that branch threw `ReferenceError` | Fixed; the destination still fails rather than being parked in silence (keeps the effective behaviour) |
| F-07 | Medium | `busy_count` / `no_answer_count` count retried attempts, not recipients; `expireCampaign` leaves counters stale; `answer_time_ms` is never written | Reports compute from recipient rows. Counters themselves unchanged |
| F-08 | Medium | A socket reconnecting with an expired access token got no rooms and no live updates, silently | Fixed: refresh once and retry (not browser-tested) |
| F-09 | Medium | Tenant ADMIN can write global `system_settings` and feature flags (`PUT /settings/:key`) | Fixed: SUPER_ADMIN only, audited |
| F-10 | Medium | `emitInternal` callers for ERS/ENS omit the tenant: logged-in users of every tenant receive them | Fixed: all 23 emissions scoped; unknown tenant goes to SUPER_ADMIN only |
| F-11 | Info | Ownership comes from ERS incidents; a room with no incident is SUPER_ADMIN only, as required | By design |
| F-12 | Medium | No IVR execution history is stored; IVR reports cannot be built from existing data | Open: needs design, see REPORTING_STRATEGY |
| F-13 | Medium | ENS acknowledgements / DTMF responses are not stored (DTMF ESL events are emitted, not persisted); no emergency-type field exists | Open |
| F-14 | Low | `errorHandler` logs every 4xx as "UNHANDLED ERROR" | Open |
| F-15 | Low | Real `.env` files are tracked in git (`GOVERNANCE.md`: known security debt) | Open: needs a history rewrite and rotation, outside this mission's limits |
| F-16 | Low | `console.log` remains in `eslService.js` and `monitoringController.js` (governance Rule O-2 asks for migration when a file is touched) | Open: large mechanical change in emergency code, deferred deliberately |

## Corrections to the Cycle 1 report

Verification in Cycle 2 showed these Cycle 1 statements were wrong or incomplete:

| Claim | Reality | Now |
|---|---|---|
| Fixed conference control routes covered everything | ERS routes also control conferences, with a separate check and no input validation | One shared rule |
| Socket routing was safe to narrow | **Regression:** the socket was never authenticated after login, so the live monitor would have stopped updating after a fresh sign-in. It was hidden until then by the global broadcast and not caught because nothing ran in a browser | Login and logout now drive the socket |
| Socket identity was handled | Re-authentication kept old rooms; a failed one too; logout did nothing; ESL host and port went to unauthenticated sockets; no token-expiry cut-off | All fixed |
| Recording path confined | Could overwrite an existing recording or follow a symlink | `.wav`, new files only |
| SUPER_ADMIN consistent | Blocked from rooms outside the selected tenant, and from 12 IVR and gateway write routes | Fixed |
| 22 changed files | 27 at the start of Cycle 2 | Counted from git |

## Cycle 2 findings

| ID | Severity | Finding | Status |
|---|---|---|---|
| F-17 | High | Any tenant ADMIN could redeploy every tenant's flows, reload the shared dialplan, and read and change `/platform/config` | Fixed: SUPER_ADMIN only. Tenant ADMINs lose Config Center |
| F-18 | Medium | Exports run on the thread serving ESL events: 1.6 s of CPU at the 50,000-row cap | Fixed: worker thread above 2,000 rows |
| F-19 | Medium | On-screen totals disagreed with exports: ERS counted observers as responders, ENS used attempt-based counters | Fixed |
| F-20 | Low | Contact Usage CSV was unescaped and open to spreadsheet formulas | Fixed |
| F-21 | Medium | `alert()` in 20 files blocked the live monitor | Fixed: non-blocking notices |
| F-22 | Medium | Audit records could not be read anywhere | Fixed: Audit Log page, SUPER_ADMIN only |

## Cycle 3 findings (2026-11-02)

| ID | Severity | Finding | Status |
|---|---|---|---|
| F-23 | **High** | Any client, without logging in, could stop the backend: `socket.emit('authenticate', null)` threw while destructuring, socket.io runs listeners outside try/catch, and `server.js` exits on `uncaughtException`. **Present in the committed and pushed code** | Fixed; unit test and real-socket e2e S-31 |
| F-24 | High | ENS retries could be lost: the originate result (`-ERR USER_BUSY` / `-ERR NO_ANSWER`, delivered when the call ends) marked the recipient failed, overwriting the retry the hangup event had just scheduled, and counted it twice. A retryable hangup after cancel left the recipient queued forever | Fixed: one compare-and-set settle per attempt. A rejection while still dialing keeps its old outcome (failed, `ORIGINATE_ERROR`, no retry); after cancel the recipient becomes `skipped`, as cancel does. e2e F-30 on real PostgreSQL. Cycle 5: the timing was observed on a real switch (hangup first); a remaining concurrent-settlement race was fixed (C5-2); behaviour approved 2026-11-04, RB-1 closed (ENS_RETRY_BEHAVIOUR_DECISION.md) |
| F-25 | Medium | Cycle 2 regression: a failed conference event emit became an unhandled promise rejection (vitest exit code 1 while all tests passed) | Fixed: caught and logged |
| F-26 | Medium | Self-service change-password accepted any 8 characters, undoing the complexity rule applied at user creation | Fixed: the creation rule applies to both. (bcrypt reads only 72 bytes; no maximum was added, to keep long passphrases working) |
| F-27 | Medium | The header's Change password button went to a route that does not exist (landed on the dashboard) | Fixed: dialog using the existing API, same rule shown as a checklist |
| F-28 | Medium | ENS Campaigns "All" tab was always empty: the client sent `?status=undefined`. Found in the browser | Fixed for all 27 query builders in the API client |
| F-29 | Medium | Campaign cards showed attempt counters (0 answered where recipients had answered); "Completed Today" counted completed campaigns from any day | Fixed: recipient outcomes from the reports' SQL; date check |
| F-30 | Medium | 20 browser `confirm()` boxes blocked the page, including Terminate conference and Remove participant on the live monitor | Fixed: shared non-blocking dialog; focus starts on Cancel |
| F-31 | Low | 13 failures were silent, e.g. Complete incident on the ERS live board, and the live board showing "no incidents" when it failed to load | Fixed: visible notices (decorative waveform and storage writes stay silent) |
| F-32 | Low | Accessibility: icon-only row actions had no name; clickable rows were mouse-only; the modal had no dialog role or label | Fixed |
| F-33 | Low | Layout: the sidebar took 256 px of a 375 px phone; the IVR designer clipped Publish at 1024 px; dashboard card labels were truncated | Fixed; checked in the browser at both widths |

CSRF: API routes accept only a Bearer header and the refresh cookie is `SameSite=Lax`, so no cross-site request can act
as the user. Login is rate-limited; refresh checks that the account is still active.

IVR findings IVR-6 to IVR-8 and IVR-12 to IVR-17 are in IVR_AUDIT.md. Every behaviour change, and what was rolled back
on 2026-11-03 under the zero-regression requirement, is in BEHAVIOUR_CHANGES.md.
