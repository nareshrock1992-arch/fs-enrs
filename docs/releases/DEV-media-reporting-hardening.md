# DEV release package — `feature/media-reporting-hardening`

**Status:** ready for a DEV deployment decision. **Not deployed, not merged to `main`.**
Every step below is for a person with DEV access to run. Nothing here has been executed
on the DEV server.

| | |
|---|---|
| Branch | `origin/feature/media-reporting-hardening` |
| Base | `7b40b59` (`media-safety-remediation`, the Media Library UI accepted on DEV) |
| Release candidate | the branch head (see `git log`; at writing `7cabb42` + this release-doc commit) |
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

Run against the DEV database **read-only** (`psql … -c`, no writes):

```sql
-- a) non-SUPER_ADMIN accounts without a tenant: they will be LOCKED OUT after this release.
SELECT id, email, role, is_active FROM users
 WHERE deleted_at IS NULL AND role <> 'SUPER_ADMIN' AND tenant_id IS NULL;

-- b) users whose tenant is inactive/deleted (already refused today; for information)
SELECT u.id, u.email FROM users u JOIN tenants t ON t.id = u.tenant_id
 WHERE u.deleted_at IS NULL AND (t.is_active = false OR t.deleted_at IS NOT NULL);

-- c) how many uploaded files are shared (tenant_id NULL) and so visible to every tenant via /uploads
SELECT count(*) FROM media_files WHERE deleted_at IS NULL AND tenant_id IS NULL;
```

If (a) returns rows, decide **before** deploying: assign a tenant (SUPER_ADMIN →
Users → edit → tenant) or deactivate them. Do not deploy and discover it afterwards.

## 3. DEV server checkout — known blocker

`/opt/freeswitch-ui/fs-enrs` is the live DEV runtime (Vite `0.0.0.0:8100` serves its
source, backend `*:4100`). It is on `media-safety-remediation@7b40b59` with **local
modifications**: tracked `backend/.env`, both `package-lock.json` files, untracked
WAVs/uploads and `.env` backups. A checkout of this branch will **refuse** because
`backend/package-lock.json` is modified locally. Resolving that is the operator's
decision; do not discard the local `.env`.

Suggested sequence (operator runs it, reviewing each step):

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
