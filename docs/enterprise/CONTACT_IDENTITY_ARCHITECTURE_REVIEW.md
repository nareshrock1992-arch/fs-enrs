# Contact Identity — Final Architecture Review (read-only)

Date: 2026-11-06. Reviewer scope: the uncommitted contact-identity change set on `fix/tenant-unification`
(baseline 14d057e): migration 051, `services/contactIdentity.js`, Add / Edit upsert, CSV / Excel import,
`POST /ers/broadcast-users`, ENS / ERS duplicate-call prevention.

Method: code reading of every writer (searched, not taken from the earlier audit), plus checks run only on
throw-away PostgreSQL 18 clusters in a network-isolated namespace with `.env` masked, and read-only queries on DEV
(session forced `default_transaction_read_only=on`). Nothing in the repository other than this file was created or
changed; no migration ran on DEV or production; nothing was committed, pushed or deployed. The staged
`EMERGENCY_CONTACTS_EXCEL_TEMPLATE_AUDIT.md` was not touched.

---

## 1. Executive assessment

The design is sound and the implementation is consistent: a single identity service, one global transaction-scoped
lock shared by every application writer, a database backstop that refuses same-column duplicates independently of
the application, safe 409 messages, and no regressions against the baseline. Migration 051 behaves exactly as
documented (refuses on duplicates, rolls back completely, idempotent, correct rollback SQL).

Three issues need a decision before deployment; one of them should be fixed before the migration is committed:

| # | Finding | Severity |
|---|---|---|
| F-1 | Extension normalisation differs between JavaScript and the database for some non-ASCII characters (NBSP U+00A0, U+2007, U+202F, BOM U+FEFF; Turkish `İ`) — measured, 5 of 24 samples | **Medium** — fix before 051 is first deployed |
| F-2 | Cross-column collisions (one contact's extension = another's mobile) are prevented neither by the database nor by the application | Medium — business decision |
| F-3 | Writers waiting for the global lock hold pool connections (pool max 20, shared with the ENS / ERS Lua APIs); no `lock_timeout` | Low–Medium — recommended before production |

**Recommendation: APPROVE WITH CONDITIONS** (section 10).

---

## 2. Complete contact writer inventory

Searched: all `INSERT/UPDATE/DELETE … emergency_contacts` in `fs-enrs` (backend, scripts, docs, Lua, shell),
`fs-cc` and `fs-cp`; timers / cron / jobs in `backend/src`.

| # | Writer | Kind | Identity service | Global lock | DB backstop |
|---|---|---|---|---|---|
| W1 | `POST /contacts` → `contactController.createContact` (Add Contact) | insert / upsert | yes (`findIdentityMatches`, `classifyIdentity`) | yes (`withIdentityTransaction`) | yes |
| W2 | `PUT /contacts/:id` → `updateContact` (Edit) | update | yes (match excluding self when a number changes) | yes | yes |
| W3 | `POST /contacts/bulk-upload` commit → `applyIdentities` (CSV and Excel share this path) | insert / update per row (savepoints) | yes (batched lookup + in-file index) | yes (whole import in one transaction) | yes |
| W4 | `POST /contacts/bulk-upload` preview | none (read-only) | yes (same decision) | no — not needed, writes nothing | — |
| W5 | `POST /ers/broadcast-users` → `ersController.upsertBroadcastUsers` | insert / update + group link | yes, plus legacy last-9-digit fallback | yes (taken after group find-or-create, before any contact read) | yes |
| W6 | `DELETE /contacts/:id`, `POST /contacts/bulk-delete` | soft delete | not needed (frees identifiers) | no — cannot create a duplicate | n/a |
| W7 | `backend/scripts/cleanup_duplicate_orgs.sql` | operator-run one-off: re-points contacts of phantom "Default Organization" rows to the survivor | no | no | yes (numbers unchanged, so it cannot violate the indexes) — note: it **moves contacts between organizations**, an explicit legacy admin script outside the application |
| W8 | `docs/sample_data_yasref.sql` | manual sample data | no | no | yes (would fail on duplicates) |
| W9 | `fs-cp/fs-enrs/**` | **older copy** of the backend (no `contactIdentity.js`) | no | no | yes once 051 is applied — old code would surface a raw unique violation as the generic 409 |
| — | ENS / ERS internal APIs, Lua scripts, campaign engine, ESL service, reports, dashboard, groups, organizations, `cleanup_orphaned_ers_incidents.js`, `fs-cc` | read only (or link tables only: `responder_group_members`) | — | — | — |
| — | Tests (`__tests__`) | direct SQL fixtures | no | no | yes |

There is no other application writer, no background job that writes contacts, and no restore (un-delete) path.

## 3. Uniqueness enforcement matrix

| Rule | Application (W1–W3, W5) | Database (051) | Verified |
|---|---|---|---|
| Extension unique across organizations / tenants | yes | yes (`uq_contacts_extension_norm`, partial: live, not NULL) | 051 refusal run; CI-4, CI-9 |
| Mobile unique across organizations / tenants | yes | yes (`uq_contacts_mobile_norm`) | same |
| Extension of A = mobile of B (cross-column) | **no** | **no** — not expressible as a per-column unique index | review run: pair (`5551234` / `555-1234`) accepted by 051; the lookup compares extension with `extension_norm` and mobile with `mobile_norm` only (`contactIdentity.js:55`), so Add / import / broadcast accept such a pair (code reading); CI-12 seeds one deliberately |
| Extension + mobile of two different contacts in one request | rejected (`IDENTIFIER_CONFLICT`) | n/a (request-level rule) | CI-5 |
| Whitespace, `( ) . -`, case (ASCII) | yes | yes, identical | CI-9 parity, CI-U1 |
| Non-ASCII whitespace / case in extensions | **differs** (F-1) | | review run, below |
| Mobile: digits, leading `+`, `00` → `+` | yes | yes, identical for all 24 review samples (incl. full-width and Arabic-Indic digits → NULL in both) | review run; CI-U2 |
| NULL / empty / whitespace-only / punctuation-only | → NULL, never collide | → NULL, partial index excludes NULL | CI-3, CI-9 |
| Soft-deleted contacts | ignored | excluded by the index predicate | CI-9; 051 run (`Gone`) |

**F-1 evidence** (throw-away DB, locale C.UTF-8 = DEV's locale; real generated columns via `LIKE … INCLUDING GENERATED`
vs the real `normalizeExtension`):

```
DIFF | NBSP U+00A0          | ext js="1001"  sql="10 01"
DIFF | figure space U+2007  | ext js="1001"  sql="10 01"
DIFF | narrow NBSP U+202F   | ext js="1001"  sql="10 01"
DIFF | BOM U+FEFF           | ext js="1001"  sql="﻿1001"
DIFF | Turkish dotted I     | ext js="i̇1001" sql="i1001"
same | U+3000, U+2028, U+2003, U+1680, U+0085, VT, FF, U+200B, en dash, minus, full-width, Greek, Cyrillic, ß, ASCII …
mobile_norm: identical for all 24 samples
```

PostgreSQL's `[[:space:]]` (libc C.UTF-8) excludes the no-break spaces and the BOM that JavaScript `\s` includes;
`lower()` and `toLowerCase()` map `İ` differently. Consequences (derived from the code paths):

- The application decides with JS values, the index enforces SQL values. Example: a live contact stored with
  extension `80<NBSP>01` (SQL `80 01`) and a new Add with `8001` → the app looks up `extension_norm = '8001'`, finds
  nothing, inserts → two live contacts the application regards as the same extension (reproduced at the database
  level: both rows remain after 051).
- The reverse produces a permanent, misleading `IDENTIFIER_TAKEN` ("was just assigned … try again"), and the
  identity-check reports `new` for a value the save will refuse.
- Likelihood: NBSP and BOM arrive easily through copy-paste and spreadsheets; JS `trim()` removes them only at the
  ends. DEV today: 0 contacts with non-ASCII characters in a number. Mobile numbers are not affected.
- The per-execution dial dedupe (`dialKey`) uses the JS form, so such a pair is still called once.

## 4. Concurrency analysis

| Aspect | Finding |
|---|---|
| Lock | `pg_advisory_xact_lock(hashtext('enrs:contact-identity'))` = key −367 203 835 (single-key space). Taken as the first statement of the transaction on the same client as the writes (W1, W2, W3) or before the first contact read (W5). Released automatically at COMMIT or ROLLBACK — no leak on errors. |
| Key collisions | The only other single-key advisory lock is ERS ring-all `pg_advisory_xact_lock(<configuration id>)`; ids are positive serials, the identity key is negative → **no collision possible**. Media locks use the two-key space. |
| Isolation | READ COMMITTED; every lookup runs after the lock, so each writer sees all committed predecessors. Lookup → decide → write is atomic with respect to other identity writers. |
| Backstop | A writer outside the lock (W7–W9, direct SQL) is still stopped by the unique indexes; W1–W3 map that to `IDENTIFIER_TAKEN` (409), import rows to a row error via savepoint, W5 to 409. |
| Rollback | Create / edit / broadcast: whole transaction. Import commit: per-row savepoints inside one transaction; a failed row is rolled back alone and reported; the in-memory index keeps the pre-row state. Verified (CX-14, CE-15, CI-8). |
| Deadlocks | All identity writers take the advisory lock before any row lock; deletes take row locks only and never wait for the advisory lock → no cycle. |
| Serialisation scope | Platform-wide: every contact write in every tenant waits for the current holder (largest: a 10 000-row import, seconds). |
| **F-3** | Waiting writers each hold a pool connection (`max: 20`, `connectionTimeoutMillis: 5000`). The pool is shared with the internal ENS / ERS lookup API used by Lua during emergencies. Twenty queued contact writes (e.g. a burst of broadcast-users calls during a long import) would make other requests fail after 5 s. Before this change the import lock was per organization (smaller blast radius). No `lock_timeout` / `statement_timeout` bounds the wait. |

## 5. Multi-tenant isolation findings

| Check | Result |
|---|---|
| Organization A cannot update organization B's contact | Upsert (W1, W3, W5) updates only a match in the **request's** organization; otherwise refuses. The request organization is verified in the caller's tenant first. Edit (W2) keeps its pre-existing rule: a tenant ADMIN may edit any contact of the **own tenant** (unchanged, by design); cross-tenant edits → 404. |
| No disclosure of another tenant's contact | 409 bodies carry only `code`, `field` and a fixed message; `contacts` are listed only when both are in the caller's organization; audit records carry contact ids only within the caller's organization; logs mask numbers (`***567`). Verified (CI-4, CI-5, CI-10). |
| Existence oracle (F-4, inherent) | Global uniqueness necessarily reveals *that* a number exists somewhere (POST 409, import row error, and cheaply via `GET /contacts/identity-check`, which is ADMIN-only, not audited, bounded only by the global 300 requests / minute / IP limiter). It never reveals who or where. |
| Deleted organizations retain identifiers | Yes: deleting an organization does not soft-delete its contacts, so they keep their numbers. A purge path exists: such contacts still appear in the contact list (the scope does not filter `o.deleted_at`) and can be deleted individually or in bulk. DEV: 0 such contacts. |
| Group memberships during upsert | Updated in place (same id); memberships and ERS / ENS assignments untouched (CI-1, CI-11). |
| Partial updates never erase unspecified fields | Add (API): only keys present in the body are applied; **explicit `null` / `""` clears** (requirement: existing API semantics) — see F-5. Add (UI): blank fields are omitted. Import: blank cells keep values. Broadcast-users: sets first / last name from `name` (single word → last name `-`, pre-existing), forces `is_active = true` (pre-existing), keeps extension when omitted, replaces the mobile with the number sent (new — intended "latest value"). |
| Inactive contact re-added (F-7) | Add does not send `is_active`; an upsert onto an inactive contact keeps it inactive while the UI says "updated" — ENS / ERS skip inactive contacts. Behaviour is correct per the partial-update rule; the notice could mislead. |

## 6. API compatibility findings (`POST /contacts`)

Callers found: **one** — `frontend/src/pages/contacts/ContactList.jsx` via `api.contacts.create`. No Lua, internal,
`fs-cc` or script caller; `scripts/verify-api-contracts.js` checks only path prefixes.

| Aspect | Handling |
|---|---|
| 201 (create) / 200 (upsert) | `request()` treats any `res.ok` alike → both fine. |
| `upserted: true` | read by the dialog → success notice; additive field. |
| 409 bodies | keep the `error` key the client displays; `code` / `field` additive. |
| Existing errors (400 validation, 404 organization, 403 role) | unchanged. |
| Risks | (a) external API clients that always expect 201 + a new id now get 200 + an existing id; (b) **F-5**: clients that send complete objects with `null` for unknown fields will clear those fields on an existing contact (previously they created a harmless second contact); (c) `docs/03_API_REFERENCE.md` (older reference) still describes the old contract (`08-rest-api-reference.md` is updated); (d) `fs-cp` carries an older backend copy — it must receive the service and 051 together. |

## 7. Migration safety assessment (051)

Re-verified in this review on a throw-away database (the earlier evidence files were removed by temp cleanup):

```
1. hashtext('enrs:contact-identity') = -367203835
2. fresh migrate: 051 recorded=1 indexes=2
3. rollback with the exact SQL of CONTACT_UPSERT_IMPLEMENTATION.md §7: ok — columns=0 indexes=0 051 recorded=0
4. seeded: mobile duplicate across orgs, extension duplicate across orgs, cross-column pair, NBSP pair
5. migrate exit=1  [051] … Contacts sharing an extension: {3,4}. Contacts sharing a mobile number: {1,2}.
   after refusal: 051 recorded=0 columns=0 indexes=0 data unchanged=yes
6. after resolving the two same-column duplicates: migrate exit=0 051 recorded=1
   cross-column pair still both live: 2      NBSP pair still both live: NbspExt="80 01" PlainExt="8001"
7. re-run exit=0 (idempotent)
```

| Check | Result |
|---|---|
| Pre-existing duplicates detected | yes (per column, ids listed) |
| Cross-column conflicts detected | **no** (no such rule exists — F-2) |
| Failure rolls back completely | yes — the file owns `BEGIN/COMMIT`; `migrate.js` records the file only after it succeeds |
| Re-run safe | yes (`IF NOT EXISTS`) — note: an existing column of the same name with a different expression would be kept silently |
| Rollback SQL | correct (version string matches what `migrate.js` records: the file name) |
| Locking during deploy | `ADD COLUMN … STORED` rewrites `emergency_contacts` under ACCESS EXCLUSIVE; reads of contacts (including ENS / ERS lookups) wait for the rewrite — milliseconds at DEV size (4 rows); deploy in a quiet window |
| Concurrent writes during the check | impossible: the ACCESS EXCLUSIVE lock from the ALTER is held until COMMIT |
| Locale | generated values depend on the database ctype (DEV: C.UTF-8, libc). Production locale not verified (not accessible) |
| Data touched by this audit | none: DEV only read (`transaction_read_only = on`); DEV has no 051 (`schema_migrations` 0, no norm columns); production not accessed |

DEV read-only facts (2026-11-06): PostgreSQL 18.6; 4 live contacts; 0 non-ASCII numbers; 0 cross-column pairs;
0 contacts in deleted organizations; 051 not applied.

## 8. Outstanding risks

| # | Risk | Severity | Status |
|---|---|---|---|
| F-1 | JS / SQL extension normalisation mismatch (non-ASCII spaces, BOM, `İ`) | Medium | open — remediation R-1 |
| F-2 | Cross-column collisions allowed (A's extension = B's mobile) | Medium (decision) | open — the per-call dedupe already rings such a pair once; whether they are "the same endpoint" depends on `ENS_ORIGINATE_MODE` / gateway routing |
| F-3 | Lock waits hold shared pool connections; no `lock_timeout` | Low–Medium | open — R-3 |
| F-4 | Existence oracle via 409 / identity-check | Low (inherent) | accept, or R-4 |
| F-5 | Explicit `null` in `POST /contacts` clears fields of the matched contact | Low (by requirement) | document for API consumers |
| F-6 | Broadcast-users legacy fallback (same organization, same last 9 digits) can match a different number (e.g. `+971 50 123 4567` vs `+966 50 123 4567`) and now also **replaces its mobile** (old code only renamed it) | Low | open — R-6 |
| F-7 | Upsert onto an inactive contact keeps it inactive; notice says "updated" | Low (UX) | R-7 |
| F-8 | `docs/03_API_REFERENCE.md` stale; `fs-cp` copy predates the service | Low | before promotion to `fs-cp` |
| F-9 | Table rewrite lock during 051 | Low | quiet-window deploy |
| F-10 | Implementation-run logs were removed by temp cleanup; this review re-ran the migration, parity, W2 and DEV checks; full-suite numbers rest on CONTACT_DUPLICATE_TEST_REPORT.md | Info | — |
| R-3/R-4 of the compatibility report | export quote re-import; deleted-organization contacts | Low | documented earlier |

## 9. Exact recommended remediation (each for separate approval; nothing was changed)

**R-1 (F-1) — one normalisation, defined once.** 051 has never been deployed anywhere (DEV: not applied), so it can
still be amended safely:
1. In 051, replace `[[:space:]]` and `lower()` with explicit, locale-independent rules shared character-for-character
   with JS, e.g. extension: remove `[ \t\n\v\f\r\u0085   -     　﻿().-]`
   (PostgreSQL ARE accepts `\uXXXX`), lower-case ASCII only (`translate(x, 'ABCDEFGHIJKLMNOPQRSTUVWXYZ',
   'abcdefghijklmnopqrstuvwxyz')`); in `normalizeExtension` use the same class and `replace(/[A-Z]/g, …)` instead of
   `\s` and `toLowerCase()`.
   Alternative: define `enrs_normalize_extension(text)` / `enrs_normalize_mobile(text)` as IMMUTABLE SQL functions used
   by the generated columns, and let the application compare against `enrs_normalize_extension($1)` in SQL (the
   import's in-memory index would then key on values returned by the database).
2. Extend CI-9 parity with the Unicode corpus of section 3 (all 24 samples must match).

**R-2 (F-2) — decide the cross-column rule.** Either (a) accept and document (current behaviour; per-execution dedupe
already prevents double calls), or (b) enforce: application check under the global lock (`extension_norm = $mob OR
mobile_norm = $ext`) plus, for a database backstop, a single-key side table `contact_identifiers(key text PRIMARY KEY,
contact_id int)` maintained by a trigger — a larger change needing its own design and migration.

**R-3 (F-3) — bound lock waits.** In `withIdentityTransaction` and the broadcast transaction, run
`SET LOCAL lock_timeout = '15s'` before `IDENTITY_LOCK`, and map SQLSTATE `55P03` to `503 { code: 'CONTACTS_BUSY' }`
("Contacts are being updated; try again"). Optionally give contact writes a small dedicated pool so they can never
starve the internal ENS / ERS API.

**R-4 (F-4, optional).** Audit `identity-check` calls by count per user, or add a per-user limiter for that route.

**R-6 (F-6).** In the broadcast legacy-fallback branch only, keep the stored mobile (exact old behaviour), or require
the full normalised numbers to agree when both have a country code.

**R-7 (F-7, optional).** When `upserted` and the contact is inactive, say so in the notice.

**R-8 (F-8).** Update `docs/03_API_REFERENCE.md` `POST /api/v1/contacts`; promote the service and 051 to `fs-cp`
together.

## 10. Outstanding Excel validation (Phase 6)

| Item | Finding |
|---|---|
| 59/59 | That result was W2 = `contactsEnterprise.test.js` at 14d057e (re-run on 2026-11-05 17:23 UTC after the first W2 run printed no results). **Reproduced in this review: 59/59** on a clean `git archive` of 14d057e, isolated namespace, throw-away DB. |
| Final snapshot comparison | **Still outstanding as originally designed, and no longer completable that way**: its "before" snapshot (17:06 UTC) lived in the removed scratchpad. |
| Substitute evidence | The same read-only snapshot script (recovered verbatim) run now vs the session's first snapshot (2026-11-05 14:58 UTC, preserved in the transcript): the repository's protected files (`.env` ×2, `package.json` ×2, lockfiles ×2) are identical in size and mtime; `/opt/freeswitch-ui/fs-enrs-dev` is identical; `/opt/freeswitch-ui/fs-enrs` moved d819643 → 14d057e by `git pull --ff-only` at 2026-11-05 17:07:56 UTC with lockfile writes at 17:08–17:09 UTC. |
| Attribution | That pull happened inside the validation window (17:06–17:24 UTC), three minutes after 14d057e was pushed (17:05 UTC). No command of this session in that window (or at any time) ran `git pull`, `npm ci` or `npm install` (transcript searched); it matches the documented routine "push from Windows, pull on WSL dev; use npm ci". The original comparison would therefore have shown this difference. |
| Conclusion | The validation itself left the protected files untouched; the DEV checkout change is attributable to the routine pull, which should be confirmed by the owner. |

---

## Final recommendation: **APPROVE WITH CONDITIONS**

Before the migration is committed (preferred) or at the latest before its first deployment:
1. **R-1** — align extension normalisation between JavaScript and migration 051 and extend the parity test (F-1).
2. **R-2** — record the decision on cross-column collisions (accept and document, or schedule enforcement) (F-2).

Before production deployment:

3. **R-3** — bound identity-lock waits (F-3).
4. Run the duplicate audit queries on the target database; deploy 051 in a quiet window (F-9).

Non-blocking: R-4, R-6, R-7, R-8. Business logic outside contacts is unaffected (full regression identical to the
baseline; ENS / ERS paths change only by removing normalised duplicate destinations).
