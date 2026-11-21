/**
 * Shared port-resolution logic — the single place that decides what
 * output connection dots a node has, used by BOTH FlowNode.jsx (drawing
 * the dots) and FlowCanvas.jsx (computing drag/edge positions and
 * connection targets). Before Phase 3 these were two independently
 * hand-maintained copies of the same switch statement (FlowCanvas.jsx's
 * getNodePortKeys had a comment literally saying "must match getPorts in
 * FlowNode.jsx") — exactly the kind of duplication that drifts silently.
 *
 * `portsStrategy` comes from the node-type registry's `ports` field
 * (GET /api/v1/ivr/node-types) — see backend/src/nodeTypes/registry.js's
 * header comment for the full strategy list and why it's a small closed
 * set rather than fully free-form per-node-type port specs.
 */
const DTMF_KEY = /^[0-9#*]+$/;

/**
 * Gather internal retry events. Each is handled INSIDE exec_gather when its
 * retry is enabled (so it is NOT a graph output), and becomes an optional graph
 * exit only when its retry is explicitly disabled. Retry defaults mirror the Lua
 * executor (registry.js): no_input=on, invalid_length=on, invalid_option=off.
 * Legacy keys `timeout`/`invalid` are NOT in this set — they always render when
 * present in saved data.
 */
export const GATHER_INTERNAL_EVENTS = [
  { key: 'no_input',       retryField: 'retry_on_no_input',       retryDefault: true  },
  { key: 'invalid_length', retryField: 'retry_on_invalid_length', retryDefault: true  },
  { key: 'invalid_option', retryField: 'retry_on_invalid_option', retryDefault: false },
];

/** Whether a gather internal event's retry is enabled (nil-safe, boolean or 'yes'/'no'). */
export function gatherRetryEnabled(node, ev) {
  const v = node?.[ev.retryField];
  if (v === undefined || v === null || v === '') return ev.retryDefault;
  return v === true || v === 'yes';
}

/** Legacy gather fallback keys (pre-configurable model). Still consulted by
 *  exec_gather as last-resort fallbacks, but not part of the configurable model. */
export const GATHER_LEGACY_KEYS = ['timeout', 'invalid'];

/** True when this gather node uses the configurable-retry model (max_attempts set). */
export function gatherIsConfigurable(node) {
  const v = node?.max_attempts;
  return v !== undefined && v !== null && v !== '';
}

const GATHER_RESERVED_KEYS = new Set([
  ...GATHER_INTERNAL_EVENTS.map(e => e.key), ...GATHER_LEGACY_KEYS, '_default', 'max_attempts_exceeded',
]);

/**
 * True when a gather node collects a number (a PIN, an account number) rather
 * than offering a key menu: it has no option keys and accepts more than one
 * digit. Its _default exit is then the success exit ("Entry complete").
 * Derived from stored fields only — there is no stored "collect type".
 */
export function gatherCollectsDigits(node) {
  const optionCount = Object.keys(node?.branches || {}).filter(isGatherOptionKey).length;
  return optionCount === 0 && Number(node?.max_digits) > 1;
}

/** Digits-mode route exits are stored as route_<id> (DTMF redesign D3). */
export const GATHER_ROUTE_PREFIX = 'route_';
export const isGatherRouteKey = k => typeof k === 'string' && k.startsWith(GATHER_ROUTE_PREFIX);
/** A menu option key: anything that is not a reserved outcome or a route exit. */
export const isGatherOptionKey = k => !GATHER_RESERVED_KEYS.has(k) && !isGatherRouteKey(k);
/** Exits that report a failure (drawn last and muted on the canvas). */
export const GATHER_FAILURE_KEYS = new Set([
  'no_input', 'invalid_option', 'invalid_length', 'timeout', 'invalid', 'max_attempts_exceeded',
]);

/**
 * The ordered branch keys a Gather editor/canvas should SHOW for this node —
 * mode-aware (legacy vs configurable), retry-aware, and compatibility-safe:
 *
 *  • Configurable (max_attempts set): digit keys, reason keys (shown when their
 *    retry is OFF, or already wired), max_attempts_exceeded, _default (see below),
 *    and legacy timeout/invalid ONLY if already wired (preserve active fallbacks;
 *    never offered new). Unwired legacy keys are hidden → no legacy/config mix.
 *  • Legacy (max_attempts unset): digit keys, timeout, invalid, _default (see below),
 *    plus any config-model key that is already wired (preserve; never offered new).
 *
 * Pure: never mutates node.branches. Hidden keys keep their saved targets in JSON.
 */
export function gatherBranchKeysFor(node) {
  const branches = node?.branches || {};
  const wired = k => branches[k] !== undefined && branches[k] !== '';
  const existing = Object.keys(branches);
  // ── Success exits first: options, routes, then the catch-all ──────────────
  const out = existing.filter(isGatherOptionKey);
  // Digits-mode routes, in rule order, then any wired route exit whose rule was
  // removed (kept visible so its connection can be cleared).
  const routeKeys = (Array.isArray(node?.routes) ? node.routes : [])
    .filter(r => r && r.id !== undefined && r.id !== '')
    .map(r => `${GATHER_ROUTE_PREFIX}${r.id}`);
  for (const k of [...routeKeys, ...existing.filter(isGatherRouteKey)]) if (!out.includes(k)) out.push(k);
  // _default ("Any valid entry" / "Any other key"). When the node collects a
  // number it is THE success exit, so it is always shown and connectable. In a
  // key menu it is an optional catch-all that bypasses wrong-key handling, so it
  // is shown once wired; the Menu panel offers it explicitly. Display only: an
  // unwired _default is pruned by serialiseGraph anyway, and runtime routing
  // (br[d] or br["_default"]) is unchanged.
  if (gatherCollectsDigits(node) || wired('_default')) out.push('_default');

  // ── Failure exits last: No input, Invalid, then Failed ─────────────────────
  const push = k => { if (!out.includes(k)) out.push(k); };
  // EXTERNAL mode — one attempt; failures are explicit graph exits
  // (timeout + invalid). Any already-wired reason/max key is preserved.
  if (node?.retry_mode === 'external') {
    push('timeout');
    push('invalid');
    for (const k of ['no_input', 'invalid_option', 'invalid_length', 'max_attempts_exceeded']) if (wired(k)) push(k);
    return out;
  }
  // INTERNAL mode (explicit) or legacy configurable (max_attempts present).
  if (node?.retry_mode === 'internal' || gatherIsConfigurable(node)) {
    // A reason key is shown when its retry is OFF (it exits at once), or — with
    // "separate exits" on — after the retries (no_input and invalid_option;
    // invalid_length only when already wired). Hidden keys keep their targets.
    const separate = node?.failure_exits === 'separate';
    const byKey = Object.fromEntries(GATHER_INTERNAL_EVENTS.map(e => [e.key, e]));
    for (const key of ['no_input', 'invalid_option', 'invalid_length']) {
      const off = !gatherRetryEnabled(node, byKey[key]);
      if (off || (separate && (key !== 'invalid_length' || wired(key)))) push(key);
    }
    // Legacy timeout/invalid have no toggle, so the only way to keep an ACTIVE
    // fallback visible/editable is show-if-wired.
    for (const k of GATHER_LEGACY_KEYS) if (wired(k)) push(k);
    push('max_attempts_exceeded');
  } else {
    for (const k of GATHER_LEGACY_KEYS) push(k);                       // classic: timeout + invalid
    for (const k of ['no_input', 'invalid_option', 'invalid_length']) if (wired(k)) push(k); // preserve stray wired keys
    if (wired('max_attempts_exceeded')) push('max_attempts_exceeded');
  }
  return out;
}

/**
 * Friendly DISPLAY label for a port/branch key. The underlying branch key is
 * never changed — this only affects what the canvas shows. Precedence:
 *   1. an explicit portLabels[key] from the node-type registry
 *   2. a DTMF digit/#/* key → "Press <key>" (gather menus)
 *   3. the raw key itself
 * Shared by getPortsForNode (port dots) and FlowCanvas (edge/wire labels) so
 * both stay in sync.
 */
export function labelFor(key, portLabels) {
  if (portLabels && portLabels[key]) return portLabels[key];
  if (key !== '_default' && DTMF_KEY.test(key)) return `Press ${key}`;
  return key;
}

export function getPortsForNode(node, portsStrategy, branchKeys, portLabels) {
  const lbl = k => labelFor(k, portLabels);
  switch (portsStrategy) {
    case 'next':
      return [{ key: 'next', label: (portLabels && portLabels.next) || 'next' }];
    case 'next_optional':
      return node.next ? [{ key: 'next', label: (portLabels && portLabels.next) || 'next' }] : [];
    case 'branches': {
      const existing = Object.keys(node.branches || {});
      // Node types that declare fixed outcome keys (e.g. rest_api:
      // success/http_error/timeout/invalid_response) always show those ports —
      // even before they are wired — so authors can connect them by name.
      // Free-form nodes (gather digit menus) declare none and keep the existing
      // data-driven behavior. Declared keys first, then any extra author keys.
      const declared = Array.isArray(branchKeys) ? branchKeys : [];
      // Gather is mode-aware (legacy vs configurable) + retry-aware and preserves
      // wired keys — see gatherBranchKeysFor. It never shows the legacy and
      // configurable key sets simultaneously (the source of the duplicate-key
      // confusion), while keeping any already-wired target visible so no active
      // fallback silently disappears. Non-gather branch nodes keep the plain
      // declared+existing union (e.g. rest_api's fixed outcomes).
      const keys = (node && node.type === 'gather')
        ? gatherBranchKeysFor(node)
        : [...declared, ...existing.filter(k => !declared.includes(k))];
      return keys.map(k => ({ key: k, label: lbl(k) }));
    }
    case 'goto_target':
      return [{ key: 'goto', label: (portLabels && portLabels.goto) || 'target' }];
    case 'true_false':
      return [
        { key: 'true',  label: (portLabels && portLabels.true)  || 'true'  },
        { key: 'false', label: (portLabels && portLabels.false) || 'false' },
      ];
    case 'none':
    default:
      return [];
  }
}

/** Just the keys — the shape FlowCanvas.jsx's positioning math wants. */
export function getPortKeysForNode(node, portsStrategy, branchKeys) {
  return getPortsForNode(node, portsStrategy, branchKeys).map(p => p.key);
}
