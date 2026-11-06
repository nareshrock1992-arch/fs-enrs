# Contact upsert — design (decisions confirmed 2026-11-06)

## 1. Confirmed business rules

1. **Platform-wide uniqueness.** One normalised extension and one normalised mobile number belong to at most one live
   contact on the whole platform, across organizations and tenants.
2. **Same organization → update.** A create (manual, import, API) whose extension or mobile matches a contact of the
   **same organization** updates that contact with the latest submitted values; id, group memberships and configuration
   links are kept; the administrator is told an existing contact was updated.
3. **Other organization → reject.** A match in another organization (same or other tenant) is refused; nothing is
   inserted or updated and no contact moves. The message reveals only that the identifier is already assigned
   elsewhere — no name, id, organization or tenant.
4. **Split match → reject.** Extension of one contact + mobile of another: refused; never merged.
5. **Latest values, partial semantics.** Only supplied fields change; omitted fields keep their value; an explicitly
   empty / null optional field clears it (the existing `PUT /contacts/:id` semantics). Spreadsheet imports: a blank
   cell leaves the existing value unchanged (a partially filled sheet must never wipe data).
6. **Three layers.** Frontend check while typing (feedback), backend authoritative check (every path), database unique
   indexes (final concurrency / integrity guard).
7. **One rule set** for manual create, edit, Excel/CSV import and `POST /ers/broadcast-users`.

## 2. Normalisation (identical in JavaScript and SQL)

| Identifier | Rule | Examples |
|---|---|---|
| Extension | remove whitespace and `( ) . -`; lower-case; empty → none | ` 10-01 ` → `1001` |
| Mobile | keep digits and `+`; leading `00` → `+`; keep only a leading `+`; empty or `+` alone → none | `+966 (50) 123-4567` → `+966501234567`; `00966 50…` → `+96650…` |

A local number (`0501234567`) and its international form (`+966501234567`) are different identifiers: no country
context exists, so they cannot be proven equal (§9). NULL / empty never matches. Name and e-mail are not identifiers.
Soft-deleted contacts do not hold identifiers.

## 3. Decision table (lookup is platform-wide; the response is filtered for privacy)

| Extension matches | Mobile matches | Result |
|---|---|---|
| — | — | create |
| X (same org) | X or — | update X (matched by extension / both) |
| — | X (same org) | update X (matched by mobile) |
| X | Y ≠ X | 409 `IDENTIFIER_CONFLICT` |
| any match in another organization | | 409 `IDENTIFIER_IN_OTHER_ORGANIZATION` |

Edit (`PUT`): an extension or mobile held by any other contact → 409 (same organization: the other contact is named;
other organization: generic message).

## 4. Database (migration `051_contact_identifier_uniqueness.sql`)

- `extension_norm`, `mobile_norm`: `GENERATED ALWAYS … STORED` columns computed from the existing columns with the §2
  rules — every writer, present or future, stays consistent.
- Partial unique indexes `uq_contacts_extension_norm` / `uq_contacts_mobile_norm` `WHERE deleted_at IS NULL AND … IS
  NOT NULL` — global, NULL-safe, soft-delete aware.
- Before creating the indexes the migration counts duplicates; if any exist it raises an error listing the contact ids
  and the whole migration rolls back (no merging, no data change). Remediation is a separate approved operation.
- Reversible: `DROP INDEX` ×2, `ALTER TABLE … DROP COLUMN` ×2 (in the implementation document).
- No tenant column is added: uniqueness is global, ownership checks keep using the organization's tenant.

## 5. Concurrency

Every identifier-changing write runs in a transaction holding `pg_advisory_xact_lock(hashtext('enrs:contact-identity'))`
(one platform-wide lock, because uniqueness is platform-wide); a unique violation that still occurs (direct SQL) is
reported as a 409.

## 6. API (backward-compatible)

- `POST /contacts`: `201` + contact (created) | `200` + contact + `upserted: true`, `matched_by` (updated) | `409`.
- `PUT /contacts/:id`: unchanged contract; `409` for identifiers held by another contact.
- `GET /contacts/identity-check?organization_id&extension_number&mobile_number&exclude_id` (`adminOnly`, organization
  in the caller's tenant): `{ status: new | update | other_organization | conflict, matched_by?, contact? }`;
  `contact` (id, name) only for a match in the same organization.
- Import response keeps all fields and adds `created`, `updated`, `unchanged`, `conflicts`, `duplicates_prevented`,
  `updates` (rows). `inserted` = created; `skipped` / `duplicates` = rows that matched and changed nothing.
- `POST /ers/broadcast-users` keeps `created`, `updated`, `total`; adds `rejected` (index + message). Its original
  match key is kept as a fallback (added during implementation, zero-regression rule): when neither identifier
  matches any contact, a contact **of the same organization** whose mobile ends in the same 9 digits is the same
  user and is updated (so `0501234567` stored / `+966501234567` sent still updates, as before). Uniqueness is
  unaffected: the supplied identifiers are held by no contact at that point. Country codes stay significant
  (`legacyMobileMatch`, 2026-11-06): when both numbers carry a country code they must agree in every digit
  (`+966…` = `966…`), so `+971501234567` never updates the contact holding `+966501234567` — the user becomes a
  new contact instead (MOBILE_IDENTITY_SCOPE_REVIEW.md).

## 7. Duplicate-call safeguard (per execution only)

ENS campaign destinations and ERS ring-all responders are reduced to one per normalised dial target (for ERS the
lowest contact id is kept; the remaining legs keep the order the query returned them in — nothing is re-sorted); the
ENS / ERS Lua lookup lists likewise drop entries whose normalised value repeats (first of the already-sorted list).
Without duplicates every list is returned exactly as before. Retry, waves, overflow, escalation, conferences and
independent campaigns are untouched.

## 8. Audit (existing `audit_logs` convention, counts / ids / field names only)

`contact_created` (source), `contact_duplicate_prevented` (the matched contact updated instead: matched_by,
changed_fields, source), `contact_updated`, `contact_identifier_conflict` (kind, which identifier, source), `contacts_imported`
(adds created / updated / unchanged / conflicts). Imports write one summary per organization, not one record per row.
Identifiers are never stored in full.

## 9. Not covered

Equivalence of local and international mobile forms (needs a tenant country setting); merging existing duplicates;
contacts written by direct SQL outside the application (still blocked by the indexes).
