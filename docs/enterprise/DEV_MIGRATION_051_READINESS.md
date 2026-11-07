# DEV Migration 051 — Readiness Audit

Date: 2026-11-06 (read-only audit). Release: `6f4aa5db8a33cfd65db2962a3ead393ff7f3dd3d` on `fix/tenant-unification`.
Migration: `051_contact_identifier_uniqueness.sql`.

Nothing was changed on DEV: no migration, no database write, no restart, no checkout change. Database access used
the existing DEV configuration (credentials read inside the process, never printed) in sessions forced
`default_transaction_read_only = on`, SELECT-only. The dry run used a throw-away copy (schema + `schema_migrations`
+ `emergency_contacts`, read-only `pg_dump`) inside an isolated namespace; the copy was deleted afterwards.

---

## 1. Git readiness — ready

| Check | Result |
|---|---|
| DEV checkout | `/opt/freeswitch-ui/fs-enrs` (Ubuntu 26.04, WSL) — remote `github.com/nareshrock1992-arch/fs-enrs` |
| Branch / HEAD | `fix/tenant-unification` / `6f4aa5db8a33cfd65db2962a3ead393ff7f3dd3d` (= release; 0 commits ahead or behind) |
| Pulled | 2026-11-06 18:08:07 +03, `pull --ff-only` |
| 051 in the checkout | identical to the release (sha256 `94e7baac5bfc9198…`) |
| Working tree | pre-existing, unrelated: ` M frontend/package-lock.json` (39 lines removed), `?? package.json`, `?? package-lock.json` (root) — not touched by the release or by 051 |

## 2. Database readiness — ready

| Check | Result |
|---|---|
| Server | PostgreSQL 18.6, database `fs_enrs`, locale C.UTF-8 (libc), UTF8 — same as the test clusters |
| Role used by the application / `migrate.js` | `fs_enrs`, **owner** of `emergency_contacts` and `schema_migrations` (051's `ALTER TABLE` is permitted) |
| `schema_migrations` | 51 entries (`schema.sql` + up to `050_ers_incident_tenant_backfill.sql`, applied 2026-11-05) |
| 051 recorded | **no** |
| `mobile_norm` / `extension_norm` | **absent** |
| `uq_contacts_mobile_norm` / `uq_contacts_extension_norm` | **absent** (no unexpected index) |
| Existing indexes | `emergency_contacts_pkey`, `idx_contact_mobile`, `idx_contact_org`, `idx_emergency_contacts_active` |
| Existing constraints | primary key, NOT NULLs, foreign keys to organizations / departments / locations / sip_gateways — **no unique constraint on numbers** |
| Size | `emergency_contacts` 80 kB; 4 live, 3 soft-deleted contacts; no live contact without mobile or extension; no non-ASCII numbers |
| Sessions / locks | 3 sessions, none idle in transaction, no open long transaction, no lock on `emergency_contacts` at audit time |

## 3. Mobile duplicate findings — none

051's exact mobile expression over live contacts: **0 groups** of contacts sharing a normalised mobile number.
Also 0 pairs of live mobiles sharing the last 9 digits under different keys (local vs international forms).

## 4. Extension duplicate findings — none

051's exact extension expression over live contacts: **0 groups**.
Cross-column (one contact's extension = another's mobile key, not a 051 rule): **0 pairs**.
Soft-deleted contacts reusing a live contact's number: 3 — they never block (the indexes cover live rows only).
Live contacts in deleted organizations: 0.

## 5. Migration compatibility — verified by a dry run on a copy of DEV

```
1. DEV schema restored as the app role fs_enrs; data: 51 schema_migrations rows, 7 contacts
   (one harmless restore error: "must be owner of extension pgcrypto" — COMMENT ON EXTENSION)
2. migrate.js as fs_enrs: exit 0 in 4.4 s (incl. Node start); applied: 051_contact_identifier_uniqueness.sql only
   051 recorded; extension_norm / mobile_norm GENERATED ALWAYS; uq_contacts_extension_norm, uq_contacts_mobile_norm created
   all 4 live contacts received mobile_norm and extension_norm; existing contact data unchanged (row hash)
3. the new code's lookup query runs on the migrated copy
4. rollback (CONTACT_UPSERT_IMPLEMENTATION.md §7): columns 0, indexes 0, 051 unrecorded, data unchanged
5. re-apply after rollback: exit 0, 051 recorded, 2 indexes
6. run again: 0 files applied (idempotent)
```

| Question | Answer |
|---|---|
| Can 051 run on the current schema? | yes (dry run) |
| Will duplicates block it? | no — 0 mobile and 0 extension groups |
| Do extension data conflict? | no |
| Index already present unexpectedly? | no |
| Rollback safe? | yes — derived columns and indexes only; no data is changed or lost (dry run step 4) |
| Lock impact | `ADD COLUMN … STORED` rewrites the 80 kB table under ACCESS EXCLUSIVE — milliseconds; contact reads (including ENS / ERS lookups) wait for that moment only |

## 6. Backend compatibility

| Check | Result |
|---|---|
| PM2 app | `fs-enrs-backend`, pid 1068, online, fork mode, **watch: false**, autorestart: true, 0 restarts, node 22.22.1 |
| Source path | `/opt/freeswitch-ui/fs-enrs/backend/server.js` (cwd `/opt/freeswitch-ui/fs-enrs/backend`); package version 1.0.0 |
| Started | 2026-11-06 17:32:47 +03 — **before** the pull to 6f4aa5d (18:08:07) |
| Running implementation | the **old** 14d057e code (Node loaded its modules at start; nothing reloads them) |
| Health now | `/api/health` ok; `/health/ready` healthy (database 43 ms, Redis ready, ESL 127.0.0.1:8021) |
| Startup runs migrations? | no (`migrate` is a separate npm script) |
| Would a restart activate code that needs 051? | **yes**. The new code reads `extension_norm` / `mobile_norm` in Add / Edit Contact, import, identity-check and broadcast-users. Without 051 those calls fail; listing, ENS, ERS, conferences, IVR and reports do not use the columns |
| Old code with 051 applied (14d057e's own tests on a database with 051) | operational; the only change is that duplicates are now refused: an import row holding another organization's number fails with the raw database message (`duplicate key value violates unique constraint "uq_contacts_…"` — no personal data); a single create returns the generic 409; two simultaneous imports of the same numbers into different organizations both inserted nothing in the test. 6 of 14d057e's tests fail only for these reasons (their fixtures reuse numbers); without 051 the same suite has only its 2 known baseline failures |
| Frontend | the Vite dev server (port 8100) already serves the new screens from the pulled checkout; with the old backend the identity hint is simply absent and saving works |

## 7. Risks

| # | Risk | Mitigation |
|---|---|---|
| R1 | **Any** backend restart before 051 (PM2 autorestart after a crash, WSL / Windows restart, `wsl --shutdown`) starts the new code without its columns → contact add / edit / import / broadcast-users fail on DEV | apply 051 soon; until then avoid restarts |
| R2 | Between applying 051 and restarting, the old code refuses duplicates with raw database messages | restart immediately after the migration (step 5) |
| R3 | Rolling the database back while the **new** code runs breaks contact writes | rollback order in §9: code first, then database |
| R4 | ACCESS EXCLUSIVE lock during the table rewrite | 80 kB table — milliseconds; run outside an active emergency test |
| R5 | Open findings of the architecture review (extension F-1 / F-2, mobile M-1 – M-3) | unchanged; not blocking for DEV |

## 8. Recommended procedure (after approval; all in WSL)

1. **Re-check** (read-only, immediately before): 051 not recorded; 0 duplicate groups (the queries of §3 / §4, also in
   CONTACT_UPSERT_IMPLEMENTATION.md §7); no long transaction on the database.
2. **Back up** the database (owner role, from the backend directory so the DEV settings are used):
   `pg_dump -Fc -f ~/fs_enrs_before_051_$(date +%Y%m%d_%H%M).dump` with the DEV connection settings.
3. **Apply** (only 051 is pending):
   ```bash
   cd /opt/freeswitch-ui/fs-enrs/backend && node src/db/migrate.js
   ```
   Expected output: `Applying: 051_contact_identifier_uniqueness.sql` then `✓`. On failure nothing is changed
   (the file is one transaction) — stop and read the `[051]` message.
4. **Verify**: `schema_migrations` has 051; both columns exist (`is_generated = ALWAYS`); both `uq_contacts_*` indexes
   exist; every live contact with a number has a non-NULL key.
5. **Restart the backend** to activate the new code: `pm2 restart fs-enrs-backend` (as root, the PM2 owner); then
   `/health/ready` must be healthy and `pm2 logs fs-enrs-backend --lines 50 --nostream` free of errors.
6. **Smoke test** in the DEV UI: Add Contact with an existing mobile of the same organization → "existing contact
   was updated"; with another organization's number → refused; import preview shows created / updated /
   conflicts; ENS and ERS test calls behave as before.

## 9. Rollback procedure

- **051 failed** in step 3: nothing to roll back (atomic). Keep the old backend running; do not restart.
- **After 051, before the restart** (old code still running): run the rollback SQL; the old code needs nothing else.
  ```sql
  BEGIN;
  DROP INDEX IF EXISTS uq_contacts_extension_norm;
  DROP INDEX IF EXISTS uq_contacts_mobile_norm;
  ALTER TABLE emergency_contacts DROP COLUMN IF EXISTS extension_norm, DROP COLUMN IF EXISTS mobile_norm;
  DELETE FROM schema_migrations WHERE version = '051_contact_identifier_uniqueness.sql';
  COMMIT;
  ```
- **After the restart** (new code running): first return the code to 14d057e (`git checkout 14d057e` in the DEV
  checkout as root — detached, local changes are not in the release files — then `pm2 restart fs-enrs-backend`),
  then run the rollback SQL. Rolling the database back first would break contact writes.
- Last resort: restore the step-2 dump.

## 10. Approval checklist

- [ ] Re-check of §8 step 1 shows 051 unrecorded and 0 duplicate groups
- [ ] Database backup taken and its file size checked
- [ ] Approved: apply 051 on DEV (`node src/db/migrate.js`)
- [ ] Approved: restart `fs-enrs-backend` immediately afterwards
- [ ] Maintenance moment agreed (no ENS / ERS test in progress)
- [ ] Rollback order understood (code before database once the new code runs)
- [ ] Smoke test owner identified

---

**Status: READY FOR APPROVAL — no blocking issues found.**
The DEV schema and data satisfy every precondition of migration 051, the dry run on a copy of DEV succeeded with
rollback and re-run, and the running backend is healthy. Approval is required for the migration and the restart;
neither has been performed.
