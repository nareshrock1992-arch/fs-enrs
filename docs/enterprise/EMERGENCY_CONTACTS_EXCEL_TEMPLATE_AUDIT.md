# Emergency Contacts — Excel template and bulk import: Phase 1 audit

Status: **read-only audit, awaiting approval.** No code has been changed. This document is the only file created in this phase.

## 0. Repository verification (Phase 0)

| Check | Result |
|---|---|
| Repository root | `C:\Users\USER\Documents\fs-enrs` (WSL: `/mnt/c/Users/USER/Documents/fs-enrs`, `wslpath -w` resolves to the same folder) |
| Branch / HEAD | `fix/tenant-unification` @ `2174265363cbcfadae2345544558b50cc5617af0` = expected baseline |
| Remote / tracking | `origin` = `github.com/nareshrock1992-arch/fs-enrs`; tracks `origin/fix/tenant-unification`, which is also at `2174265` |
| Working tree | clean: 0 staged, 0 unstaged, 0 untracked, no stashes (WSL shows only the git-ignored-on-Windows `.claude/settings.local.json`) |
| Emergency Contacts implementation | present (`contactController.js` export / bulk delete / roles / audit, `utils/csv.js`, `contactTable.js`, `ColumnChooser.jsx`, `contactsEnterprise.test.js`) |
| SUPER_ADMIN governance rule | present in `GOVERNANCE.md`, referenced from `CLAUDE.md` and `docs/enterprise/SECURITY_REVIEW.md` |
| Instructions read | `CLAUDE.md`, `GOVERNANCE.md` (decision order, strict rules, genericity rule, Design Impact Assessment, SUPER_ADMIN rule), `SECURITY_REVIEW.md` |

## 1. Existing architecture

| Layer | File | Role |
|---|---|---|
| Route | `backend/src/routes/v1/contacts.js` | `POST /contacts/bulk-upload` (`adminOnly`, multer memory storage, **5 MB** limit, field `file`); `GET /contacts/export` (`adminOrOp`); `:id` validated |
| Controller | `backend/src/controllers/contactController.js` | `bulkUpload` (CSV import), `exportContacts` (CSV export), `verifyContactRefs` / `verifyOrgChildren` (organization, department, location ownership), `ContactSchema` (zod), `dupKey`, `auditContacts` |
| CSV writer | `backend/src/utils/csv.js` | RFC 4180 quoting, CRLF, formula-injection neutralisation (`'` prefix; phone numbers kept) |
| XLSX writer | `backend/src/utils/xlsxWriter.js` + `zipStore.js` | dependency-free `.xlsx` writer used by report exports: several sheets, bold header, frozen header, auto-filter, column widths, summary/instruction sheets, inline strings |
| Tenant scope | `backend/src/middleware/tenantScope.js` | `effectiveTenantId` (token tenant; SUPER_ADMIN: `tenant_id` or all tenants) |
| Page | `frontend/src/pages/contacts/ContactList.jsx` | "CSV Upload" button → modal: organization select, `<input accept=".csv">`, "Download template", result panel |
| Helpers | `frontend/src/pages/contacts/contactTable.js` | `IMPORT_COLUMNS` (7 columns), `importTemplate()` (client-side CSV string), `importIssueText()` |
| API client | `frontend/src/api/client.js` | `contacts.bulkUpload(orgId, file)` (adds `tenant_id` for SUPER_ADMIN with a tenant selected), `contacts.exportCsv(q)` |
| Tests | `backend/src/__tests__/integration/contactsEnterprise.test.js` (CE-11, CE-13–CE-16, CE-18 cover import/export), `frontend/src/__tests__/contactsTable.test.js` | |

## 2. Audit questions

1. **CSV import endpoint:** `POST /api/v1/contacts/bulk-upload` → `contactController.bulkUpload`; `adminOnly` (SUPER_ADMIN, ADMIN); multipart fields `file`, `organization_id`, optional `tenant_id` (SUPER_ADMIN).
2. **CSV export endpoint:** `GET /api/v1/contacts/export` → `exportContacts`; same filters/scope as the list; all matching rows (max 50,000); columns `first_name, last_name, mobile_number, extension_number, email, role, organization, department, location, is_active, created_at, updated_at` (+ `tenant` for SUPER_ADMIN under All Tenants).
3. **Header mapping:** `csv-parse` with `columns: importHeaders` — names trimmed and lower-cased; every other column is passed to `ContactSchema`, which keeps only `first_name, last_name, role, mobile_number, extension_number, email, is_active` (+ the form's `organization_id`). **`organization`, `department` and `location` columns are ignored today.**
4. **Formats:** CSV only. No file-type check on the server: any upload is parsed as CSV (a binary file fails with "The CSV file could not be read" or produces garbage rows); the page restricts the picker to `.csv`. There is no XLSX reader in the code base.
5. **Aliases:** yes — `phone` and `mobile` → `mobile_number`, `extension` → `extension_number` (only when the canonical column is absent); header names case-insensitive; UTF-8 BOM accepted.
6. **Organization / department / location:** one organization per upload, chosen in the dialog (`organization_id`), checked by `verifyContactRefs` (live, in the caller's tenant; SUPER_ADMIN under All Tenants: any live organization). **Imported contacts never get a department or location.** (Create/update by id do check department/location ownership.)
7. **Tenant isolation:** `adminOnly`; tenant from `effectiveTenantId(req)` — token tenant for ADMIN (body/file values ignored), selected tenant for SUPER_ADMIN (sent as a form field), all tenants for SUPER_ADMIN otherwise; the organization must belong to that scope (404). Nothing in the file can name a tenant.
8. **Duplicates:** a row is skipped when a live contact of the same organization, or an earlier row of the file, has the same first + last name (trimmed, case-insensitive) and the same mobile and extension (spaces, dots, dashes, brackets removed). Whole import in one transaction under `pg_advisory_xact_lock(hashtext('enrs:contacts-import'), organization)`, per-row savepoints. No database constraint (by decision).
9. **`is_active`:** `true/yes/1/active` → true, `false/no/0/inactive` → false (case-insensitive), blank → true; anything else → row error (`is_active: Expected boolean, received string`).
10. **Results:** `200 { inserted, skipped, duplicates: [{ line, reason }], errors: [{ line, error }], total }`; `line = record index + 2`. Errors are zod texts (e.g. `first_name: String must contain at least 1 character(s)`). There is **no preview**: the upload writes immediately.
11. **Audit events:** one `contacts_imported` record per upload (`tenant_id`, `organization_id`, `total_rows`, `inserted`, `skipped_duplicates`, `error_rows`, `role`, `scope_tenant_id`), best effort after the commit. No contact data or file contents.
12. **Extensible without a second pipeline:** yes. The import already separates *rows → validation → duplicate check → insert → audit*; only the first step (file → rows) is CSV-specific. Making that step format-aware and adding a "preview" switch to the same handler keeps one pipeline (section 4).

## 3. Current limitations and findings

| # | Finding |
|---|---|
| L-1 | `organization`, `department`, `location` columns are ignored on import; a whole file goes to one organization; imported contacts never get a department or location. The requested template makes `organization` mandatory per row. |
| L-2 | CSV only; the server does not check the file type. |
| L-3 | No preview / confirmation; the upload writes at once. |
| L-4 | Row numbers are `record index + 2`, wrong when a quoted CSV value contains a line break. |
| L-5 | Row errors are technical zod texts, not the requested wording ("Row 4: First name is required"). |
| L-6 | No row-count limit (only 5 MB). |
| L-7 | The CSV template is built in the browser by string concatenation, with 7 columns and one sample row (requirement: proper serializer, 10 columns, 4 samples). |
| L-8 | `xlsxWriter.js` has no text-format column (Excel would strip leading zeros / use scientific notation), no data validation, and writes empty values as "Not recorded" text (unsuitable for a template). There is no XLSX/ZIP reader (`zipStore.js` only writes uncompressed archives; Excel and LibreOffice save compressed ones). |
| L-9 | Organization, department and location **names are not unique** (no database constraint), so name-based resolution must detect ambiguity. |
| L-10 | The frontend has no DOM test environment (no `jsdom` / Testing Library). UI behaviour (preview, confirmation) can be tested through pure helpers only, unless test dependencies are approved. |
| L-11 | The CSV export already contains `organization`, `department`, `location`. Once the import reads them, a re-imported export has those values validated (today they are silently ignored) — a behaviour change to record. |
| L-12 | No Excel or LibreOffice is available in WSL, so automated tests can use generated workbooks (including compressed ones built the way Excel stores them), but opening the template in the real applications is a manual check. |

## 4. Recommended implementation (one pipeline)

**Template download.** `GET /contacts/import-template?format=xlsx|csv` (`adminOnly`, like the import). Static content — no tenant data. XLSX built with the existing `xlsxWriter` (sheet 1 "Emergency Contacts": the 10 columns in the required order, bold frozen header, auto-filter, widths, the 4 sample rows, mobile/extension as text, `is_active` drop-down; sheet 2 "Instructions"). CSV built with `utils/csv.js` `toCsv` (UTF-8 BOM, CRLF, proper quoting). One shared column/sample definition on the server; the client-side template is removed.

**Import pipeline** (`POST /contacts/bulk-upload`, unchanged path and response fields):

1. *File → rows* (new, generic): detect the format from the content (ZIP signature → XLSX; text → CSV); reject `.xls` (OLE), macro workbooks, encrypted files and anything else with a clear 400. CSV via the existing `csv-parse` (now with real line numbers). XLSX via a new dependency-free reader: worksheet named "Emergency Contacts", else the first worksheet; values only (shared strings, inline strings, numbers converted to plain digit strings — never scientific notation, booleans → `true/false`); a cell containing a **formula is a row error** (formulas are never evaluated); empty rows ignored; row number = spreadsheet row.
2. *Header mapping* (existing): same aliases; required headers checked up front with a clear message; unknown and hidden columns ignored (a `tenant_id` column has no effect).
3. *Validation* (existing `ContactSchema`), with readable messages ("First name is required", "Both mobile number and extension number are empty", "Status must be true/false, yes/no or 1/0").
4. *Resolution* (new, reuses `verifyContactRefs` rules): `organization` by name (trimmed, case-insensitive) **only among live organizations of the target tenant**; `department` / `location` by name within that organization; not found → "Organization not found" / "Department does not belong to the specified organization"; same name twice → "matches more than one organization".
5. *Duplicate check* (existing `dupKey`, per organization).
6. *Preview or commit*: `mode=preview` returns the classification without writing (total, valid, invalid, duplicate rows, per-row messages); `mode=commit` (default — existing clients unchanged) re-runs steps 1–5 inside the transaction, takes the per-organization advisory locks in a fixed order, inserts valid rows with savepoints, and returns the actual result. Stateless: the page keeps the file and sends it again to confirm; a change of data between preview and confirm shows up in the final result.
7. *Audit* (existing `auditContacts`): one `contacts_imported` record per organization written to, with the counts and `format` (`csv`/`xlsx`) added — still no contact details or file name. Preview is not audited (no change).

**Limits:** upload 5 MB (unchanged); at most **10,000 data rows** per file (both formats); XLSX: at most 200 archive entries, 64 MB uncompressed per part and 128 MB in total (zip-bomb guard), 50 columns read; XML parts containing a `DOCTYPE` / entity declaration are rejected (no entity expansion).

**Page:** "Download Excel Template (.xlsx)" and "Download CSV Template" (visible to SUPER_ADMIN and ADMIN, using the existing `ExportButton`); the upload dialog accepts `.xlsx` and `.csv` (checked in the browser and on the server); step 1 "Check file" shows the preview counts and row messages; step 2 "Import N contacts" confirms; the result screen shows inserted, duplicates and errors. SUPER_ADMIN in All Tenants mode chooses the target tenant explicitly (D-2).

## 5. Dependency impact

**Recommended: no new dependency, no lockfile change.**
- ZIP reading uses Node's built-in `zlib` (`inflateRawSync` with `maxOutputLength` caps).
- XML parsing uses `fast-xml-parser` **4.5.7, already installed** (used by the platform `XmlParser`), called directly with value conversion off — the platform `XmlParser` wrapper is not reused because its options convert numeric text (`0501234567` → `501234567`), which would corrupt phone numbers.
- This follows the existing dependency-free `xlsxWriter` / `zipStore` approach.

Alternatives (each would need your approval and a lockfile change): **exceljs** (complete, but pulls in a large dependency tree — archiver, unzipper, jszip — for a feature that needs a small subset); **SheetJS `xlsx`** — the npm registry's latest is 0.18.5 with published advisories (CVE-2023-30533 prototype pollution, CVE-2024-22363 ReDoS) whose fixes are distributed outside npm; not recommended.

Frontend: no new dependency. DOM-level tests of the preview/confirm dialog would need `jsdom` + `@testing-library/react` as devDependencies (optional, D-6).

## 6. Security and tenant isolation

- Target tenant only from the authenticated context: ADMIN → token; SUPER_ADMIN → selected tenant, or (All Tenants) an **explicit** target tenant chosen in the dialog. No value in the file (columns, hidden sheets, defined names, document properties) can select or change a tenant.
- Names are resolved only inside the target tenant, so "Organization not found" never reveals another tenant's organizations.
- RBAC unchanged (`adminOnly` for template and import); SUPER_ADMIN is never hidden or blocked (governance rule).
- Formulas never evaluated; formula cells rejected; the template contains inline strings only (never evaluated). Values stored as text, and the existing CSV export keeps neutralising formula-like cells.
- Malformed / hostile workbooks: bounded inflation (zip bomb), entry and size caps, `DOCTYPE` rejected (entity expansion), unsupported compression methods / ZIP64 / encryption rejected, any parse failure → 400 without stack traces.
- Audit privacy unchanged (ids, counts, format only).

## 7. Tests required

**Backend** (new `contactsImportExcel.test.js` integration file + `xlsxReader` unit tests), mapped to the brief:
template XLSX (sheet names, 10 headers in order, 4 samples, instructions sheet, text format on mobile/extension, drop-down) · CSV template (headers, samples, BOM, quoting) · header mapping for CSV and XLSX (aliases, case, order independence) · XLSX import success (shared and inline strings, compressed parts) · empty rows · leading zeros and long numbers (text cells, numeric cells without scientific notation) · optional fields · invalid status values · missing headers · malformed / truncated / non-ZIP / `.xls` / encrypted / zip-bomb / `DOCTYPE` workbooks · unsupported file types · duplicates (existing contact, within the file, preview vs commit) · unknown and ambiguous organization · department/location of another organization · tenant isolation (ADMIN cannot reach another tenant's organization by name) · SUPER_ADMIN selected tenant · SUPER_ADMIN All Tenants without / with explicit target tenant · audit records (per organization, format, no personal data) · formula cells · file-size and row-count limits · preview writes nothing · existing CSV files without organization column still import (compatibility).

**Frontend** (`contactsTable.test.js` / new helper tests): template download calls · file type and size validation · preview summary (total / valid / invalid / duplicates) and row-message formatting · confirmation step state · SUPER_ADMIN visibility (both modes, target-tenant requirement) · tenant-admin restrictions (capability matrix).

**Regression:** all 59 contact tests, the 94 combined tests, full backend suites compared with the baseline (7 integration / 35 unit+Lua pre-existing failures), 326 frontend tests, changed-file lint, production build, `git diff --check`.

## 8. Files expected to change

| File | Change |
|---|---|
| `backend/src/controllers/contactController.js` | split `bulkUpload` into the shared pipeline; preview mode; name resolution; readable messages; template handler |
| `backend/src/routes/v1/contacts.js` | `GET /contacts/import-template` |
| `backend/src/utils/xlsxWriter.js` | additive: text-format columns, data-validation lists, truly empty cells |
| `backend/src/utils/zipStore.js` | additive: bounded ZIP reader (stored + deflated entries) |
| `backend/src/utils/xlsxReader.js` (new) | generic worksheet reader (values only) |
| `backend/src/utils/tabularFile.js` (new) | generic "uploaded CSV or XLSX → header + numbered rows" |
| `backend/src/__tests__/integration/contactsImportExcel.test.js` (new), `backend/src/__tests__/unit/xlsxReader.test.js` (new) | tests |
| `frontend/src/pages/contacts/ContactList.jsx` | template buttons; import dialog (file types, target tenant, preview, confirm) |
| `frontend/src/pages/contacts/contactTable.js` | remove client-side template; pure helpers for file checks and preview summary |
| `frontend/src/api/client.js` | template download; preview / commit upload |
| `frontend/src/__tests__/contactsTable.test.js` | updated / new tests |
| `docs/08-rest-api-reference.md`, `docs/enterprise/BEHAVIOUR_CHANGES.md` | API and behaviour documentation |

Not changed: `package.json`, lockfiles, `.env` files, migrations, schema, other modules, `/opt/freeswitch-ui` checkouts.

## 9. Design Impact Assessment (GOVERNANCE.md)

1. **Objective** — downloadable XLSX and CSV templates; XLSX import through the existing contact import pipeline with preview and confirmation.
2. **Reused unchanged** — `ContactSchema`, `dupKey`, advisory-lock + savepoint transaction, `verifyContactRefs` / `verifyOrgChildren` rules, `effectiveTenantId`, `adminOnly`, `auditContacts`, `utils/csv.js`, `ExportButton`, `Pagination`/`Modal` UI, `fast-xml-parser`, `csv-parse`.
3. **Extended (additive)** — `xlsxWriter.js` (text-format column style, data-validation lists, blank cells: new optional column/sheet options, existing report output byte-identical); `zipStore.js` (new reader export; writer untouched); `bulkUpload` (format-aware input, `mode`, per-row organization).
4. **New components** — `xlsxReader.js` and `tabularFile.js`. Existing code cannot read XLSX at all, and parsing CSV is currently inline in the contact controller; extending the controller would create module-specific infrastructure. Both are generic ("uploaded spreadsheet → rows"), so future imports — Directory (users, departments), Dialplan / IVR (number or prompt lists), Call Center (agents, queues) — can reuse them unchanged. They belong in `utils/` beside `xlsxWriter.js` and `csv.js`.
   *AI-consumable (Q4):* the preview returns structured JSON (counts + `{ row, field, message }`), usable by automation.
5. **Regression analysis** — FreeSWITCH configuration providers (`vars.xml`, `switch.conf.xml`, `event_socket.conf.xml`, `acl.conf.xml`, `sofia.conf.xml`, `conference.conf.xml`, gateway providers): unaffected — no file in `backend/platform`, generators, Lua or deployment code changes. Report exports: `xlsxWriter` changes are opt-in options; existing calls produce the same output (to be proven by comparing generated workbooks before/after). Contact pickers (D4), list, export, bulk delete, create/edit, audit: unchanged paths. Existing CSV files without an `organization` column: unchanged behaviour (D-1).
6. **Files changed** — section 8.
7. **Observability** — module `contacts`. INFO: `contacts import previewed` / `contacts import committed` with format, row counts, organization count, duration, request id. DEBUG: format detection, worksheet chosen, header mapping. Performance: parse + validation time logged when above 2 s. Sensitive data: no file contents, names, numbers or e-mail addresses in any log (counts and ids only).
8. **Approval gate** — stop here.

## 10. Decisions requested

| # | Decision | Recommendation |
|---|---|---|
| D-1 | Organization per row | When the file has an `organization` column it is **mandatory per row** and resolved by name in the target tenant (department/location must belong to that row's organization). Files **without** the column (existing CSVs) keep today's behaviour: the organization chosen in the dialog. |
| D-2 | SUPER_ADMIN in All Tenants mode | The import dialog asks for the **target tenant** (existing tenant list) and the server requires it for files with an `organization` column; never hidden or blocked. Selected-tenant mode uses the header tenant. |
| D-3 | Template sample rows left in a file | Rows identical to the four template samples are reported as invalid ("Example row from the template — remove it before uploading") so they can never be imported by accident. |
| D-4 | Limits | 5 MB (unchanged), 10,000 data rows, XLSX archive caps as in section 4. The row limit also applies to CSV (new). |
| D-5 | `is_active` drop-down | List `true,false` shown as a drop-down with an *informational* message, so `yes/no/1/0` (also accepted) can still be typed. |
| D-6 | Frontend DOM tests | Pure-helper tests only (no new dependency), or approve `jsdom` + `@testing-library/react` devDependencies for rendering tests of the dialog. |
| D-7 | Behaviour changes to record | Import now reads `organization` / `department` / `location` columns (were ignored), checks the file type, limits rows, reports readable messages with accurate row numbers; re-imported exports are validated (L-11). |
