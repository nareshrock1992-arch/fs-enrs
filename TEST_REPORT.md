# TEST REPORT — fs-enrs Phases 1–9

**Date:** 2026-07-10
**Standard applied:** "actually works when someone follows the steps," not
"looks done." In that spirit, this report is explicit about the one thing
that matters most when reading it:

> ⚠️ **The environment this work was produced in has no Node.js, no Lua
> compiler, no xmllint, and no FreeSWITCH.** Every phase below is
> code-complete with tests *written*, but **no test in this repo has been
> executed by the author of these changes.** Each phase's gate lists the
> exact command that turns its status from CODE-COMPLETE into PASSED.
> Run them in order; stop at the first failure.

**Legend:** ✅ verified by execution · 🟡 code-complete + tests written, execution pending · ⬜ requires your hardware, cannot be pre-verified by anyone else

---

## How to run everything (one block)

```bash
# On a machine with Node 20+, PostgreSQL, lua5.2, libxml2-utils:
cd backend  && npm install && cd ../frontend && npm install && cd ..

# DB for integration tests (uses DB_* env vars; see backend/src/config/index.js)
cd backend && npm run migrate

# The full Phase 1–6 gate in one command:
npm run verify:all        # = verify:lua + verify:xml + verify:contracts + npm test
cd ../frontend && npm test && npm run lint
cd ../backend && npm run lint
```

CI (`.github/workflows/verify.yml`) runs this same sequence with a real
Postgres service container on every push.

---

## Phase 1 — Stabilize (13 items) — 🟡

| # | Item | Status | Evidence / test |
|---|------|--------|-----------------|
| 1 | `["goto"]` quoted dispatch key | 🟡 fixed | `luaGenerator.test.js` — fails on bare `goto` |
| 2 | Lookup reads top-level `entry_node_id`/`nodes` | 🟡 fixed | `luaGenerator.test.js` — fails on any `data.graph` |
| 3 | exec_ers → `/ers/incidents`, correct fields, client-side room, reads only `incident_uuid` | 🟡 fixed | `luaGenerator.test.js` + contract checker |
| 4 | exec_ens → `/ens/notifications`, `configuration_id`, `triggered_via` | 🟡 fixed | `luaGenerator.test.js` + contract checker |
| 5 | Conditional XML wrapper via `detectDialplanTargetDir() → {dir, nested}` | 🟡 fixed | `xmlGenerator.test.js` (both layouts) + `xml-structural-check.js` (adds xmllint) |
| 6 | ERS/ENS `createConfiguration` sets tenant_id; backfill migrations 011–013 | 🟡 fixed | `phase1-regression.test.js` (checks the actual DB row) |
| 7 | ServiceRegistry IVR Flow dropdown | 🟡 confirmed | `frontend/src/__tests__/regression.test.js` |
| 8 | BindNumbersModal hint text | 🟡 confirmed | same file |
| 9 | ivrLookup filters `published_at IS NOT NULL` | 🟡 present | `phase1-regression.test.js` — traced: not an active bug (publishFlow always sets published_at; drafts never touch ivr_flow_versions), filter added as defense-in-depth |
| 10 | verify_extension_loaded: 4-arg `xml_locate` + 3×500ms retry | 🟡 fixed | `eslService.test.js` (injectable locateFn proves retry behavior) |
| 11 | Dead `ens_contacts` table | 🟡 fixed | Test seed now uses `emergency_contacts`/`responder_groups` (the tables `resolveEnsContacts()` actually reads — the old seed exercised nothing real); both DDL definitions reconciled + marked DEPRECATED. Not dropped — that's a deliberate separate migration decision. |
| 12 | ENS operator flow publish 400 | 🟡 fixed — **root cause was NOT tenant_id** (ruled out: ensController already correct). It was a second cycle-detection false positive: a single-ref retry node ("bad PIN → try again") whose escape route exists one level up was flagged as a dead loop. Replaced back-edge detection with reachability-to-terminal analysis. | `ivrGraphValidator.test.js` (retry chain passes; true no-exit loop still errors) + updated `ivr.test.js`/`ivr_new_nodes.test.js` |
| 13 | Orphaned Active conferences | 🟡 fixed | exec_ers now calls the existing `/complete` endpoint after the blocking conference returns (reusing `completeIncidentCore`, idempotent); ESL conference-destroy listener reconciles crash orphans; `cleanup_orphaned_ers_incidents.js` (dry-run/`--apply`) for pre-existing rows | `phase1-regression.test.js` (idempotency) + `luaGenerator.test.js` (ordering) |

**Phase 1 gate:** `cd backend && npm test` — plus item 13's manual check:
place one real call, confirm Live Monitoring's Active count decrements.
The "fail when reverted" property was designed into each test (they assert
the exact fixed content/behavior) but **has not been demonstrated by
actually reverting**, since tests can't run here.

## Phase 2 — Validation tooling — 🟡

- `backend/scripts/lua-syntax-check.js` — every generator output through
  `luac5.2 -p` (6 fixtures incl. quote/unicode edge cases). Fails loudly
  if no Lua compiler on PATH (never silently skips).
- `backend/scripts/xml-structural-check.js` — xmllint well-formedness AND
  the nested-vs-flat structural rule xmllint alone can't catch.
- `scripts/verify-api-contracts.js` — statically extracts every API call
  from the generated Lua; cross-checks route registration, request body
  fields vs the real Zod schemas (now exported for introspection), and
  response fields Lua reads vs what controllers actually return; plus
  frontend client.js path prefixes vs v1 mounts.
- eslint flat configs (backend + frontend), correctness rules only.
- All wired into `.github/workflows/verify.yml` (lua5.2 + libxml2-utils +
  Postgres service installed in CI).

**Bonus: the tooling already earned its keep before ever running** —
hand-tracing the contract checker's rules against the generated Lua found
two real, previously unknown bugs: `ens_pin_valid` sent the PIN as a query
param `/ens/lookup` never reads (PIN silently never checked), and
`ens_callback_valid` called a nonexistent `/ens/callback_lookup` path with
a missing required param and read a nonexistent response field. Both fixed
+ regression-tested.

**Phase 2 gate:** `npm run verify:lua && npm run verify:xml && npm run
verify:contracts` — then the revert drill: reintroduce bare `goto` and
`/ers/start` one at a time and confirm the respective checker catches each.

## Phase 3 — Node-type registry — 🟡

- `backend/src/nodeTypes/registry.js`: single source of truth (visuals,
  configSchema, Lua handler, port strategy, apiEndpoint) for all 11
  original types — pure refactor, handler bodies byte-identical.
- luaGenerator iterates the registry (handler count asserted == registry
  length, not a hardcoded list).
- `GET /api/v1/ivr/node-types` + `useNodeTypes()` hook; NodePalette,
  PropertyPanel (one GenericField renderer — the form structurally cannot
  have the "state key with no rendered field" bug class), FlowNode, and
  FlowCanvas all registry-driven. Found + fixed a real duplication: two
  independently maintained copies of the port-key switch (one had a
  comment literally saying "must match" the other) → one shared
  `nodePorts.js`.
- Boot self-check warns if any registry apiEndpoint isn't a real route.
- Proof: `webhook` type added purely as a registry entry (+1 Zod schema,
  the one documented exception). `docs/EXTENDING_NODE_TYPES.md` is the
  walkthrough. Known gap documented there: `NODE_DEFAULTS` (first-drop
  field values) not yet registry-sourced — UX rough edge, not a
  correctness bug.

**Phase 3 gate:** full suite green (refactor changed no behavior) —
`nodeTypeRegistry.test.js`, `nodeTypeSelfCheck.test.js`.

## Phase 4 — Gateway-agnostic dialing — 🟡

- `resolveDialString()` (dialResolver.js): the ONE dial-string constructor.
  Order: explicit override → per-contact `gateway_id` → tenant default →
  `sofia/internal/<ext>@<domain>`. Zero config = internal, automatically.
- Found + fixed a real violation while wiring: campaignEngine assumed a
  gateway literally named `'default'` exists (broke every zero-gateway
  install). Also fixed `config.esl.domain` being referenced but never
  defined.
- Migration 015 (`sip_gateways` + `emergency_contacts.gateway_id`),
  Telephony Gateways admin UI, deploy via the same generate→write→
  reloadxml→verify pipeline (verifies with `sofia status gateway`, not
  just +OK). `docs/CONNECTING_A_PBX.md` = the config-only upgrade path.

**Phase 4 gate:** `dialResolver.test.js` is the gate verbatim (zero-gateway
default; loopback gateway switches exactly the right contacts; per-contact
override leaves siblings untouched; legacy raw gateway names still work).

## Phase 5 — 3-scenario ERS + Blast + Playback — 🟡

- Migration 016: `tier_group_id`, `ers_incident_participants`
  (join/leave/rejoin per person), queue caller fields,
  `ers_playback_lines` (24h window), `pin_verified_at`/`recorded_by`,
  `ring_timeout_seconds`.
- `ersRingService.js`: parallel bgapi originates into one room, re-ring
  waves until any leg answers, recording on first join, initiator
  identity on every leg, per-room dedup, 2h runaway cap.
- Endpoints: `tier-status` (live count), `ring-all` (fresh vs rejoin
  path), `overflow/enqueue` + `overflow/poll` (head-of-queue promotion,
  L1 priority, FOR UPDATE double-promotion guard), `playback/authorize`
  (audit-logged), external `POST /ers/broadcast-users`
  (docs/API_REFERENCE.md), reports `ers-incidents` + `ens-broadcasts`.
- `resolveEnsContacts()` extended: **was mobile-only — desk extensions
  were silently never blasted.** Now both channels per contact, as
  independent delivery legs.
- 5 node types purely via the registry (zero generator/palette edits —
  the Phase 3 architecture held). Participant rows driven by
  mod_conference's own events. Occupancy ALWAYS by live member count —
  `tierStatus.test.js` pins C1's spec-verbatim case: COMPLETED row + 3
  live members ⇒ occupied; ACTIVE row + empty room ⇒ free.
- Writing the Phase 6 test exposed one more real gap, fixed: validateGraph
  FK-checked config IDs only on `ens`/`ers` node types — now collected by
  field name, covering all Phase 5 + future types automatically.

**Phase 5 gate:** `npm run verify:all` (the new handlers flow through the
same luac/xmllint/contract gates automatically).

## Phase 6 — Simulated deploy pipeline — 🟡

`deployPipeline.test.js`: real test DB + mocked ESL boundary. Success path
(all steps ok for a published flow using every Phase 5 node type; written
Lua contains every handler + quoted goto; written XML structurally correct
for the detected layout) and every required failure path, each reproducing
its original session failure message: unpublished flow → "No published
version found"; unresolved binding → "not found or wrong tenant";
reloadxml-+OK-but-not-loaded → "FreeSWITCH did not load the extension";
dangling graph ref → "references non-existent node".

**Phase 6 gate:** `npm test` — then the drill: flip
`eslState.xmlLocateContains` handling or feed the draft flow and confirm
the assertions catch it.

## Phase 7 — Local FreeSWITCH smoke test — ⬜ YOUR HARDWARE

`scripts/local-freeswitch-smoke-test.sh <flow_uuid> <number> [log]` —
diagnostics → deploy (honest banner) → independent xml_locate re-check →
ESL loopback originate → grep `[ivr_executor] step=` markers → stale-
incident check. Ends with an unambiguous ✅/numbered-fix-list summary.
**Cannot be pre-verified from here. Run it on the Debian 12 box.**

## Phase 8 — Full acceptance (real calls) — ⬜ YOUR HARDWARE

All 10 scenarios require real phones. The code paths behind each:
1/2 concurrent L1+L2 → `ers_overflow_check`+`ers_ring_all`; 3 queue+
auto-connect → `ers_overflow_wait`+`overflow/poll`; 4 rejoin → ring-all's
live-occupancy branch; 5 caller ID → `lookupCallerIdentity` per leg;
6 blast both channels → `ens_blast_record`+extended resolveEnsContacts;
7 playback 24h/authorized → `ens_playback_gate`+`playback/authorize`;
8 reports → the two new pages; 9 gateway swap → Telephony Gateways UI +
`dialResolver.test.js`'s automated twin; 10 Active-count decrement →
Phase 1 item 13's completion call + destroy-event reconciliation.

## Phase 9 — this report.

---

## Deployment Readiness verdict

**NOT yet deployable to production. Code-complete, execution-unverified.**
The honest chain: run `npm run verify:all` (Phases 1–6 gates) → fix
anything it catches → run the Phase 7 smoke test on the real box → walk
the 10 Phase 8 scenarios with real phones. Only after all three is the
verdict "ready."

## Fresh deployment, step by step (non-technical)

1. Follow **docs/ENVIRONMENT_SETUP.md** end to end (env vars, diagnostics
   with the Dialplan Include Chain check, conflict scan, first number →
   publish → bind → deploy → test call).
2. `cd backend && npm install && npm run migrate && npm run seed` — then
   `pm2 start ecosystem.config.cjs`; `cd frontend && npm install && npm
   run build`.
3. Log in (`admin@enrs.local` / `Admin@12345` — change it), open
   **Deployment → Diagnostics**, resolve anything red.
4. Build the emergency config in this order: Organization → Contacts
   (extensions AND mobiles) → Responder Groups → ERS Configuration (assign
   tier groups, set Ring-All Timeout) → ENS Configuration (PIN, contacts)
   → Service Registry numbers (1222/YYYY/UUUU equivalents) → IVR flows
   using the Emergency palette nodes → Publish → Bind → Deploy.
5. Run `scripts/local-freeswitch-smoke-test.sh` once. Green = proceed to
   real test calls per Phase 8's list.
6. Connecting the real Avaya/Cisco trunk later: **docs/CONNECTING_A_PBX.md**
   (config only). Adding node types later: **docs/EXTENDING_NODE_TYPES.md**.
