# Database & Code Audit Report

**Date:** 2026-07-10 · **Method:** static reference analysis (grep of all
SQL strings / imports / route mounts across `backend/src`, `frontend/src`,
`Lua-scripts/`, `docs/`). Nothing has been deleted — per the review
instructions, this is a report only. "Non-test refs" excludes
`__tests__/` and the DDL files themselves.

---

## 1. Database objects

### 🔴 Safe to remove (zero non-test code references)

| Object | Evidence | Notes |
|---|---|---|
| `ens_groups` | 0 refs | Dead subsystem — superseded by `responder_groups`. Already marked DEPRECATED in both DDL files. |
| `ens_group_members` | 0 refs | Same subsystem. |
| `ens_contacts` | 1 ref — **a code comment only** (`contactController.js:155`) | Same subsystem; superseded by `emergency_contacts`. Both DDL definitions were reconciled + deprecated earlier; the junction columns `ens_configuration_contacts.ens_contact_id` and `ens_configuration_groups.ens_group_id` are equally dead. |
| `notification_templates` | 0 refs | Never referenced by any controller/service. Abandoned early-design artifact. |
| `tenant_mappings` | 0 refs | Tenancy went direct (`organizations.tenant_id`); this junction was never used. |
| `migration_log` (table, if present on old DBs) | referenced only by `migrate.js`'s one-time backward-compat copy into `schema_migrations` | Droppable after confirming `schema_migrations` is populated. |

**Removal path when you choose to act:** one migration per table doing
`DROP TABLE IF EXISTS ... CASCADE` — after a `SELECT COUNT(*)` sanity
check on the production DB confirms no meaningful rows. Do NOT drop from
`schema.sql` alone (fresh installs would diverge from upgraded DBs again —
the exact drift disease behind three separate production bugs already).

### 🟡 Needs verification before touching

| Object | Evidence | Concern |
|---|---|---|
| `ers_responders`, `ers_responder_groups`, `ers_responder_group_members` | referenced by `contactController.js` (unified-contacts endpoint) and the **legacy fallback** branch in `ersInternalController.resolveResponders()` | Only reachable when a config still uses the old direct-FK columns (`primary_ers_group_id`). Check production data: if those columns are NULL everywhere, the fallback is dead and all three tables can be scheduled for removal. |
| `esl_connections` | 1 ref (heartbeat update in `eslService.js`) + seed | Real connection config comes from env vars; this table is effectively a status-display row. Keep, but it's config-theater — candidate for simplification later. |
| `feature_flags` | 1 ref (settings routes) | Used by the Settings UI toggle list; verify any flag actually gates behavior anywhere (grep found no consumer of flag *values* outside the CRUD itself). |
| Legacy columns on `ers_configurations`: `primary_group_id`, `secondary_group_id`, `primary_ers_group_id`, `secondary_ers_group_id`, `emergency_number`, `rejoin_number`, `open_access_number` | superseded by `ers_tier_groups`/`ers_tier_contacts` and `emergency_numbers` registry | Read only by legacy fallbacks. Verify NULL-ness in production, then plan column drops. |
| `ens_notifications.recording_reference` | defined in 001/017, written by nothing | Kept for 001-parity; candidate for removal in the same future cleanup. |

### 🟢 Currently used (keep)

`tenants, organizations, locations, departments, users, emergency_contacts,
responder_groups, responder_group_members, media_files, emergency_numbers,
ens_configurations, ens_configuration_contacts, ens_configuration_groups,
ens_notifications, ens_notification_deliveries, ens_campaigns,
ens_campaign_destinations, ers_configurations, ers_tier_groups,
ers_tier_contacts, ers_incidents, ers_incident_responders,
ers_incident_participants, ers_queues, ers_playback_lines, ivr_flows,
ivr_flow_versions, ivr_flow_deployments, ivr_templates, sip_gateways,
audit_logs, system_settings, schema_migrations, esl_connections` — all have
active controller/service references.

### Structural notes

- **Naming inconsistency (live, low-risk):** `ers_incident_responders`
  uses `ers_incident_id`; the new `ers_incident_participants` uses
  `incident_id`. Cosmetic; renaming now costs more than it saves.
- **Missing FK:** `ivr_flow_deployments.deployed_by → users(id)` exists;
  `audit_logs` has no FKs by design (audit rows must survive entity
  deletion) — correct as-is.
- **Nullable-but-shouldn't-be:** `emergency_numbers.tenant_id` and
  `organizations.tenant_id` are nullable and were the root of the
  invisible-rows bug class; backfills 012/013 fixed data, but a future
  migration should `SET NOT NULL` once production shows zero NULLs.

---

## 2. Backend dead code

| Item | Bucket | Evidence |
|---|---|---|
| `originateCall()` in `services/eslService.js` | 🔴 zero callers | Only `originateCampaignCall` is used (campaignEngine). Was refactored to be gateway-agnostic anyway; safe to delete or keep as the documented ad-hoc test helper. |
| `autoDetect()` in `config/fsConfig.js` | 🔴 zero callers | fs_cli-based path detection, superseded by the diagnostics `global_getvar` comparison. |
| Legacy fallback branches in `resolveResponders()` (`ersInternalController.js`) | 🟡 | Reachable only via legacy FK columns — same verification as the `ers_responders` tables above. |
| `stopRingAll()` in `services/ersRingService.js` | 🟡 exported, no caller yet | Deliberate API surface for a future "cancel ring" button; keep or wire up. |
| Everything else in controllers/services/routes | 🟢 | Every route file is mounted (`routes/v1/index.js`, `routes/internal/index.js`); every controller export is referenced by a route. |

## 3. Lua-scripts/ directory

The production IVR executor is **generated** by `luaGenerator.js` at
deploy time — the `Lua-scripts/` folder is the hand-written legacy/edge
pathway set. Referenced (deployed/expected by backend or setup docs):
`blast_call.lua`, `dial_911_conference.lua`, `ENS_retry_playback.lua`.

🔴 **Zero references anywhere** (safe to archive/remove from the repo):
`conf_meta_logger.lua`, `dbh_test.lua`, `dial_912_rejoin.lua`,
`dial_913_rejoin_secondary.lua`, `dial_ers_retry_group.lua`,
**`loader.lua`** ⚠️.

> **Security concern — `loader.lua`:** contains an obfuscated hard-coded
> password (`Abarkadabra@667_Ultra`) used to decrypt-and-execute encrypted
> Lua from `/tmp` via `os.execute(openssl ...)`. Nothing in the repo
> references it. Regardless of its history, a decrypt-and-eval loader with
> an embedded credential does not belong in a production emergency-response
> repo. **Recommend deleting it (and rotating anything that password
> protected) as a priority.**

🟡 Referenced only by docs (verify whether any customer box still deploys
them manually): `dial_ers_callback.lua`, `ers_retry_caller.lua`,
`ens_callback_handler.lua`, `ivr_flow_executor.lua` (predecessor of the
generated executor — keep as reference or delete).

## 4. Frontend

- Every page component in `frontend/src/pages/**` is routed in `App.jsx`
  (checked programmatically — zero unrouted pages).
- API-client method-level dead-code analysis was **not reliably automatable**
  by grep (namespace collisions produced false positives) — left unaudited
  rather than reporting noise.

## 5. Architectural concerns / production risks

1. **schema.sql vs migrations drift is the #1 recurring defect source**
   (caused: `organizations.address`, `triggered_by_user_id`, `ens_contacts`
   double-definition). Mitigated by making fresh installs actually run
   002+; the deeper fix is generating schema.sql from a migrated DB
   (`pg_dump --schema-only`) per release instead of maintaining it by hand.
2. **`loader.lua`** — see above; delete + rotate.
3. **Ring-all loop lives in backend process memory** (`ersRingService`) —
   a backend restart mid-ring stops re-ringing (the conference itself and
   already-ringing legs survive in FreeSWITCH). Acceptable now; a
   DB-backed ring-state table would make it restart-safe. Documented, not
   fixed — out of "minimal safe change" scope.
4. **`sip_gateways.password` stored plaintext** — same posture as
   `esl_connections.password` and FreeSWITCH's own XML, but worth an
   encryption-at-rest pass before multi-tenant production.
5. Test env verification pending: nothing in this repo has been executed
   in the authoring environment (no Node/luac/FreeSWITCH here) — run
   `npm run verify:all` + the Phase 7 smoke test before trusting any of it.
