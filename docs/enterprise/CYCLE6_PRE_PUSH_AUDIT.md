# Cycle 6 — Pre-Push Audit and UI Completion Verification (2026-11-04)

Audit only: no application code, customer configuration, DEV, production or FreeSWITCH process was touched; no
commit, push or deploy. Browser checks ran against a disposable, loopback-only stack (throw-away PostgreSQL, synthetic
data, telephony pointed at closed ports) built from a clone verified byte-identical to the working tree.

Classes: **TESTED** (exercised this cycle, or in Cycle 5 where stated) · **IMPLEMENTED** (code present, not exercised)
· **NOT TESTED** · **MISSING**.

## Phase 1 — Git safety

| Item | Finding |
|---|---|
| Branch / HEAD | `feature/media-reporting-hardening` @ `7f849ed`, equal to `origin/feature/media-reporting-hardening` |
| Working tree | 81 modified, 36 untracked entries (135 files when untracked directories are expanded); no staged, deleted or renamed entries |
| Belongs to Cycles 1–5 | All 81 modified files and all untracked code, test and doc files (backend controllers / routes / services / validators / utils, new middleware and services, tests; frontend layout, UI, pages, new components; `docs/enterprise/`) |
| Tested code = working tree | All 127 non-doc changed files hashed: identical (line endings aside) to the clone used for Cycle 5 staging and for this cycle's runs |
| Accidental / not part of this release | `TENANT_UNIFICATION_PROMPT.md` (repository root): a task prompt for a separate organization-to-tenant unification job, created 2026-11-03 13:02, not by this mission. Its content was read as data only; nothing in it was acted on |
| Credentials | Scan of every changed file: no real secret. `backend/.env.example` `ESL_PASSWORD=ClueCon` is unchanged from HEAD (FreeSWITCH's documented default). Test files contain synthetic fixture passwords only. The tracked `backend/.env` and `frontend/.env` (known debt F-15) are **not** modified |
| Generated data / staging artefacts | None in the repository. All harnesses, logs and evidence live outside it |
| Evidence loss | The session scratchpad was wiped between cycles: the Cycle 5 harness (`stg/`, `iso/`) and the per-test evidence (`evidence-stg*`, `evidence-ui-c5`, failure lists) **no longer exist**. Surviving raw logs of staging runs 1–4 and the release harness were recovered from WSL `/tmp` into the scratchpad `evidence-c6/recovered/`. The Cycle 5 documents' evidence paths are therefore partly stale |

## Phase 2 — Media Library (approved redesign, committed in `7b40b59` and later commits; browser-verified this cycle)

| Requirement | Status | Evidence (Cycle 6, browser unless stated) |
|---|---|---|
| Dense sortable table | **TESTED** | 14 rows; Name sort A→Z with `aria-sort="ascending"`; sortable Category / Duration / Size / Uploaded headers present (only Name exercised) |
| Multi-select | **TESTED** | Row checkboxes (labelled per file), header checkbox in its partial state; selection survives paging by design (unit tests) and is cleared on filter change (seen) |
| Selection count and bulk action bar | **TESTED** | "3 selected · Clear selection"; ADMIN: Download, Move to category…, Delete N; OPERATOR: Download only |
| Filter chips and Clear All | **TESTED** | Chips `Search: "menu"` and `Category: IVR Prompt` with "totals above reflect these filters"; Clear all reset search, category and chips (12 rows back) |
| Docked audio player | **TESTED** (playback) | Docked bar with prev / back / play-pause / forward / next, time bar, speed, volume; playback used the signed stream (`/access?purpose=stream` → `/stream?sig=…` 206). Prev / next and speed buttons not individually exercised |
| Metadata drawer | **TESTED** (view) | Overview, deployment ("Deployed to SIPCommunication", file), audio (codec, rate, channels, bitrate, duration, size), library (uploader, version, SHA-256), actions. **Edit-and-save from the drawer NOT TESTED** this cycle |
| Safe deletion dialog | **TESTED** | Dialog states that files in use by an IVR flow, ENS/ERS configuration or active campaign are kept and listed, and deleted files are quarantined |
| Multi-file upload queue | **TESTED** (with a synthetic file pick) | 3 files queued ("0 of 3 uploaded") → 2 uploaded, `notes.txt` rejected by the server with "Unsupported file type…"; per-file status, failed item removable; "2 of 3 uploaded". Files were injected with a `change` event because the OS file chooser cannot be driven. **Drag-and-drop NOT TESTED** (a synthetic drop event did not register). No client-side type filter: a non-audio file is queued and rejected only by the server |
| Bulk API authorization and tenant isolation | **MISSING as a dedicated bulk API, by design.** Bulk actions run in the browser, one per-file request at a time, through the existing endpoints. The original "Phase 2 bulk APIs" were never started. **Per-item authorization TESTED** | Tenant B admin on tenant A's file: GET / PUT / DELETE / signed-link 404, own list 2 files; OPERATOR and SUPERVISOR delete 403, OPERATOR edit 403, VIEWER list 403; file intact |
| Per-item bulk operation results | **TESTED** (delete) | "2 completed, 1 not completed · In use — not deleted (1): Main menu", listing the draft and the published flow version; only the failed item stays selected. Bulk Move to category and bulk Download results NOT TESTED |
| Existing signed download | **TESTED** (API path from the page; the button itself not clicked so no file was saved) | `/access?purpose=download` → `/download?sig=…` 200 `audio/wav`, attachment, RIFF; no signature 401; download signature reused for stream 401; replayed on another file 401; expiry 3600 s. Observation: attachment name has no `.wav` extension ("Goodbye") |
| Bulk ZIP download, Trash view | Deferred (as instructed) | Backend endpoints exist in HEAD (`POST /download-zip`, `GET /trash`, `POST /:id/restore`); no UI in this audit |

## Phase 3 — Other UI

| Screen / behaviour | Cycle 5 browser | Cycle 6 browser | Notes |
|---|---|---|---|
| IVR Designer (canvas, property panel) | TESTED | — | Ten-node flow rendered; Transfer panel |
| IVR publishing | TESTED (edit → Publish v2) | — | |
| IVR deployment | — (staging deploy via API on the real switch) | TESTED | With the switch unreachable: green "Deployment succeeded" plus amber warnings "Configuration reload skipped… files are deployed but not confirmed live". Pre-existing: a green headline for an unconfirmed deploy, and server paths shown to tenant admins |
| Legacy inline transfer | TESTED (dropdown shows "inline (current value, …)") | — | Calls: real switch, Cycle 5 |
| ENS configuration screens | — | TESTED | List ("3 × 60s"), edit form sections. Retry section shows "0 = no retries" (O-3) and a "Retry Failed Only" checkbox the engine does not read (pre-existing, documented); nothing saved |
| ENS campaign screen | — | TESTED | Empty state; populated card after a synthetic campaign (1 recipient, failed, "Not reached: 1"); Refresh updates the list |
| ENS / ERS reports | TESTED (with real call data) | — | Excel 16 opened six exports (Cycle 5) |
| Audit Log permissions | TESTED (SUPER_ADMIN all tenants; tenant ADMIN redirected) | — | |
| Dark theme | TESTED (ENS report, navigation) | — | |
| Error messages / loading states | partial | TESTED | Login: generic "Invalid email or password"; loading placeholders ("Loading flow…", "Loading dashboard…"); empty states (campaigns); server rejection in the upload queue; in-use refusal dialog |
| Role-gated UI (OPERATOR) | — | TESTED | No Upload / Scan / Administration; media rows Play / Details / Download only |
| **Not browser-tested in Cycles 5–6** | | | ERS configuration form, Live Monitoring, ERS Live View (needs live conferences), Service Registry, Users / Tenants, General Settings, Config Center, Telephony Gateways, Recordings page, Contacts / Groups, phone layout, browsers other than the in-app one |

## Phase 4 — Regression (current working tree)

| Check | Result | Baseline |
|---|---|---|
| Backend unit + Lua (full) | 1972 tests, **23 failing** | Same 23 names as Cycle 5 (and Cycle 4): `ersCallerNamePresentation` 8, `gatewayFileProvider` 4, `infrastructure.eventBus` 2, `sofiaProvider` 2, `switchConfParser` 2, `varsParser` 2, `xmlGenerator` 2, `conferenceProvider` 1 |
| Integration, throw-away PostgreSQL 18 | HEAD 188/243, working tree 205/260 | **Same 7 failing names on both**: `campaignAuthorization` 1, `dialResolver` 1, `ersRingAllPhase5` 1, `ivrLifecycle` 2, `tierStatus` 2. Nothing fails on one side only |
| Frontend | 276/276; production build OK; lint 0 errors (793 older warnings) | unchanged |
| Real FreeSWITCH staging, e2e functional / security | Not re-run (code unchanged since; harness lost). Cycle 5 results stand: staging 28/29 (one pre-existing ERS limitation), e2e 47/47 and 39/39 — raw logs recovered | — |

**No new regression.** The baseline failures are reported as they are; none was hidden, rewritten or reclassified.

## Phase 5 — Release gate

1. **Completed functionality**
   - **Media Library redesign:** the items marked TESTED above.
   - **Cycles 1–5 security and isolation work:**
     - conference and socket tenant isolation;
     - the audit log;
     - reporting integrity;
     - IVR publish rules;
     - REST proxy rules;
     - password policy.
   - **Real-switch behaviour:**
     - C5-1: deploy of older flows;
     - C5-2: ENS retries exactly as configured (RB-1 approved);
     - IVR, ENS and ERS verified on FreeSWITCH 1.10.12.
2. **Pending UI functionality** (approved as deferred): bulk ZIP download UI and the Trash view. Optional bulk undeploy (D-U2) has not been decided.
3. **Missing functionality:**
   - A server-side bulk API. Bulk actions are client-side by design, with server checks per item.
   - Client-side file-type filtering in the upload queue.
4. **Untested functionality:**
   - **Media Library:** drag-and-drop upload; edit-and-save from the drawer; bulk Move to category; bulk Download; the player's previous/next and speed controls.
   - **Screens:** those listed under "Not browser-tested".
   - **Telephony:** the customer trunk (RB-8).
   - **Switches:** every opt-in switch enabled together.
   - **DEV data:** RB-3 and RB-4.
5. **Security concerns, none new from this release candidate:**
   - O-4: the ESL password is stored in clear in `esl_connections`, and the dev seed prints the seed admin password.
   - F-15: `.env` files tracked in git.
   - The legacy `?token=` is still accepted.
   - IVR-10: the internal API key is visible on the curl command line.
   - IVR-6: credentials have no tenant scope until `_TENANT_IDS` is set.
   - The Deployment screen shows server file paths to tenant admins.
6. **Existing baseline failures:** 23 backend unit and 7 PostgreSQL integration failures, listed in Phase 4. All are present at HEAD and none is new.
7. **DEV compatibility requirements:**
   - After deployment, Deploy each IVR flow once to regenerate the executor.
   - Run `node scripts/ivr-compat-report.js` (read-only) for RB-3 and RB-4.
   - Keep all opt-in switches off.
   - Decide RB-5 (the tenant ADMIN and incident-less conference permission changes) **before** DEV users see them.
   - Do one supervised test call per service (RB-8).
   - Tell customers that configured ENS retries now really happen (RB-1).
8. **Files safe to commit:** all 81 modified files and every untracked path except the one below. That includes `backend/scripts/ivr-compat-report.js`, the new middleware, services and utils, the new tests, the new frontend components and pages, and `docs/enterprise/`.
9. **Files requiring further review:**
   - `TENANT_UNIFICATION_PROMPT.md`: exclude from this release. It is unrelated work; keep or move it as you prefer.
   - The evidence paths in the `docs/enterprise/` Cycle 5 documents point to scratchpad folders that no longer exist. Update them, or accept them as historical, before committing.
   - The tracked `backend/.env` and `frontend/.env` are unchanged and must stay out of any commit of changes.
10. **Final recommendation: SAFE TO PUSH**, to the feature branch, for deployment to DEV. The conditions are:
    - commit everything in item 8 and leave out `TENANT_UNIFICATION_PROMPT.md`;
    - accept or update the stale evidence paths;
    - confirm RB-5 before the code is activated on DEV.

    **Production remains NOT READY:** RB-3 and RB-4 (DEV data), RB-5 and RB-8 are open.
