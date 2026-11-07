# DEV Migration 051 — Final Compatibility Review

Date: 2026-11-06. Strictly read-only follow-up to [DEV_MIGRATION_051_READINESS.md](DEV_MIGRATION_051_READINESS.md).
Old backend = `14d057e` (what DEV runs now). New backend = `6f4aa5d` (release, pulled on DEV, not yet running).

DEV was not accessed in this review. Every test ran on throw-away PostgreSQL 18 databases in a network-isolated
namespace with `.env` masked, using clean `git archive` copies of each commit (migration 051 added to or removed
from the copy as each scenario required). Mobile numbers are masked (`***` + last 3 digits) in all output.

## 1. The six old-backend tests that fail only with 051

Same suite (`contactsEnterprise`, `contactsImportExcel`, `internal-api`, `campaignAuthorization`, `ersRingAllPhase5`
at 14d057e): without 051 → 2 failures (the known baseline ones); with 051 → 8. The 6 additional failures:

| # | Test (file) | Expected | Actual | Exact reason | Classification | Real workflow affected? |
|---|---|---|---|---|---|---|
| 1 | CE-11 "the same person in another organization is not a duplicate" (`contactsEnterprise.test.js`) | CSV import into org A2 inserts 1 | inserted 0, 1 row error | the mobile already belongs to a contact of org A1 → `uq_contacts_mobile_norm` | **expected uniqueness change** (requirement 1/3) | CSV import: a number of another organization is now refused |
| 2 | CE-15 "simultaneous imports into different organizations do not block or skip each other" | both imports insert 15 | 0 and 0 | the 15 numbers (`rowsCsv` → `05000000`–`05000014`) were already imported by the **previous** CE-15 test into a third organization, so every row of both imports is another organization's number | **expected uniqueness change + test-data reuse**, not a concurrency defect (§2 reproduces with fresh numbers: always 15 + 0) | concurrent imports: one organization receives the numbers, the other is refused per row |
| 3 | CE-16 "re-importing the export … into another organization the values arrive as exported" | 9 rows inserted into org Y | rows refused one by one with `duplicate key value violates unique constraint "uq_contacts_extension_norm"` / `…mobile_norm` (errors listed for lines 2–7 and onward) | the exported numbers belong to org X | **expected uniqueness change**; the *old* code shows the raw constraint message (cosmetic, old code only) | CSV re-import into another organization is refused |
| 4 | CE-18 "bulk delete across tenants …" | test setup inserts 2 contacts | setup INSERT fails: `Key (mobile_norm)=(12) already exists` | the fixture mobile `12` normalises equal to an earlier fixture `-12` | **test-data collision** (fixture), not a product behaviour | none — bulk delete itself is unaffected |
| 5 | CX-5 "Excel import … compressed workbooks …" | 5 rows inserted | 4 inserted, row 5 error `uq_contacts_mobile_norm` | row 5's mobile (`9.66501234567E+11` → `***567`) equals row 4's number in another organization | **expected uniqueness change** | Excel import: a repeated number is refused |
| 6 | CX-10 "duplicate detection … preview and commit agree" | 2 inserted | 1 inserted, 1 row error | row 5 imports into org A2 a number row 3 just created in org A1 | **expected uniqueness change** | Excel import: cross-organization repeat refused |

None is a backward-compatibility defect of the release. Items 1–3, 5 and 6 are the intended rule; 2 and 4 are
amplified by fixtures that reuse numbers. The only old-code-specific observation is message quality: on a 051
database the old import reports the raw constraint text and the old Add / Edit return the generic
`"A record with this value already exists"` (409). This applies only while the old code runs on a migrated
database (§4, state B).

## 2. Concurrent cross-organization import

Fresh numbers per round; two organizations import the same file at the same moment.

| Code (database with 051) | Rows per file | Rounds | Outcome per round | Live contacts afterwards | Messages |
|---|---|---|---|---|---|
| old 14d057e | 15 | 5 | 200/200 — inserted **15 + 0** (4×) or **0 + 15** (1×) | 15, all in **one** organization (5/5) | refused rows: `duplicate key value violates unique constraint "uq_contacts_mobile_norm"` |
| old 14d057e | 1 | 5 + 10 | 1 + 0 (13×) or 0 + 1 (2×) | exactly 1 (15/15) | same raw message |
| new 6f4aa5d | 15 | 5 | 200/200 — inserted **15 + 0** (5×) | 15, in one organization (5/5) | `This mobile number is already assigned to a contact in another organization` (`conflicts` counted) |
| new 6f4aa5d | 1 | 5 + 10 | 1 + 0 (14×) or 0 + 1 (1×) | exactly 1 (15/15) | same controlled message |

- **Does either organization insert?** Yes, always exactly one; never both, never neither, never split.
- **Controlled conflict?** Yes: HTTP 200 with per-row errors; new code: readable message and `conflicts` counter;
  old code: raw constraint message.
- **Deterministic?** The result is (one owner, the other refused, exactly one live contact); *which* organization wins
  depends on which transaction reaches the lock / index first — by design.
- **API status**: 200 for both requests in every round (row-level reporting), never 500.

Without 051 (today's DEV), the old code inserts the number in **both** organizations every time (10/10: live 2).

## 3. Contact-writer compatibility (probe on four code × schema combinations)

| Scenario | A: old + no 051 (DEV now) | B: old + 051 | C: new + no 051 | D: new + 051 (target) |
|---|---|---|---|---|
| Add new number | 201 | 201 | **500** `column "extension_norm" does not exist` | 201 |
| Add same number, same org | 201 (2nd contact) | 409 generic | **500** | **200 `upserted`, matched_by mobile**, 1 contact |
| Add, other org same tenant | 201 | 409 generic | **500** | 409 `IDENTIFIER_IN_OTHER_ORGANIZATION` |
| Add, other tenant | 201 | 409 generic | **500** | 409 same code, nothing disclosed |
| Edit to a same-org contact's number | 200 (duplicate) | 409 generic | (no contacts creatable) | 409 `IDENTIFIER_IN_USE` (names the same-org contact) |
| Edit to another org's number | 200 | 409 generic | — | 409 `IDENTIFIER_IN_OTHER_ORGANIZATION` |
| Edit, own number reformatted | 200 | 200 | — | 200 |
| CSV: existing same-org number + new row | 2 inserted | 1 inserted, 1 raw error | **500** | 1 created, **1 updated** |
| CSV: number of another org | inserted | raw row error | **500** | row conflict, controlled message |
| Excel: existing same-org number + new row | 2 inserted | 1 inserted, 1 raw error | **500** | 1 created, 1 updated |
| Excel: number of another org | inserted | raw row error | **500** | row conflict |
| broadcast-users, same-org number | updated | updated | **500** | updated |
| broadcast-users, another org's number | updated (renamed the other org's contact!) | **409 for the whole request** | **500** | 200 with `rejected[]` for that user |
| 5 concurrent Adds, same number, same org (5 rounds) | 25 × 201 → 5 contacts each | 5 × 201 + 20 × 409 → 1 each | 25 × 500 | 5 × 201 + 20 × 200 upserted → 1 each |
| concurrent Adds, two tenants (5 rounds) | 201 + 201 → 2 each | 201 + 409 → 1 each | 500 + 500 | 201 + 409 → 1 each |
| concurrent CSV, two orgs (10 rounds) | 1 + 1 → 2 each | one wins → 1 each | 500 / 500 | one wins → 1 each |

State C also returns the database error text to the client (`column "extension_norm" does not exist`, 68 server-log
entries). Listing, export, ENS, ERS, conferences, IVR and reports do not use the new columns.

Real boot: `validateSchema()` at startup checks only media / recording tables, so the new code **boots normally** on a
database without 051 — state C is not prevented at startup; it shows up at the first contact write.

## 4. Migration and restart sequence

| State | When it occurs | Contact operations | Duration under the procedure |
|---|---|---|---|
| **A** old + pre-051 | now on DEV | all work; duplicates are created freely (the defect being fixed) | until step 3 |
| **B** old + post-051 | after `migrate.js`, before the restart | all work; duplicates refused with generic / raw messages; **broadcast-users with another organization's number fails the whole request (409)** | seconds — restart immediately |
| **C** new + pre-051 | only if the backend restarts **before** the migration (PM2 autorestart after a crash, WSL / Windows restart, `wsl --shutdown`, a manual restart) | **every Add / Edit / CSV / Excel / broadcast-users write fails with 500** and leaks the SQL error text; ENS / ERS / reads unaffected | must be **zero** — the procedure never enters it |
| **D** new + post-051 | after the restart | all work as designed | permanent |

The recommended order (readiness report §8: migrate, then restart at once) passes only through A → B → D and never
through C. The only window with degraded contact behaviour is B, bounded by the time between the two commands, plus
the few seconds PM2 needs to restart (during which the whole API, including the internal ENS / ERS API, is briefly
unavailable — as for any restart).

Refinements that further minimise the windows:
1. Run the migration and the restart back-to-back in one maintenance moment (no administrator importing or
   editing contacts, no broadcast-users integration call, no ENS / ERS test in progress).
2. Until then, avoid anything that restarts the DEV backend (state C is the only state that breaks contact writes).
3. Rollback must mirror the order: return to old code first (D → B), then roll back the database (B → A).

## 5. Conclusion

- No backward-compatibility defect in the release: every difference between A and D is the confirmed uniqueness and
  upsert behaviour, and D behaves correctly under concurrency (exactly one live contact per number in all 30
  concurrent rounds of state D: 5 same-org Add, 5 two-tenant Add, 10 + 5 one-row imports, 5 fifteen-row imports).
- The six old-code failures are intended rule changes, two amplified by test fixtures that reuse numbers.
- Transitional risks are confined to state B (seconds, cosmetic messages; one broadcast-users request may be refused
  as a whole) and state C (avoidable by the documented order).

**READY FOR APPROVAL**

Approval is still required for: applying 051 on DEV and restarting `fs-enrs-backend` immediately afterwards
(readiness report §8–§10). Nothing has been executed on DEV.
