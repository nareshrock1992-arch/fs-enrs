# Mobile Number Identity — Scope Review

Date: 2026-11-06. Branch `fix/tenant-unification`, baseline 14d057e, migration 051.
Scope: mobile-number uniqueness and upsert only. Extension identity, cross-column rules, the extension Unicode
findings (F-1, F-2 of CONTACT_IDENTITY_ARCHITECTURE_REVIEW.md), ENS / ERS routing, retry, overflow, ring-all,
conference and group-membership logic were **not changed**.

Evidence: throw-away PostgreSQL 18 clusters (locale C.UTF-8, as DEV) in a network-isolated namespace with `.env`
masked; no DEV or production database was migrated or written.

## Executive summary

The `POST /ers/broadcast-users` legacy fallback could treat two **different international** mobile numbers as one
person because it compared only the last nine digits (e.g. `+971501234567` and `+966501234567`), renaming the wrong
contact and replacing its number. The fallback now additionally requires identical digits or a local number on one
side. All ten required mobile behaviours hold; mobile normalisation is identical in JavaScript and PostgreSQL
(50 / 50); the full backend regression has exactly the baseline failures (7 integration, 35 unit + Lua) and no new
ones. Extension identity code was not touched by this fix.

## Root cause

The original broadcast-users API (14d057e) matched an existing user by `RIGHT(digits(mobile_number), 9)`. The
contact-identity work kept that key as a compatibility fallback for local ↔ international pairs (`0501234567` /
`+966501234567`), but the key alone cannot see country codes, so any two numbers sharing the subscriber part matched.

## Commit scope

At the time of this step nothing after 14d057e was committed. By decision of the owner (2026-11-06) the fix is
committed together with the earlier, separately reviewed contact-identity change set (migration 051, upsert, import,
ENS / ERS duplicate-destination guard, frontend, documentation) in **one** commit. The staged
`EMERGENCY_CONTACTS_EXCEL_TEMPLATE_AUDIT.md` is deliberately left out and stays staged.

## 1. Result

| Required behaviour | Status | Evidence |
|---|---|---|
| 1. Mobile globally unique across organizations | met — app check + `uq_contacts_mobile_norm` | CI-4, CI-8, CI-9; migration run §6 |
| 2. Same-organization mobile on Add → that contact is updated | met (200, `upserted`, same id) | CI-1, CI-2, CI-3 |
| 3. Mobile of another organization → HTTP 409 | met (`IDENTIFIER_IN_OTHER_ORGANIZATION`, nothing disclosed) | CI-4, CI-3 (cross-tenant) |
| 4. Never merge across organizations | met — no path moves or merges a contact | CI-4, CI-5 |
| 5. Contact ids and group memberships preserved | met — updates in place | CI-1, CI-11, CX-10 |
| 6. Blank / omitted fields never erase values | met — omitted keys kept; UI omits blanks; import blank cells kept; explicit `null` / `""` in the API clears (PUT semantics, documented) | CI-2, CX-14 |
| 7. CSV and Excel identical | met — one code path (`applyIdentities`) for both formats | CE-11, CX-10, CX-14 |
| 8. ERS broadcast-users same rules | met | CI-11 |
| 9. Country codes significant | met — `+966…` ≠ `+971…` ≠ local `05…`; `00` = `+` | CI-3 (new), CI-U2, parity |
| 10. Legacy last-9 fallback never overwrites a different international number | **fixed in this step** (`legacyMobileMatch`) | CI-U6 (13 cases ×2), CI-11 (2 new) |

## 2. Mobile-specific architecture

```
input ──normalizeMobile (contactIdentity.js:21)──► key
          digits and "+" kept; leading 00 → +; only a leading + kept; empty / "+" → NULL
                       │
   pg_advisory_xact_lock(hashtext('enrs:contact-identity'))     (one lock for every contact writer)
                       │
   findIdentityMatches → SELECT … WHERE mobile_norm = key        (platform-wide, live contacts)
                       │
   classifyIdentity:  none → create │ same organization → update in place │ other organization → 409
                       │
   INSERT / UPDATE  ──► generated column mobile_norm (051, same rule in SQL)
                       └► UNIQUE INDEX uq_contacts_mobile_norm (mobile_norm) WHERE deleted_at IS NULL AND mobile_norm IS NOT NULL
```

Broadcast-users only: when the mobile (and extension) match no contact, the original same-organization
last-9-digit key is tried; a candidate is accepted only if `legacyMobileMatch(stored, sent)` holds
(`contactIdentity.js:34`):

| Stored | Sent | Before this step | Now |
|---|---|---|---|
| `0501234567` | `+966501234567` | update | update (local ↔ international, unchanged) |
| `501234567` | `+966501234567` | update | update (9-digit local) |
| `966501234567` | `+966501234567` | update | update (same digits) |
| `+971501234567` | `+966501234567` | **update — renamed the UAE contact and replaced its number** | new contact; the UAE contact is untouched |
| `971501234567` | `+966501234567` | update | new contact |
| `+44 7501 234567` | `+966501234567` | update | new contact |

Rule: last 9 digits equal **and** (all digits equal **or** at least one side is local — no `+`, and a trunk `0` or
at most 9 digits). Candidates are tried in id order; the first compatible one wins.

## 3. All mobile-writing paths

| Path | Code | Mobile identity | Lock | DB backstop |
|---|---|---|---|---|
| Add Contact `POST /contacts` | `contactController.js:342` | match → update / 409 | yes (`withIdentityTransaction`, :329) | yes |
| Edit Contact `PUT /contacts/:id` | `contactController.js:421` (mobile change check :458) | another contact's mobile → 409 | yes | yes |
| CSV / Excel import (commit) | `applyIdentities`, `contactController.js:792` | per row, in file order, savepoints | yes (whole import) | yes |
| Import preview | same function, `write: false` | same decision, no writes | not needed | — |
| ERS broadcast-users | `ersController.js:425` (fallback :470–484, update :492) | match → update / rejected; legacy fallback | yes (:457) | yes |
| Soft delete / bulk delete | `contactController.js` | frees the number | not needed | — |
| `backend/scripts/cleanup_duplicate_orgs.sql` | operator one-off | moves contacts between organizations, numbers unchanged | no | yes |
| `docs/sample_data_yasref.sql`, test fixtures | manual SQL | — | no | yes |
| `fs-cp/fs-enrs` (older backend copy) | — | none (pre-identity code) | no | yes once 051 is applied |

ENS / ERS **read** mobiles only; their per-execution de-duplication (`uniqueByDialTarget`) is unchanged by this step.

## 4. Normalisation parity (JavaScript vs the stored column)

50 mobile inputs inserted into a table copied with `LIKE emergency_contacts INCLUDING GENERATED` (the real 051
expression) and compared with `normalizeMobile`: **50 / 50 identical**. The mobile rule uses only `[^0-9+]` and
`^00`, which do not depend on the database locale.

Covered: NULL, `""`, spaces, `+`, `++`, punctuation-only, letters; local forms with spaces / dashes / brackets /
dots; `+966…`, `(+966)`, `+ 966`, `00966…`, `00 966…`, `0 0966…`, `000966…`, `+00966…`, `966…`, `+971…`, `00971…`;
`+44 (0) 7700 …`; an `ext. 12` suffix; misplaced `+`; NBSP / BOM / ideographic space; full-width `＋` and digits;
Arabic-Indic digits; a letter `O` inside the number; tab / newline; 20-digit input; `0`, `00`, `+0`, `00+966`.

Identical in both, but worth knowing (input semantics, not parity defects):

| Input | Key | Note |
|---|---|---|
| `+44 (0) 7700 900123` | `+4407700900123` | the national `(0)` is kept → differs from `+447700900123` |
| `+1-555-010-0000 ext. 12` | `+1555010000012` | extension digits become part of the number |
| `+٩٦٦501234567` | `+501234567` | Arabic-Indic digits are dropped silently |
| `05O1234567` (letter O) | `051234567` | letters are dropped silently |
| `＋966501234567` (full-width plus) | `966501234567` | treated as no `+` |
| `000966501234567` | `+0966501234567` | only the first `00` becomes `+` |

## 5. Database uniqueness guarantees (verified)

```
uq_contacts_mobile_norm: CREATE UNIQUE INDEX … ON emergency_contacts (mobile_norm)
                         WHERE deleted_at IS NULL AND mobile_norm IS NOT NULL
stored keys: +966 50 999 0001 → +966509990001   +971 50 999 0001 → +971509990001
             050 999 0001 → 0509990001          966509990001 → 966509990001      '' / '   ' / NULL → NULL
direct INSERT of '00 966 50 999 0001' in another organization → duplicate key … "uq_contacts_mobile_norm"
```

- Any number of contacts may have no mobile (NULL, empty, whitespace-only); they never collide.
- Soft-deleted contacts never block a number.
- Concurrency: every writer takes the global advisory lock before its lookup; eight simultaneous creates of one
  mobile → one contact (CI-8); two organizations racing → one owner, one 409 (CI-8); simultaneous imports → one
  owner, the other's rows are conflicts (CE-15). A writer outside the application is still stopped by the index.

## 6. Migration 051 — mobile implications

Verified on a throw-away database:

```
1. fresh migrate: 051 recorded, indexes uq_contacts_extension_norm, uq_contacts_mobile_norm
2. documented rollback SQL: columns=0 indexes=0 051 recorded=0
3. seeded a cross-organization mobile duplicate (+966 50 111 2222 / 00966501112222), a soft-deleted copy,
   international variants and three empty / NULL mobiles
4. migrate → exit 1: "[051] … Contacts sharing a mobile number: {1,2}" — nothing recorded, no columns,
   no indexes, data unchanged
5. after resolving the duplicate by hand → applied; international variants stored as distinct keys
6. direct duplicate insert → refused by uq_contacts_mobile_norm
7. re-run → no-op
```

**051 combines extension and mobile.** One file adds `extension_norm` and `mobile_norm`, runs one duplicate check for
both, and creates both unique indexes. Consequences: a single extension duplicate on a target database blocks the
mobile index too, and the mobile part cannot be rolled back alone.

Safest separation (not performed — needs approval; it touches extension migration logic):
1. Keep the file name `051_contact_identifier_uniqueness.sql` for the **mobile** part only (column, mobile duplicate
   check, mobile index).
2. Move the extension column, check and index unchanged into `052_contact_extension_uniqueness.sql`.
3. Why this is safe everywhere: 051 has not been applied on DEV (`schema_migrations` has no 051) or production.
   On any database where the combined 051 was already applied (only throw-away test databases), `migrate.js` skips
   051 and runs 052, whose `ADD COLUMN IF NOT EXISTS` / `CREATE UNIQUE INDEX IF NOT EXISTS` are no-ops.
4. Per-part rollback, mobile: `DROP INDEX IF EXISTS uq_contacts_mobile_norm; ALTER TABLE emergency_contacts DROP
   COLUMN IF EXISTS mobile_norm; DELETE FROM schema_migrations WHERE version = '051_contact_identifier_uniqueness.sql';`
5. The application code needs no change for the split (it reads both columns either way).

## 7. Multi-tenant isolation results

| Check | Result | Test |
|---|---|---|
| Another tenant's mobile on Add | 409, body contains only `code`, `field`, fixed message — no name, id, organization or tenant | CI-4, CI-3 (new, `+971` held in tenant B) |
| Another organization of the same tenant | 409, the contact is not moved | CI-4 |
| Identity check | tenant-scoped organization (404 for another tenant's), ADMIN only, writes nothing | CI-7 |
| Import into another organization's number | row error, owner not disclosed | CE-16, CX-10 |
| Broadcast-users | other organization's number → `rejected[]`; legacy fallback only inside the request's organization | CI-11 |
| Audit | contact ids of another organization never recorded | CI-10 |

## 8. Regression results

| Suite | HEAD 14d057e | Working tree | Difference |
|---|---|---|---|
| Mobile-related targeted (`contactIdentity` unit, `contactsIdentity`, `contactsImportExcel`, `contactsEnterprise`) | — | **193 / 193 passed** | — |
| Backend integration (full, fresh DB, same run) | 7 failed / 328 passed (383) | 7 failed / 375 passed (430) | **identical failure set**; +47 passing = new tests |
| Backend unit + Lua (full, clean archive of the whole repository at HEAD) | 35 failed / 1973 passed (2008) | 35 failed / 2031 passed (2066) | **identical failure set**; +58 passing = `contactIdentity` unit tests (45 + 13 new) |
| Lint (changed files) | — | 0 errors; 2 warnings on unchanged lines (`ersController.js:11`, `:845`) | — |
| Frontend tests / lint / production build (working tree) | baseline 331 tests; 0 lint errors, 805 warnings | 335 / 335 passed; 0 lint errors, 805 warnings; `vite build` succeeds | +4 tests (identity UI helpers); lint unchanged |

ENS / ERS duplicate destinations: CI-12 (ERS legs, ERS and ENS Lua lookups, group + direct reference, independent
configurations) passes; retry, overflow, ring-all and conference suites show the same results as HEAD.

## 9. Exact remaining risks (mobile)

| # | Risk | Severity | Note |
|---|---|---|---|
| M-1 | The same subscriber written as `+966501234567`, `966501234567` and `0501234567` is three different identities on Add / import (by design: country codes are significant, no country setting exists). Broadcast-users' legacy fallback is the only place that pairs them | Medium | needs a tenant default country to normalise to E.164 safely |
| M-2 | A **local** stored number still pairs with any international number with the same last 9 digits in broadcast-users (`0501234567` ↔ `+971501234567`) — the local side carries no country to compare | Low | inherent to the legacy key; limited to the request's organization |
| M-3 | No input validation of mobile format: letters, Arabic-Indic digits, `(0)` and `ext.` suffixes are silently dropped or merged into the key (section 4) | Low–Medium | a format check on input would be a separate, behaviour-changing decision |
| M-4 | 051 combines extension and mobile (section 6) | Low | separation plan above, awaiting approval |
| M-5 | Global lock waits hold shared pool connections (review F-3) | Low–Medium | unchanged; `lock_timeout` recommended |
| M-6 | Explicit `null` for `mobile_number` in `POST /contacts` clears the stored mobile when the contact is matched by extension | Low | existing API semantics, documented |
| — | Extension findings F-1 (Unicode normalisation) and F-2 (cross-column) | — | out of scope by instruction; still open |

## 10. Files changed in this step

| File | Change |
|---|---|
| `backend/src/services/contactIdentity.js` | new pure function `legacyMobileMatch` |
| `backend/src/controllers/ersController.js` | fallback reads all same-suffix candidates in id order and accepts the first compatible one |
| `backend/src/__tests__/unit/contactIdentity.test.js` | CI-U6 (13 cases, both directions) |
| `backend/src/__tests__/integration/contactsIdentity.test.js` | CI-3 country codes; CI-11 different international number, same digits with / without `+` |
| `docs/enterprise/CONTACT_UPSERT_DESIGN.md`, `CONTACT_UPSERT_IMPLEMENTATION.md`, `BEHAVIOUR_CHANGES.md` | fallback rule documented |
| `docs/enterprise/MOBILE_IDENTITY_SCOPE_REVIEW.md` | this report |

No migration, extension, routing, retry, overflow, ring-all, conference or group-membership code was changed.

## 11. Extension rules — what is and is not claimed

- **This fix** changes no extension code: `legacyMobileMatch` reads only mobile numbers, and the fallback runs only
  after the unchanged identity lookup (extension + mobile) has found no contact. `normalizeExtension`,
  `findIdentityMatches`, `classifyIdentity`, the extension index and migration 051 are byte-for-byte as before this
  step.
- **Relative to 14d057e**, the commit as a whole *does* contain the earlier extension identity rules (global
  extension uniqueness, matching, `extension_norm`), reviewed in CONTACT_IDENTITY_ARCHITECTURE_REVIEW.md, whose
  findings F-1 / F-2 remain open by instruction.
- Evidence that extension behaviour did not regress with this fix: all extension cases in `contactsIdentity`
  (CI-1 B/C/D, CI-5, CI-6, CI-9), `contactsEnterprise` and `contactsImportExcel` pass, and the full regression shows
  the same failures as the clean 14d057e archive.

## 12. Git and WSL synchronization

| Item | Value |
|---|---|
| Repository | `github.com/nareshrock1992-arch/fs-enrs` |
| Branch | `fix/tenant-unification` (tracks `origin/fix/tenant-unification`) |
| Base | 14d057e (local = GitHub before the push) |
| Commit | one combined commit on 14d057e; hash, push verification and WSL results are recorded in the final delivery report (a commit cannot contain its own hash) |
| WSL target | `/opt/freeswitch-ui/fs-enrs` (Ubuntu), fast-forward only |
| DEV caution | the DEV backend (PM2, watch off) keeps running the old code until restarted; **apply migration 051 on DEV before the next backend restart**, otherwise contact add / import / broadcast-users fail on the missing `mobile_norm` / `extension_norm` columns. The Vite dev UI serves the new screens immediately; they work with the old backend (the identity hint is simply absent) |
