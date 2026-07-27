# BUG_TRACKER.md — FS-ENRS Dialplan Editor

All bugs affecting the Dialplan Editor. Each entry documents the root cause, the
fix applied, and the regression test that prevents reintroduction.

Status values: **Open** | **Fixed** | **Deferred** (no UI trigger yet)

---

## DP-001 — `update_extension` silent no-op

| Field | Value |
|---|---|
| Module | `DialplanParser._applyOne` |
| Severity | **Critical** |
| Status | **Fixed** |
| Regression test | `dialplanParser.applyChanges.test.js` → `update_extension` suite |

**Symptom:** Renaming an extension or toggling its enabled/continue state reports
deployment success, but the XML on disk is unchanged.

**Root cause:** `_applyOne` for `update_extension` read `ch.patch ?? {}`. The frontend
(Gen2 protocol) never sends a `patch` object — it sends `name`, `continue`, `enabled`
as top-level fields on the op. `ch.patch` is always `undefined`, which evaluates to
`{}`, producing a silent no-op spread over the node.

**Fix:** `DialplanParser.js` — replaced `{ ...n, ...(ch.patch ?? {}) }` with
`{ ...n, ..._pickDefined(ch, ['name', 'continue', 'enabled', 'attrs']) }`.

**Files changed:**
- `backend/platform/configuration/parsers/DialplanParser.js`
- `backend/src/__tests__/unit/dialplanFileProvider.test.js` (stale test updated)
- `backend/src/__tests__/unit/dialplanParser.applyChanges.test.js` (new regression suite)

---

## DP-002 — `update_condition` silent no-op

| Field | Value |
|---|---|
| Module | `DialplanParser._applyOne` |
| Severity | **Critical** |
| Status | **Fixed** |
| Regression test | `dialplanParser.applyChanges.test.js` → `update_condition` suite |

**Symptom:** Editing a condition's field, expression, break, or enabled state reports
deployment success, but the XML on disk is unchanged.

**Root cause:** Same Gen1/Gen2 mismatch as DP-001. `_applyOne` for `update_condition`
read `ch.patch ?? {}`. Frontend sends `field`, `expression`, `break`, `enabled` as
top-level op fields. The patch was always empty.

**Fix:** `DialplanParser.js` — replaced `ch.patch ?? {}` with
`_pickDefined(ch, ['field', 'expression', 'expressionCdata', 'expressionIsChild', 'break', 'enabled', 'attrs'])`.

**Files changed:**
- `backend/platform/configuration/parsers/DialplanParser.js`
- `backend/src/__tests__/unit/dialplanParser.applyChanges.test.js`

---

## DP-003 — `add_extension` creates a nameless extension

| Field | Value |
|---|---|
| Module | `DialplanParser._applyOne` |
| Severity | **Critical** |
| Status | **Fixed** |
| Regression test | `dialplanParser.applyChanges.test.js` → `add_extension` suite |

**Symptom:** Adding a new extension creates an extension with no name (empty string
or `undefined`). The extension appears unnamed in the UI and serializes with
`name=""` in the XML, which FreeSWITCH treats as an unreachable extension.

**Root cause:** `_applyOne` for `add_extension` spread `ch.extension` (Gen1 nested
format). Frontend sends `name` and `_tempId` as top-level fields. `ch.extension` is
`undefined`. Spreading `undefined` in JS is valid and produces no fields.

**Fix:** `DialplanParser.js` — rewrote `add_extension` to read top-level fields:
`name`, `_tempId` (used as the ephemeral node ID), `continue`, `attrs`, `enabled`,
`conditions`.

**Files changed:**
- `backend/platform/configuration/parsers/DialplanParser.js`
- `backend/src/__tests__/unit/dialplanFileProvider.test.js` (two stale tests updated)
- `backend/src/__tests__/unit/dialplanParser.applyChanges.test.js`

---

## DP-004 — `update_context` used wrong field name in test

| Field | Value |
|---|---|
| Module | `DialplanParser._applyOne` + test |
| Severity | **High** |
| Status | **Fixed** |
| Regression test | `dialplanParser.applyChanges.test.js` → `update_context` suite |

**Symptom:** The `update_context` test sent `{ op: 'update_context', name: 'sales' }`
and expected `contextName === 'sales'`. Because the doc field is `contextName` (not
`name`) and `_applyOne` spread `ch.patch`, neither the test nor the handler worked.

**Root cause:** Same Gen1 pattern (`ch.patch`). Additionally, the op field was `name`
while the doc field is `contextName`. The test was therefore wrong in two ways.

**Fix:** `DialplanParser.js` — `update_context` now uses
`_pickDefined(ch, ['contextName', 'contextAttrs'])`.
Test updated to send `{ contextName: 'sales' }` (the correct field).

**Files changed:**
- `backend/platform/configuration/parsers/DialplanParser.js`
- `backend/src/__tests__/unit/dialplanFileProvider.test.js`
- `backend/src/__tests__/unit/dialplanParser.applyChanges.test.js`

---

## DP-005 — Production debug logging with `console.trace()` on every op

| Field | Value |
|---|---|
| Module | `configChangesStore.js`, `useDeployment.js` |
| Severity | **High** |
| Status | **Fixed** |
| Regression test | Code review only (no automated check for console calls) |

**Symptom:** Every keystroke in the dialplan editor (every op dispatch) triggers
`console.group`, `console.log`, and `console.trace()`. `console.trace()` captures a
full JavaScript stack trace on every call — O(n) per user interaction. On a session
with 100 edits this generates 100 stack captures in the browser DevTools console.

**Root cause:** Debug instrumentation added during development and marked
"remove before production" was never removed.

**Fix:** Removed all `console.group` / `console.log` / `console.trace` calls from
`appendOp` in `configChangesStore.js` and from `fetchPreview` / `deploy` in
`useDeployment.js`.

**Files changed:**
- `frontend/src/platform/config/stores/configChangesStore.js`
- `frontend/src/platform/config/hooks/useDeployment.js`

---

## DP-006 — `changedKeys` always empty in version history for dialplan deploys

| Field | Value |
|---|---|
| Module | `DeploymentManager.js` |
| Severity | **Medium** |
| Status | **Fixed** |
| Regression test | None (DB output verification required) |

**Symptom:** Version history records for dialplan deploys show no changed keys,
making it impossible to tell at a glance what was changed in a given version.

**Root cause:** `DeploymentManager.js:201` extracted `changedKeys` as
`changes.map(c => c.key).filter(Boolean)`. Flat provider ops carry a `.key` field
(e.g. `{ key: 'default_gateway', value: '...' }`). Hierarchical dialplan ops have
no `.key` field — they have `op` (e.g. `'update_extension'`). The result was always
an empty array.

**Fix:** `DeploymentManager.js` — `changes.map(c => c.key ?? c.op).filter(Boolean)`.
Flat ops continue to use `.key`; hierarchical ops fall back to `.op` as a meaningful
summary of what changed.

**Files changed:**
- `backend/platform/configuration/deploy/DeploymentManager.js`

---

## DP-007 — `move_extension`: frontend/backend semantic mismatch

| Field | Value |
|---|---|
| Module | `DialplanParser._applyOne`, `applyHierarchicalOps.js` |
| Severity | **High** |
| Status | **Deferred** — no drag-and-drop UI exists yet |
| Regression test | `dialplanParser.applyChanges.test.js` → `move_extension` suite (backend only) |

**Symptom:** When drag-and-drop reordering is implemented, moves will work
client-side but fail silently on deploy.

**Root cause:** `applyHierarchicalOps.js` (client-side) uses `op.position` (0-indexed
integer). `DialplanParser._applyOne` (backend) uses `ch.beforeId` (string node ID
reference). The protocol is different on the two sides. Since no UI emits
`move_extension` ops yet, this is latent.

**Recommended fix (before implementing drag-and-drop):** Standardise on one approach.
The backend `beforeId` model is more robust (position integers become stale when
multiple concurrent ops reorder nodes). Update `applyHierarchicalOps.js` to also use
`beforeId`. Update any future drag handler to emit `beforeId`.

**Files changed:** None yet.

---

## DP-008 — `add_condition` uses Gen1 nested format (`ch.condition`)

| Field | Value |
|---|---|
| Module | `DialplanParser._applyOne` |
| Severity | **High** |
| Status | **Fixed** |
| Regression test | `dialplanParser.applyChanges.test.js` → `add_condition` suite |

**Symptom:** When an Add Condition button is implemented and dispatches
`{ op: 'add_condition', extensionId, field, expression }` (Gen2), the backend
`_applyOne` was reading `ch.condition` (Gen1 nested), finding `undefined`, and
creating a condition with no field, expression, or stable ID.

**Root cause:** Same Gen1/Gen2 split as DP-001 through DP-003. `add_condition`
read `ch.condition` (a nested object) rather than top-level `field`, `expression`,
`break`, `enabled`.

**Fix:** Rewrote `add_condition` to read top-level `field`, `expression`,
`expressionCdata`, `expressionIsChild`, `break`, `enabled`, `attrs`, `_tempId`,
`actions`, `antiActions` — matching the Gen2 protocol used by all other fixed ops.

**Files changed:**
- `backend/platform/configuration/parsers/DialplanParser.js`
- `backend/src/__tests__/unit/dialplanParser.applyChanges.test.js`

---

## DP-009 — `_withAction` dead code branch

| Field | Value |
|---|---|
| Module | `DialplanParser._withAction` |
| Severity | **Low** |
| Status | **Fixed** |
| Regression test | None required (dead code removal) |

**Symptom:** `_withAction` contained a branch `if (ch.op === 'add_action') { id: nextId(), ...ch.action }`.
`add_action` was refactored to use `_walkCondition` in a prior session, making this
branch permanently unreachable. `ch.action` (Gen1 nested) would also be undefined
for any current frontend emission.

**Fix:** Removed the dead `add_action` branch from `_withAction`. The function now
only handles the `transform` callback path, which is the only live caller (`move_action`).

**Files changed:**
- `backend/platform/configuration/parsers/DialplanParser.js`

---

## DP-011 — ESL `reloadxml` timeout too low; deploys fail on every production reload

| Field | Value |
|---|---|
| Module | `eslService.js`, `FreeSwitchDriver.js` |
| Severity | **Critical** |
| Status | **Fixed** |
| Regression test | None (requires live FreeSWITCH; covered by integration smoke test) |

**Symptom:** Every dialplan deploy fails at the "Reload XML" step with
`ESL bgapi timeout after 10000ms: reloadxml`. The deployment manager catches the
error, auto-restores from backup, and returns a failure. The file that was written
is rolled back. The UI shows a deploy failure (not a false success).

**Root cause:** `eslCommand` was hardcoded to 10 000 ms. The module comment
stated "callers that need a different timeout use `eslCommandTimeout` directly,"
but `eslCommandTimeout` was not exported — the comment was self-contradicting.
`reloadxml` on a production FreeSWITCH instance with a large config tree
(many dialplan files, large sofia configuration) regularly takes 10–15 seconds.
Any run exceeding 10 s guaranteed failure.

**Fix:**
1. `eslService.js` — `eslCommand(cmd, timeoutMs = 10_000)` now accepts an optional
   timeout parameter. All existing callers are unaffected (default unchanged).
2. `FreeSwitchDriver.reloadXml()` — passes `20_000` ms (20 seconds) to
   `eslCommand`. This matches the observed production duration with a 2× safety
   margin. Deployments that genuinely time out (FreeSWITCH unresponsive or
   severely overloaded) will still fail correctly after 20 s.

**Files changed:**
- `backend/src/services/eslService.js`
- `backend/platform/drivers/FreeSwitchDriver.js`

---

## DP-010 — Stale ops survive route navigation (no navigation guard)

| Field | Value |
|---|---|
| Module | `configChangesStore.js`, routing |
| Severity | **Medium** |
| Status | **Open** |
| Regression test | None |

**Symptom:** If an admin edits a dialplan, navigates away without deploying, then
returns, the previously accumulated ops are still in the store and will be deployed
on the next deploy action — even if the admin intended to discard them.

**Root cause:** `clearProvider(providerId)` is only called on successful deploy,
explicit discard, or provider reload. It is not called when the React route changes
away from the editor.

**Recommended fix:** Add a `useEffect` cleanup in the hierarchical provider page that
calls `clearProvider(providerId)` on unmount, or add a route-level confirmation
dialog ("You have unsaved changes — discard?").

**Files changed:** None yet.
