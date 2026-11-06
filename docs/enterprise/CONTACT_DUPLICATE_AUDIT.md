# Contact duplicates — audit (Phases 0–2)

Status: read-only audit. No code or data changed. Repository `C:\Users\USER\Documents\fs-enrs`, branch
`fix/tenant-unification` @ `14d057e` (level with GitHub). The pre-staged `EMERGENCY_CONTACTS_EXCEL_TEMPLATE_AUDIT.md`
is left untouched.

## 1. Root cause

Contact identity is never checked on extension or mobile number.

| Path | Code | Duplicate handling today |
|---|---|---|
| Manual create — `POST /contacts` | `contactController.createContact` | none: always inserts |
| Manual edit — `PUT /contacts/:id` | `updateContact` | none: can set an extension / mobile already used by another contact |
| Excel / CSV import — `POST /contacts/bulk-upload` | `bulkUpload` (`tabularFile` → `evaluateRows` → `markDuplicates`) | skips a row only when first name + last name + mobile + extension **all** match a contact of the same organization; the same extension under a different name is inserted |
| ERS broadcast users — `POST /ers/broadcast-users` (API only, no UI caller) | `ersController.upsertBroadcastUsers` | its own upsert: matches the **last 9 digits** of the mobile within the organization (can merge different countries' numbers; ignores extensions) |

No other code writes `emergency_contacts` (seed / scripts / internal API checked). There is no database uniqueness on
either identifier (`idx_contact_mobile` is a plain index; no tenant column on `emergency_contacts` — the tenant comes
from `organizations.tenant_id`).

## 2. How duplicates turn into duplicate calls

| Calling path | Recipient resolution | Same number on two contact records |
|---|---|---|
| ENS campaign (UI / API trigger, Lua start) — `campaignEngine.resolveContacts` → `resolveDialTargets` | `DISTINCT` by **contact id**; one destination per contact | **two destinations → two calls** |
| ERS ring-all — `ersRingService.resolveTierResponders` | `DISTINCT` by **contact id**; every wave originates one leg per contact | **two legs per wave** (the `ers_incident_responders` row is de-duplicated by number, the call is not) |
| ERS Lua lookup — `ersInternalController.resolveResponders` | `Set` of exact strings | one call if written identically, two if formatted differently |
| ENS Lua lookup — `ensInternalController.resolveEnsContacts` | `Set` of exact strings (mobile and extension both) | same as above |

The same contact attached to a group **and** directly to a configuration is already one recipient (selection by
contact id). Group membership has `UNIQUE (responder_group_id, emergency_contact_id)`.

## 3. Existing data (DEV, read-only, `default_transaction_read_only=on`)

| Check | Result |
|---|---|
| Live contacts | 4 (all with mobile and extension) |
| Duplicate extensions within a tenant | 0 |
| Duplicate mobiles within a tenant (digits / `+` / `00` normalised) | 0 |
| Same extension in more than one tenant | 0 |
| Conflicting ownership (extension of one contact, different mobile on another) | 0 |
| Group / ENS / ERS memberships of contacts sharing an identifier | 0 |
| Formatting variety | no spaces / brackets / `+` / leading `0` in stored values |

No remediation is needed on DEV. Customer databases were **not** examined; the same queries
(`scratchpad …/dup-audit.sql`, reproduced in the design document) must be run there before any uniqueness index.

## 4. Facts that constrain the design

- **Extensions are platform-wide endpoints.** Calls dial `user/<extension>` on one FreeSWITCH with no domain
  (`dialResolver.js`), so extension 1001 is the same phone for every tenant. Identity checks must nevertheless stay
  inside a tenant (security: no cross-tenant lookup or disclosure).
- **Contacts belong to organizations**; ENS / ERS configurations are tenant-wide and may combine groups of several
  organizations of the tenant.
- **No country context exists** (no tenant / organization country code), so `0501234567` and `+966501234567` cannot
  be proven equal.
- **A tenant column is absent on contacts**, so a tenant-wide unique index needs a schema change (new column +
  backfill); an organization-wide index does not.
- The import's duplicate rule (all four fields) was approved earlier (D-3 of the Excel task) and is now superseded by
  this requirement — a behaviour change to record.
