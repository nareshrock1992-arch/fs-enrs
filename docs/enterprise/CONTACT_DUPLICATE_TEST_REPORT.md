# Contact Duplicate Prevention — Test Report

Run on 2026-11-06 in an isolated network namespace (loopback only), `backend/.env` and `frontend/.env` masked,
each run against a throw-away PostgreSQL 18 created and destroyed by the run. No DEV or production database was used
for tests. Baseline: the committed tree 14d057e (same failure set as the recorded `ec-audit` baseline).

## 1. Results against the baseline

| Suite | Baseline | This change | Failures |
|---|---|---|---|
| Backend integration (full) | 7 failed | 7 failed, 372 passed (427, incl. skipped) | identical set (diffed by test name) |
| Backend unit + Lua (full) | 35 failed | 35 failed, 2018 passed (2053) | identical set (diffed by test name) |
| Targeted: `contactIdentity` (unit), `contactsIdentity`, `contactsImportExcel`, `contactsEnterprise` | — | 177 / 177 passed | none |
| Frontend tests | 331 / 331 | 335 / 335 | none |
| Frontend lint | 0 errors, 805 warnings | 0 errors, 805 warnings | — |
| Frontend production build | builds | builds | — |
| Backend lint (`eslint .`, same command on HEAD and on the tree) | 44 errors, 75 warnings | identical per file / rule / severity | the two errors in changed files (`campaignEngine.js` no-empty, `ensInternalController.js` no-useless-catch) exist at HEAD |
| `git diff --check` | — | clean | — |

The pre-existing failures (not hidden, not touched): integration — `campaignAuthorization` 1, `dialResolver` 1,
`ersRingAllPhase5` 1 (reconcile sweep), `ivrLifecycle` 2, `tierStatus` 2; unit — `conferenceProvider` 1,
`ersCallerNamePresentation` 8, `gatewayFileProvider` 4, `infrastructure.eventBus` 2, `infrastructure.logger` 12,
`sofiaProvider` 2, `switchConfParser` 2, `varsParser` 2, `xmlGenerator` 2. The earlier note "42 errors / 56
warnings" for backend lint was measured with a different scope; under one identical command HEAD and the tree match.

Lua: no Lua file changed; the Lua suites ran inside "unit + Lua" with unchanged results.

## 2. Required cases → tests

### Backend unit / service tests (brief §9, 1–17)

| # | Case | Test |
|---|---|---|
| 1 | New contact | CI-1 scenario A (201) |
| 2 | Existing extension | CI-1 B/C/D (by extension → same id) |
| 3 | Existing mobile | CI-1 B/C/D (by mobile) |
| 4 | Both identifiers, same contact | CI-1 B/C/D (by both) |
| 5 | Extension changed | CI-1 "a new extension for a known mobile"; CI-6 Edit |
| 6 | Mobile changed | CI-1 scenario E |
| 7 | Conflicting identifiers | CI-5 (same / other organization); CI-U3 |
| 8 | NULL extension | CI-3 "missing, empty …"; CI-9; CI-U1 |
| 9 | NULL mobile | CI-3; CI-9; CI-U2 |
| 10 | Empty identifiers | CI-3, CI-9 (`''`, `'   '`, `' - '`); CI-U1/U2 |
| 11 | Whitespace normalisation | CI-3; CI-U1/U2; SQL ↔ JS parity CI-9 |
| 12 | Country code normalisation | CI-3 (`00` = `+`; local ≠ international); CI-U2 |
| 13 | Different tenants, same extension | CI-4 (refused, nothing disclosed, nothing changed); CI-8 two tenants racing |
| 14 | Concurrent creates | CI-8 (8 parallel → 1 contact); CE-15 (imports + creates under the lock) |
| 15 | Contact id preserved | CI-1, CI-2, CX-10 |
| 16 | Group membership preserved | CI-1, CI-11 |
| 17 | Audit events | CI-10 (created, duplicate_prevented, identifier_conflict with/without ids, import summary); CE-18; CX-12 |

### Excel import tests (1–9)

| # | Case | Test |
|---|---|---|
| 1 | New contact | CX-10 (Gus), CX-14 (New One / New Two) |
| 2 | Existing extension | CX-14 row 2 |
| 3 | Existing mobile | CX-10 row 2, CX-14 row 4 |
| 4 | Both existing identifiers | CX-14 row 3 (unchanged) |
| 5 | Conflicting identifiers | CX-10 row 6, CX-14 row 6 |
| 6 | Same contact on several rows | CX-10 rows 3/4; CE-11 (CSV) |
| 7 | Summary accuracy | CX-14 (created + updated + unchanged + invalid = total), CX-10, CI-10 |
| 8 | Partial failures do not corrupt good rows | CX-14 (errors on rows 6–7, rows 2–5 and 8 verified in the database) |
| 9 | Existing template compatibility | CX-1 – CX-4 (template unchanged; example rows still refused), CX-11 (old CSV without an organization column) |

### ENS / ERS regression (1–8)

| # | Case | Test |
|---|---|---|
| 1 | One contact, one ENS group → one recipient | CI-12 "ENS: one contact reached directly and through a group" |
| 2 | Duplicate reference cannot produce two calls | CI-12 (ERS legs, ERS and ENS Lua lookups); CI-U4 |
| 3 | ERS ring-all unchanged | CI-12 (no duplicates → identical rows and order); `ersRingAllPhase5` same results |
| 4 | Overflow unchanged | full integration suite, same results (overflow code not changed) |
| 5 | Notification retry unchanged | `ensAttemptSettlement`, campaign suites, same results (retry code not changed) |
| 6 | Emergency conference unchanged | conference / `tierStatus` suites, same results |
| 7 | Independent campaigns reach the same contact | CI-12 "independent configurations / campaigns" |
| 8 | Group membership unchanged after updates | CI-1, CI-11 |

## 3. Existing tests changed (deliberately, each for a confirmed rule)

| Test | Before | Now | Reason |
|---|---|---|---|
| CE-11 duplicates | repeats skipped | matches update, identical repeat unchanged | latest values |
| CE-11 other organization | inserted again | refused, message checked | global uniqueness |
| CE-15 concurrency | per-organization import lock; manual create not serialised | one platform lock: two orgs racing → one owner; import and create both wait | global lock |
| CE-16 re-import | other org: 9 inserted | other org: 9 conflicts, owner not disclosed; same org: 6 roles updated once, then nothing (R-3) | global uniqueness; R-3 documented |
| CE-17 seed | mobiles `05…` | `08…` (seed collided with an earlier contact) | data only |
| CE-18 bulk-delete seeds | mobiles `11`/`12`/`13` | `9911`/… (`12` = an earlier `-12`) | data only |
| CE-18, CX-12 audit `toEqual` | — | + `updated`, `conflicts` | additive fields |
| CX-5 Cy | same mobile as Ben | distinct mobile | data only (would now be a conflict) |
| CX-10 | duplicates skipped | create / update / unchanged / conflict | the new rules |
| frontend `importCounts` | exact object | + new counters (old responses still read the same) | additive |

## 4. Migration 051 validation (throw-away database)

```
1. fresh migrate exit=0 ; 051 applied: 1
2. rollback (header statements): ok; norm columns left: 0
3. seeded duplicates (live: 2 share a mobile, 2 share an extension; a soft-deleted copy of 0599)
4. migrate with duplicates exit=1
   [051] Existing duplicate contacts must be resolved first (nothing was changed). Contacts sharing an extension: {1,3}.
         Contacts sharing a mobile number: {1,2}.
   051 recorded: 0 ; norm columns: 0 ; indexes: 0 ; contact data unchanged: yes
5. audit query lists the groups: extension|{1,3}
6. after a reviewed manual resolution (two contacts soft-deleted by hand): migrate exit=0 ; 051 recorded: 1 ; indexes: 2
7. re-run (idempotent) exit=0
   One|+966501112222|7001   Two|+966501112222|   Three||7001   Four|0599|   Gone|0599|
```

The soft-deleted copy (`Gone`) never blocked the migration; nothing was merged.

## 5. Notes

- The `[tenantScope] httpError` stack lines in the logs come from tests that expect 400/403/404 (pre-existing).
- One test of mine first failed for a wrong expectation (CI-3 sent `extension_number: null`, which clears the
  extension, as PUT does); the test now sends only the identifier under test, and a separate test pins that
  `null` clears.
- CE-16 initially failed and revealed R-3 (export quote); documented rather than changed.
- One full run had an 8th integration failure: CX-9 (10,000-row import) timed out at 20.5 s (15 s limit). Review found
  a quadratic loop in the import's in-memory index (each new row scanned the whole map); it was replaced by O(1)
  removal of the contact's previous keys. Direct measurement of a 10,000-row preview, HEAD vs tree on the same
  machine: HEAD 953 / 564 / 378 ms and 1727 / 1939 / 823 ms; tree 639 / 423 / 368 ms and 1266 / 497 / 502 ms
  (three requests per run, two runs each). CX-9 as a whole varies 1.8 – 7.6 s for **HEAD itself** on this loaded
  machine, so the timeout was environmental; the final full run below is on the fixed code.
