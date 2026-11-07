# DEV Migration 051 — Deployment Report

Date: 2026-11-06, 18:54 – 18:58 (+03). Environment: DEV (WSL Ubuntu 26.04 on `DESKTOP-T2KFM9C`, `NODE_ENV=development`).
Approved by the owner after [DEV_MIGRATION_051_READINESS.md](DEV_MIGRATION_051_READINESS.md) and
[DEV_MIGRATION_051_FINAL_COMPATIBILITY_REVIEW.md](DEV_MIGRATION_051_FINAL_COMPATIBILITY_REVIEW.md).

## 1. Deployed release

| Item | Value |
|---|---|
| Checkout | `/opt/freeswitch-ui/fs-enrs`, branch `fix/tenant-unification` |
| Commit | `6f4aa5db8a33cfd65db2962a3ead393ff7f3dd3d` (= GitHub; no local commits) |
| Migration file | `051_contact_identifier_uniqueness.sql`, sha256 `94e7baac5bfc9198…`, identical to the release |
| Local changes kept | ` M frontend/package-lock.json`, `?? package.json`, `?? package-lock.json` (pre-existing, untouched) |

## 2. Pre-deployment verification (read-only, all matched the earlier reports)

Database `fs_enrs` on the only local cluster (PostgreSQL 18 `main`, 127.0.0.1:5432; not production); role `fs_enrs`
owns the tables; 051 not recorded; no `*_norm` columns or `uq_contacts_*` indexes; **0** mobile and **0** extension
duplicate groups (051's exact expressions); 4 live contacts (fingerprint `7a286d07…`); no ENS campaign, delivery,
ERS incident, call or conference in progress; no open transaction or lock; backend PID 1068 healthy on the old code.

## 3. Backup

`/home/user/fs-enrs-backups/fs_enrs_before_051_20261106_185426.dump` — custom format, 383 318 bytes, readable
(`pg_restore --list`: 42 table-data entries), owner `user`, mode 600, directory mode 700.

## 4. Migration

`node src/db/migrate.js` (as `user`, DEV settings): 001 – 050 skipped as applied; **`Applying:
051_contact_identifier_uniqueness.sql` ✓ — "Applied 1 migration(s) successfully."**

| Verification | Result |
|---|---|
| 051 recorded in `schema_migrations` | yes (1) |
| `extension_norm` | present, `GENERATED ALWAYS` |
| `mobile_norm` | present, `GENERATED ALWAYS` |
| `uq_contacts_extension_norm` | present |
| `uq_contacts_mobile_norm` | present |
| Live contacts with a number but no key | 0 |
| Existing live contacts | intact — 4, fingerprint `7a286d07…` before = after |

## 5. Restart and health

| Item | Before | After |
|---|---|---|
| PM2 `fs-enrs-backend` PID | 1068 (old code, started 17:32:47) | **7074**, started 18:54:31 (after the migration) |
| Code | 14d057e | 6f4aa5d (the only code on disk since 18:08; loaded at start) |
| Status / restarts | online / 0 | online / 1 (the planned restart); still 1 after 221 s |
| `/health/ready` | healthy | healthy — database 1 ms, Redis ready, ESL 127.0.0.1:8021 |
| Boot log | — | "Startup schema validation passed", "listening on :4100 (development)" |
| Errors / SQL errors from the new process | — | **0** |

The backend was unavailable only for the few seconds of the PM2 restart. The window between the migration commit
and the restart (old code on the migrated database) was a few seconds; no contact operation ran in it.

## 6. Smoke tests — 22 / 22 passed

Run against the live DEV API with the `.env` SUPER_ADMIN (credentials never displayed) and two dedicated test tenants.
Test mobiles use the unassigned country code +999; the only dialled destination was extension 990519, verified
beforehand not to exist in FreeSWITCH. Numbers are masked below.

| Area | Test | Result |
|---|---|---|
| Add | new contact | 201 |
| Add | existing same-organization mobile | 200, `upserted: true`, same id |
| Add | same mobile, other organization of the tenant | 409 `IDENTIFIER_IN_OTHER_ORGANIZATION` |
| Tenancy | same mobile from another tenant | 409; no name or organization disclosed |
| Edit | to another contact's mobile | 409 `IDENTIFIER_IN_USE` |
| Edit | ordinary field change | 200 |
| CSV import | existing number + new number | 200: 1 updated, 1 created |
| Excel import | other organization's number + new number | 200: 1 conflict (readable message), 1 created |
| broadcast-users | existing + new user | 200: 1 updated, 1 created, `rejected: []` |
| broadcast-users | other organization's number | 200: `rejected[]` with the controlled message, nothing changed |
| Tenancy | tenant B reads tenant A's contact | 404 |
| Tenancy | identity-check across tenants | status only (`other_organization`), no contact data |
| Database | live contacts holding the test mobile | exactly 1 |
| ERS | Lua lookup (`/internal/ers/lookup`) | responder listed once |
| ENS | Lua lookup (`/internal/ens/lookup`) | contact listed once |
| ERS | ring-all (`/internal/ers/ring-all`) | 201 `success: true`; incident created; responder leg INVITED |
| ERS | call outcome | FreeSWITCH: `Can't find user [990519@…]` — no phone rang; 0 calls afterwards; the empty-room incident (#75) was closed automatically by the reconciliation sweep (ACTIVE 18:57:39 → COMPLETED 18:58:05) |
| IVR | flows list (SUPER_ADMIN) | 200 (4 flows) |
| IVR | deployment status | 200 |
| Reports | contact-usage report; ERS report (tenant A) | 200; 200 |
| Database | contacts outside the smoke tenants | unchanged (fingerprint before = after) |

## 7. Deviations and limitations

- **First execution attempt was blocked** by the Claude Code safety check (shared-resource change) before anything
  ran; it was run after the owner's "continue". No partial state.
- **Fixtures written directly to the DEV database** (inside the smoke tenant only): ERS configuration 74 with one
  primary tier contact, ENS configuration 182 with one contact, service numbers 990551 (ERS) and 990552 (ENS). Tenants,
  organizations, users and all contacts were created through the API.
- **ENS** was verified through the Lua lookup contract, not by executing a campaign (a campaign would dial with
  retries); **emergency conference** was verified through ring-all, incident creation and automatic completion, not
  with a live call in a room; **IVR** through the flow list and deployment status, not by dialling a flow.
- **Smoke data kept** (owner decision): tenants `SMOKE051A` (437) and `SMOKE051B` (438), organizations 162 / 163 / 164,
  users `smoke051-a@test.local` / `smoke051-b@test.local` (generated passwords, not recorded — re-set them to use the
  accounts), test contacts, groups `SMOKE051 Group` / `SMOKE051 Group A2`, ERS config 74 (incident 75, COMPLETED),
  ENS config 182, service numbers 990551 / 990552.

## 8. Rollback readiness

Not required. If ever needed — **code first, then database** (the new code needs the columns):
1. `git -C /opt/freeswitch-ui/fs-enrs checkout 14d057e` (as root; local files untouched) and
   `pm2 restart fs-enrs-backend`.
2. Then, as the `fs_enrs` role:
   ```sql
   BEGIN;
   DROP INDEX IF EXISTS uq_contacts_extension_norm;
   DROP INDEX IF EXISTS uq_contacts_mobile_norm;
   ALTER TABLE emergency_contacts DROP COLUMN IF EXISTS extension_norm, DROP COLUMN IF EXISTS mobile_norm;
   DELETE FROM schema_migrations WHERE version = '051_contact_identifier_uniqueness.sql';
   COMMIT;
   ```
3. Last resort: restore `/home/user/fs-enrs-backups/fs_enrs_before_051_20261106_185426.dump`.

Not changed by this deployment: FreeSWITCH (not restarted), WSL (not restarted), Git history, application code,
migration files, environment variables, production.

---

**DEPLOYMENT SUCCESSFUL**
