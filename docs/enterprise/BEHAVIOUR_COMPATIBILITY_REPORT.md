# Contact Duplicate Prevention — Behaviour Compatibility Report

Scope: the change set described in [CONTACT_UPSERT_IMPLEMENTATION.md](CONTACT_UPSERT_IMPLEMENTATION.md).
Rule applied: business behaviour does not change except where the confirmed requirements (2026-11-06) demand it;
every such change is listed in section 2 and in [BEHAVIOUR_CHANGES.md](BEHAVIOUR_CHANGES.md).

## 1. Preserved (unchanged code paths; full regression identical to the baseline)

| Area | Why unchanged | Evidence |
|---|---|---|
| ENS campaign creation and execution, retries, settlement, throttling | Only `resolveDialTargets` filters normalised duplicates; with no duplicates it returns the same list in the same order. Retry / attempt code untouched | full integration + unit suites: same failures as baseline; `ensAttemptSettlement`, `campaignEngineRouting` pass |
| ERS ring-all, waves, overflow, queue, escalation | `resolveTierResponders` drops only a second contact with the same normalised number; with none it returns the query result object-for-object (CI-12 compares them). Leg order is not re-sorted | `ersRingAllPhase5`, `tierStatus` (same pre-existing failures), CI-12 |
| Emergency conferences, recording, controls | Not touched | full suites |
| IVR Designer, Lua execution, dialplan | Lua scripts not touched; the lookup lists keep their shape (sorted array of numbers), minus normalised repeats | `internal-api`, CI-12 |
| Notification recording / playback, Piper TTS | Not touched | full suites |
| Reports and Excel / CSV exports | Not touched (exports read the same columns; the generated columns are not exported) | `contactsEnterprise` CE-8, CE-16, CE-17 |
| Tenant isolation | All existing tenant checks stay before the identity check; the platform-wide lookup never returns another organization's contact to the caller (message names only the field). Audit details never carry another organization's contact id | CI-4, CI-5, CI-7, CI-10; CE-6, CE-7, CE-14; CX-11 |
| Contact ↔ group relationships | An upsert updates in place (same id); memberships and ERS / ENS assignments are never rewritten | CI-1, CI-11 |
| `PUT /contacts/:id` contract | Same fields and semantics; only a new 409 for numbers held by another contact | CI-6, CE-10 |
| Import contract | Every existing response field kept with its meaning for the rows it counts; new fields are additive | CE-11, CX-10, CX-12, CX-14 |

## 2. Intended changes (required by the confirmed business rules)

| # | Change | Who notices |
|---|---|---|
| C-1 | Add Contact with a number already held in the same organization updates that contact (200, `upserted`) — was a second contact (201) | Admins; API callers that expected a new id (they get the existing id) |
| C-2 | Add / Edit / import / broadcast with a number of another organization or tenant is refused — was accepted | Anyone sharing a number across organizations (DEV: 0 such cases) |
| C-3 | Extension of one contact + mobile of another is refused, never merged | — |
| C-4 | Import: a matching row updates its contact (filled cells win) — was skipped only on an exact four-field match and inserted otherwise | Admins re-importing changed files |
| C-5 | ERS broadcast-users: other-organization users listed in `rejected`; the matched contact's mobile is set to the number sent (latest value) | Integrations |
| C-6 | A person reachable twice in one ENS campaign / ERS wave through two contacts with the same normalised number is called once | Recipients (fewer duplicate calls) |
| C-7 | Database: migration 051 (two derived columns, two partial unique indexes); refuses to run while duplicates exist | Operators (see the deployment steps) |

## 3. Issues found during implementation and how they were handled

| # | Issue | Decision |
|---|---|---|
| R-1 | `POST /ers/broadcast-users` matched users by the last 9 digits within the organization; exact normalised matching alone would have created a second contact when the caller sends `+966…` for a stored `05…` | **Fixed to preserve behaviour:** the old same-organization match is kept as a fallback when the identifiers match no contact (CI-11). Uniqueness is unaffected |
| R-2 | The ERS de-duplication first re-sorted responders by id, which could change leg order | **Fixed:** duplicates are removed in place; order untouched (CI-12) |
| R-3 | Export → re-import into the same organization: the export prefixes formula-like roles (`=1+1`) with `'`; import has always stored that quote. Under "latest values" the first re-import updates those roles once (`'=1+1`); later re-imports change nothing. Previously the rows were skipped | **Documented, not changed** — stripping the quote on import would change existing import behaviour (CE-16 asserts the current result). Option for a later decision: strip a single leading `'` before `= + - @ tab CR` on import |
| R-4 | Deleting an organization does not soft-delete its contacts, so those contacts keep their numbers and a reuse is reported as "another organization" | **Documented, not changed** (organization deletion behaviour is out of scope). DEV: 0 live contacts in deleted organizations (read-only check, 2026-11-06) |
| R-5 | The Add form used to send every field (blank → `null`); with the upsert that would wipe the existing contact's data | **Fixed:** Add sends only filled-in fields (`contactPayload`); Edit unchanged |
| R-6 | Local vs international mobile forms are distinct identities (no tenant country setting exists) | By design (confirmed); `0501234567` and `+966501234567` can still be two contacts — the per-execution dedupe does not merge them either |
| R-7 | Contacts written by direct SQL bypass the application checks | The unique indexes still refuse duplicates (CI-9) |

## 4. API compatibility

All changes are additive or are the confirmed 409 refusals: `upserted`, `matched_by` on `POST /contacts` 200;
`code` / `field` / `contacts` on 409 bodies (`error` kept); import fields `created`, `updated`, `unchanged`,
`conflicts`, `duplicates_prevented`, `updates`; broadcast `rejected`; new `GET /contacts/identity-check`.
No field was removed or renamed. The frontend reads older responses unchanged (`importCounts` fallback tested).

## 5. Risks for deployment

- Migration 051 fails (safely) on a database with duplicates — run the audit queries first (implementation doc §7).
- Callers that relied on `POST /contacts` always returning 201 must accept 200 (`upserted`).
- The global advisory lock serialises contact writes platform-wide; each holder is a short transaction (largest:
  a 10,000-row import; the CX-9 test of that size took under 3 s in total), so a concurrent save may wait a few seconds.
