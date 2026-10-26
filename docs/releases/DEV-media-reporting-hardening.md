# DEV release package — `feature/media-reporting-hardening`

**Status:** ready for a DEV deployment decision. **Not deployed, not merged to `main`.**
Every step below is for a person with DEV access to run. Nothing here has been executed
on the DEV server.

| | |
|---|---|
| Branch | `origin/feature/media-reporting-hardening` |
| Base | `7b40b59` (`media-safety-remediation`, the Media Library UI accepted on DEV) |
| Release candidate | code commit `b0f0be5`; later commits on the branch are documentation-only (verify with §3a step 1) |
| Approval | **deployment requires separate, explicit approval** — nothing in §3 may be run before it |
| Migrations | **none** (no schema change; `audit_logs` is used as is) |
| New env vars | **none** |
| New dependencies | **none** (backend lockfile only gains entries that `package.json` already declared since `6327a96`) |
| Restart needed | backend: **yes**. Frontend (Vite dev server): reloads from source |

## 1. What changes for users

| Area | Before | After |
|---|---|---|
| `/uploads/*` | public, any tenant's audio, no login | login + `media.view` + the file must belong to the caller's tenant (or be shared); otherwise 401/403/404 |
| Accounts without a tenant (non-SUPER_ADMIN) | could log in with unscoped (all-tenant) queries | refused at login/refresh; existing tokens get 403 everywhere except logout |
| Media audio (stream/download/waveform/signed link) | any authenticated role | `media.view` (SUPER_ADMIN, ADMIN, SUPERVISOR, OPERATOR) — VIEWER 403 |
| Recording audio (stream/download/waveform) | any authenticated role | `recordings.view` (SUPER_ADMIN, ADMIN, OPERATOR) |
| Users API | tenant admins could reach SUPER_ADMIN rows in some paths | never; SUPER_ADMIN can assign a tenant; demotion requires one; password reset/change revokes/rotates refresh |
| Socket.IO | events without tenant were broadcast to every socket, even unauthenticated | authenticated sockets only; media events tenant-scoped |
| Reports | page-only summary numbers; some cross-tenant joins; bad dates → 500 | server summary over all matches; tenant-scoped joins; bad filters → 400 |
| Sidebar | Reports/Recordings/Media Library shown to roles that get 403 | hidden for those roles |
| Media Library API | — | new: where-used, trash list, restore, ZIP download (API only; the UI is unchanged) |

Error logs no longer contain `?token=`/`?sig=` values or bcrypt hashes.

## 2. Pre-deployment checks (read-only)

Run against the DEV database **read-only** (`psql … -c`, no writes). None of these
checks has been run on DEV yet — the DEV database has not been inspected, so the
number of affected accounts is **unknown**, not zero.

### 2.1 Accounts that would lose login access

The new login/refresh rule (`backend/src/controllers/authController.js`) refuses an
account that is live and active, is not `SUPER_ADMIN`, and has no tenant. Inactive or
deleted accounts are already refused today, so they are not counted here.

```sql
-- a1) COUNT FIRST — active, non-SUPER_ADMIN accounts without a tenant
SELECT count(*) AS affected_accounts
  FROM users
 WHERE deleted_at IS NULL
   AND is_active = true
   AND role <> 'SUPER_ADMIN'
   AND tenant_id IS NULL;

-- a2) ONLY if a1 > 0 — ids and roles of those accounts (no emails or other personal data)
SELECT id, role
  FROM users
 WHERE deleted_at IS NULL
   AND is_active = true
   AND role <> 'SUPER_ADMIN'
   AND tenant_id IS NULL
 ORDER BY id;
```

(`users.tenant_id` is `ON DELETE SET NULL`, so users of a tenant row that was ever
hard-deleted also appear here.) If a1 is greater than 0, an **authorized operator**
must review and remediate each account **before** deployment — assign a tenant
(SUPER_ADMIN → Users → edit → tenant) or deactivate it. This document does not
authorize any account change, and none is made by these queries.

### 2.2 Other information queries

```sql
-- b) users whose tenant is inactive/deleted (already refused today; for information)
SELECT u.id, u.email FROM users u JOIN tenants t ON t.id = u.tenant_id
 WHERE u.deleted_at IS NULL AND (t.is_active = false OR t.deleted_at IS NOT NULL);

-- c) how many uploaded files are shared (tenant_id NULL) and so visible to every tenant via /uploads
SELECT count(*) FROM media_files WHERE deleted_at IS NULL AND tenant_id IS NULL;
```

### 2.3 Schema check — every column the new SQL relies on

The release adds no migration; its new and changed queries assume the columns below
exist (verified against `backend/src/db/schema.sql` and `backend/src/db/migrations/`;
`recordings` is the renamed `conference_recordings`, migrations 022/026). The isolated
test run used a **fresh** install, while DEV is an upgraded database — this check is the
guard against schema drift. The query lists only what is **missing**:

```sql
SELECT req.table_name, req.column_name AS missing_column
  FROM (VALUES
    ('audit_logs','action'), ('audit_logs','created_at'), ('audit_logs','details'),
    ('audit_logs','entity_id'), ('audit_logs','entity_type'), ('audit_logs','user_id'),
    ('emergency_contacts','deleted_at'), ('emergency_contacts','first_name'),
    ('emergency_contacts','last_name'), ('emergency_contacts','mobile_number'),
    ('emergency_contacts','organization_id'),
    ('ens_campaigns','answered_count'), ('ens_campaigns','status'), ('ens_campaigns','total_destinations'),
    ('ens_configurations','tenant_id'), ('ers_configurations','tenant_id'),
    ('ers_incident_responders','ers_incident_id'), ('ers_incident_responders','status'),
    ('ers_incidents','cancelled_at'), ('ers_incidents','ended_at'),
    ('ers_incidents','started_at'), ('ers_incidents','status'),
    ('media_files','deleted_at'), ('media_files','duration_sec'), ('media_files','fs_path'),
    ('media_files','is_deployed'), ('media_files','path_or_uri'), ('media_files','size_bytes'),
    ('media_files','tenant_id'), ('media_files','updated_at'),
    ('organizations','tenant_id'),
    ('recordings','conference_room'), ('recordings','deleted_at'), ('recordings','incident_uuid'),
    ('recordings','recording_path'), ('recordings','started_at'), ('recordings','tenant_id'),
    ('responder_group_members','emergency_contact_id'), ('responder_group_members','responder_group_id'),
    ('responder_groups','deleted_at'), ('responder_groups','name'),
    ('users','is_active'), ('users','refresh_token_hash'), ('users','role'), ('users','tenant_id')
  ) AS req(table_name, column_name)
 WHERE NOT EXISTS (
   SELECT 1 FROM information_schema.columns c
    WHERE c.table_schema = current_schema()
      AND c.table_name = req.table_name AND c.column_name = req.column_name);
```

**Safe result: 0 rows** (45 columns are checked). Any returned row is a required column
the application will query but the DEV schema lacks — those endpoints would fail with a
500. **Stop the deployment** and investigate the migration state; do not add columns by
hand under this release. (The check lists missing columns instead of counting matches,
and is limited to `current_schema()`, so same-named tables in another schema cannot
hide a gap.)

### 2.4 Active work — the restart must not cut live operations

The backend keeps live call state **in memory** (`backend/src/services/eslService.js`:
conference registry, ERS channel map; `backend/src/services/ersRingService.js`: active
ring loops, up to 2 h per conference). A restart drops it: ring waves stop and ESL
events for calls in progress are lost (participants/hang-up causes not recorded).
The ENS campaign engine (`campaignEngine.js`) processes campaigns with status
`queued`/`running` and, on start, only resets destinations stuck in `dialing` for
over 90 s back to `queued` (so a call that did connect may be dialled again) and
completes `answered` rows older than 600 s.

```sql
-- d1) ERS incidents still in progress (statuses per ers_incidents_status_check)
SELECT count(*) AS ers_in_progress FROM ers_incidents
 WHERE deleted_at IS NULL AND status IN ('ACTIVE', 'QUEUED');

-- d2) callers waiting in an ERS queue (statuses per ers_queues_status_check, migration 019)
SELECT count(*) AS ers_queued_callers FROM ers_queues WHERE status = 'QUEUED';

-- d3) ENS campaigns the engine is working on (statuses per migration 008)
SELECT count(*) AS ens_campaigns_active FROM ens_campaigns WHERE status IN ('queued', 'running');

-- d4) ENS calls in flight (ens_campaign_destinations statuses per migration 008)
SELECT count(*) AS ens_calls_in_flight FROM ens_campaign_destinations WHERE status IN ('dialing', 'answered');
```

**Safe result: all four are 0.** If any is non-zero, **postpone** the restart until it
is 0. An `ACTIVE` incident that is clearly abandoned (no live conference) still counts:
closing it is an operational decision outside this release. Limitation: these queries
see only what is persisted — a caller in an IVR at the moment of the restart (the Lua
scripts call `/api/v1/internal/*` over HTTP) is not visible here and may hear a failure
during the few seconds of downtime. The repository documents no live-channel check, so
pick a low-traffic window using the operator's own procedure.

### 2.5 Node.js

`backend/package.json` requires `"engines": { "node": ">=20" }` (the ZIP code bundles
its own CRC-32 precisely so that 20.0 works; `zlib.crc32` would need 20.15). Check on DEV,
as the user that runs the backend: `node -v` must print v20 or later. Not yet verified on DEV.

## 3. DEV server checkout — known blocker

`/opt/freeswitch-ui/fs-enrs` is the live DEV runtime (Vite `0.0.0.0:8100` serves its
source, backend `*:4100`). It is on `media-safety-remediation@7b40b59` with **local
modifications**: tracked `backend/.env`, both `package-lock.json` files, untracked
WAVs/uploads and `.env` backups. A checkout of this branch will **refuse** because
`backend/package-lock.json` is modified locally. Resolving that is the operator's
decision; do not discard the local `.env`.

**Gate:** run this section only after (1) explicit deployment approval and (2) all §2
checks have the safe result (2.1 = 0 or every listed account remediated, 2.3 = 0 rows,
2.4 all 0, 2.5 Node ≥ 20).

Suggested sequence (operator runs it, reviewing each step). `npm ci` deletes and
re-creates `backend/node_modules` while the old process is still running; restart the
backend **immediately** after it finishes so the old process does not load modules
lazily from a half-installed tree.

```bash
cd /opt/freeswitch-ui/fs-enrs
git status --short                                     # review local changes first
cp backend/.env ~/fs-enrs.env.before-media-hardening   # keep a copy of the real .env
git diff --stat backend/package-lock.json frontend/package-lock.json   # what is local?
# If the local lockfile edits are only npm's own rewrite: save them, then restore the tracked copy
git diff backend/package-lock.json > ~/backend-lock.local.diff && git checkout -- backend/package-lock.json
git fetch origin feature/media-reporting-hardening
git checkout feature/media-reporting-hardening         # backend/.env stays as is
cd backend && npm ci && cd ..                          # lockfile now matches package.json
# restart the backend the way DEV runs it (pm2, as root on DEV)
```

## 3a. Verify what is deployed and running

1. **Checked-out code** (on the DEV server):
   ```bash
   cd /opt/freeswitch-ui/fs-enrs
   git rev-parse HEAD                                    # must be the approved commit
   git diff --stat b0f0be5 HEAD -- backend frontend      # must print nothing (doc-only after b0f0be5)
   ```
2. **Process restarted after the checkout.** The PM2 name in
   `backend/ecosystem.config.cjs` is `fs-enrs-backend`; confirm the actual name on DEV with
   `pm2 list` first (DEV's process was not inspected for this document), then
   `pm2 describe fs-enrs-backend` — its start time must be later than the checkout, and
   `cwd` must be `/opt/freeswitch-ui/fs-enrs/backend`.
3. **Behaviour fingerprint** (backend port: `PORT`, default 4100 in `src/config/index.js`):
   ```bash
   curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:4100/uploads/__probe__
   ```
   New code: **401** (`requireAuthOrToken` before `/uploads`). Old code (`7b40b59`):
   **404** (`express.static` falls through to the catch-all). This only proves that the
   running process has the new `/uploads` handler — it is a supplementary signal, not
   proof that every changed file is live; steps 1–2 and the smoke test still apply.

## 4. Smoke test after the restart

1. Log in as a tenant ADMIN → Media Library loads; play a file; download a file.
2. Same user: `GET /uploads/<own file>` with the session works in the browser (via the UI);
   a logged-out browser gets 401.
3. Log in as VIEWER → no Media Library / Reports / Recordings in the sidebar.
4. ERS Reports and ENS Reports load; the summary line does not change when paging;
   an expanded ENS campaign shows its destinations.
5. Delete an unused test file → it appears in `GET /api/v1/media-library/trash`;
   `POST /api/v1/media-library/<id>/restore` brings it back (deployed copy restored).
6. Backend log: no `UNHANDLED ERROR` blocks with status 500 during the above.

## 5. Rollback

No schema or data migration, so rollback is code only:

```bash
cd /opt/freeswitch-ui/fs-enrs && git checkout media-safety-remediation   # 7b40b59
# restart the backend
```

Rows written by the release that stay after a rollback (harmless): `audit_logs` entries
`media_deleted` / `media_restored`, and files restored from `.deleted/`.

**Dependencies on rollback.** The deployment changes only `backend/package-lock.json`:
+46 / −0 lines, adding five packages that are all `"dev": true` (fengari 0.1.5,
fengari-interop 0.1.4, readline-sync 1.4.10, sprintf-js 1.1.3, tmp 0.2.7 — Lua test
tooling: `fengari` and `fengari-interop` are devDependencies in `backend/package.json`
since `6327a96`, the other three are `fengari`'s own dependencies). No entry was removed or
changed, and neither `package.json` differs between `7b40b59` and this release. So the
`node_modules` installed by the deployment holds every runtime package of `7b40b59` at
the same version, plus five dev-only packages, and the rollback needs **no** dependency
installation. **Do not run `npm ci` after rolling back:** the `7b40b59` lockfile lacks
those five entries, and `npm ci` refuses a lockfile that does not match `package.json`
(the reason it was repaired). To return the checkout to its exact pre-deployment state,
re-apply the saved local lockfile edits: `git apply ~/backend-lock.local.diff`.

Limitations: this rollback has **not been tested** on DEV or in the isolated
environment. The reasoning above is from the lockfiles and manifests only. Run
`git status --short` after the rollback and repeat the §3a fingerprint (expect 404).

## 6. Evidence

- Full backend suite: base `7b40b59` **1546 tests / 24 failing**; release **1642 / 24
  failing**, the identical 24 pre-existing failures by name (conferenceProvider 1,
  ersCallerNamePresentation 8, gatewayFileProvider 4, infrastructure.eventBus 2,
  ivrGraphValidator 1, sofiaProvider 2, switchConfParser 2, varsParser 2, xmlGenerator 2).
- Frontend: 249/249 (base 233/233); production build OK.
- Isolated end-to-end run (disposable clone, private network namespace with only
  loopback, throw-away PostgreSQL 18, DEV ports verified unreachable, nothing left
  behind): functional 39/39, security 29/29, 1 known observation (legacy `?token=` still
  accepted — deprecated). Logs: no JWTs, token/sig values or secrets.
- Independent reviews: Phase 1/2 security review and Phase 3 reporting review; all
  confirmed findings fixed and re-tested. Details: `docs/MEDIA_REPORTING_MISSION.md`.

## 7. Known open items (not in this release)

- Revocation window: an access token (15 min) or signed media link (≤ 1 h) stays valid
  after a user is deactivated or moved; refresh is refused immediately.
- ERS/ENS/campaign socket events are not yet scoped per tenant (telephony code).
- Legacy `?token=` URLs still accepted (deprecated).
- Tenant ADMIN can change platform-wide configuration — product decision.
- Media Library UI: bulk download still downloads files one by one; switching it to the
  new ZIP endpoint, and a Trash view, are UI changes awaiting approval.
- Undeploy: design only (`docs/MEDIA_UNDEPLOY_DESIGN.md`).
