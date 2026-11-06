# Contact Duplicate Prevention — Implementation

Implements [CONTACT_UPSERT_DESIGN.md](CONTACT_UPSERT_DESIGN.md) (confirmed requirements, 2026-11-06). Root cause and
data audit: [CONTACT_DUPLICATE_AUDIT.md](CONTACT_DUPLICATE_AUDIT.md). Tests: [CONTACT_DUPLICATE_TEST_REPORT.md](CONTACT_DUPLICATE_TEST_REPORT.md).
Compatibility: [BEHAVIOUR_COMPATIBILITY_REPORT.md](BEHAVIOUR_COMPATIBILITY_REPORT.md).

Status: implemented in the working tree of `fix/tenant-unification` (on 14d057e). **Not committed, not pushed,
not deployed.** Migration 051 has been applied only to throw-away test databases.

## 1. Guarantee

An extension or a mobile number (normalised) can belong to only one live contact on the platform. Every
application path checks this before writing; the database refuses a second one even for a path that does not.

| Layer | Where | What it does |
|---|---|---|
| Frontend | `ContactList.jsx`, `contactTable.js` (`identityHint`, `contactPayload`, `savedNotice`) | While typing, `GET /contacts/identity-check` says "saving will update <name>" or blocks Save with the safe message; Add sends only filled-in fields; a notice when Add updated an existing contact; the import report shows created / updated / duplicates prevented / conflicts / invalid |
| Backend (authoritative) | `services/contactIdentity.js` used by `contactController` (create, update, import) and `ersController.upsertBroadcastUsers` | Normalise → platform-wide lookup → classify (`new` / `update` / `other_organization` / `conflict`) inside a transaction holding one global advisory lock |
| Database | migration `051_contact_identifier_uniqueness.sql` | Generated `extension_norm` / `mobile_norm` + partial unique indexes (`deleted_at IS NULL`, value not NULL) |

## 2. Normalisation (JS = SQL)

| Identifier | Rule | Examples |
|---|---|---|
| Extension | remove whitespace and `( ) . -`, lower-case, empty → NULL | `10-01`, ` 1001 `, `(10).01` → `1001`; `AB-12` → `ab12` |
| Mobile | keep digits and `+`; leading `00` → `+`; only a leading `+` kept; empty or `+` → NULL | `+966 50 123 4567`, `00966-501234567` → `+966501234567`; `0501234567` stays local |

`contactsIdentity` CI-9 runs both implementations over the same samples and checks the stored columns.

## 3. Decision (one function: `classifyIdentity`)

| Matches | Result |
|---|---|
| none | create |
| extension and mobile match **different** contacts | refuse (`IDENTIFIER_CONFLICT`), never merge |
| one contact, another organization (any tenant) | refuse (`IDENTIFIER_IN_OTHER_ORGANIZATION`); only the field is reported |
| one contact, same organization | update it: supplied fields win, omitted fields kept, explicit empty clears (PUT semantics); id, organization, group memberships and assignments kept |

Edit (`PUT`): a changed number held by any other live contact is refused (`IDENTIFIER_IN_USE` naming the contact
inside the organization, otherwise `IDENTIFIER_IN_OTHER_ORGANIZATION`). A concurrent winner that slips past the lock
surfaces as a unique violation → `IDENTIFIER_TAKEN` (409), never a 500.

## 4. Paths

| Path | Change |
|---|---|
| `POST /contacts` | upsert as above; 201 / 200 `upserted` / 409 |
| `PUT /contacts/:id` | identity check when a number changes |
| `GET /contacts/identity-check` | new, `adminOnly`, read-only, tenant-scoped organization |
| `POST /contacts/bulk-upload` (CSV / Excel, preview and commit) | `applyIdentities`: rows in file order against the database **and** earlier rows; savepoint per row; preview = commit |
| `POST /ers/broadcast-users` | same rules, `rejected[]`; legacy same-organization last-9-digit match kept as a fallback, never across two different country codes (`legacyMobileMatch`) |
| ENS `campaignEngine.resolveDialTargets` | one destination per normalised number per campaign |
| ERS `ersRingService.resolveTierResponders` | one leg per normalised number per wave (lowest id kept, order otherwise unchanged) |
| ENS / ERS Lua lookups (`resolveEnsContacts`, `resolveResponders`) | the already sorted list without normalised repeats |

Paths searched and not writing contacts: seeds/fixtures only (`npm run seed` does not create contacts).

## 5. Files

| File | Kind |
|---|---|
| `backend/src/services/contactIdentity.js` | new — rules, lookup, classification, lock, dedupe helper |
| `backend/src/db/migrations/051_contact_identifier_uniqueness.sql` | new — columns, duplicate check, unique indexes |
| `backend/src/controllers/contactController.js` | create / update / import / identity-check |
| `backend/src/routes/v1/contacts.js` | `GET /identity-check` |
| `backend/src/controllers/ersController.js` | broadcast-users |
| `backend/src/services/campaignEngine.js`, `ersRingService.js` | per-execution dedupe (+ `__test` export) |
| `backend/src/controllers/internal/ensInternalController.js`, `ersInternalController.js` | lookup dedupe |
| `frontend/src/api/client.js`, `pages/contacts/ContactList.jsx`, `pages/contacts/contactTable.js` | UI |
| tests: `unit/contactIdentity.test.js` (new), `integration/contactsIdentity.test.js` (new), `contactsEnterprise.test.js`, `contactsImportExcel.test.js`, frontend `contactsTable.test.js` | |
| docs: this file, design, audit, test report, compatibility report, `08-rest-api-reference.md`, `BEHAVIOUR_CHANGES.md` | |

Not touched: Lua scripts, dialplan, retry / waves / overflow / conference / IVR / reporting code, `.env`, package
files, lockfiles, Docker, services. `docs/enterprise/EMERGENCY_CONTACTS_EXCEL_TEMPLATE_AUDIT.md` stays staged and unmodified.

## 6. Audit events (`audit_logs`, entity `emergency_contact`)

| Requested event | Action written | Details (no numbers, names or e-mail) |
|---|---|---|
| CONTACT_CREATED | `contact_created` | tenant, organization, `source` |
| CONTACT_UPDATED | `contact_updated` (Edit) | changed field names |
| CONTACT_DUPLICATE_PREVENTED | `contact_duplicate_prevented` (Add updated an existing contact) | `matched_by`, `changed_fields`, `source` |
| CONTACT_IDENTIFIER_CONFLICT | `contact_identifier_conflict` | `kind`, `field`; contact ids only when inside the caller's organization |
| CONTACT_IMPORT_COMPLETED | `contacts_imported` (one per organization; also ERS broadcast-users with `source`) | `inserted`, `updated`, `skipped_duplicates`, `conflicts`, `error_rows`, `total_rows`, `file_rows`, `format` |

Lower-case names follow the existing `audit_logs` convention (the Audit Log page filters on them). Application logs
print at most the last three digits (`***567`).

## 7. Deployment and migration (to be run by the operator; nothing here has been run on DEV or production)

1. **Audit the target database first** (read-only). Both queries must return no rows:

   ```sql
   -- contacts sharing an extension
   WITH c AS (SELECT id, NULLIF(lower(regexp_replace(COALESCE(extension_number,''),'[[:space:]().-]','','g')),'') AS k
              FROM emergency_contacts WHERE deleted_at IS NULL)
   SELECT k, array_agg(id ORDER BY id) FROM c WHERE k IS NOT NULL GROUP BY k HAVING count(*) > 1;

   -- contacts sharing a mobile number
   WITH s AS (SELECT id, regexp_replace(regexp_replace(COALESCE(mobile_number,''),'[^0-9+]','','g'),'^00','+') AS v
              FROM emergency_contacts WHERE deleted_at IS NULL),
        c AS (SELECT id, NULLIF(NULLIF(CASE WHEN left(v,1)='+' THEN '+'||regexp_replace(v,'[^0-9]','','g')
                                            ELSE regexp_replace(v,'[^0-9]','','g') END,''),'+') AS k FROM s)
   SELECT k, array_agg(id ORDER BY id) FROM c WHERE k IS NOT NULL GROUP BY k HAVING count(*) > 1;
   ```

   DEV on 2026-11-05: 4 live contacts, **0** duplicate groups (CONTACT_DUPLICATE_AUDIT.md). Re-run immediately
   before deploying.
2. If rows are returned: **stop**. Resolve each group by a reviewed, manual decision (edit a number or delete the
   stale contact through the UI). Nothing merges automatically. Migration 051 would refuse anyway — it rolls back
   completely and lists the contact ids (verified, see the test report).
3. Back up the database (`pg_dump`), deploy the code, run `npm run migrate` (applies 051 only; idempotent).
4. Restart the backend (PM2) and rebuild the frontend as for any release.
5. Smoke test: Add Contact with an existing number of the same organization → "existing contact was updated";
   with another organization's number → refused; an import preview shows created / updated / conflicts.

Index creation scans `emergency_contacts` once (small table; DEV has 4 rows). It is not `CONCURRENTLY` because
migrations run inside a transaction.

### Rollback

Code: redeploy the previous commit. Database (only if required; the columns are derived, no data is lost):

```sql
BEGIN;
DROP INDEX IF EXISTS uq_contacts_extension_norm;
DROP INDEX IF EXISTS uq_contacts_mobile_norm;
ALTER TABLE emergency_contacts DROP COLUMN IF EXISTS extension_norm, DROP COLUMN IF EXISTS mobile_norm;
DELETE FROM schema_migrations WHERE version = '051_contact_identifier_uniqueness.sql';
COMMIT;
```

The previous code ignores the two columns, so running old code against the migrated database is also safe.
