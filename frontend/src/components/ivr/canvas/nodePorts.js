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

/**
 * The ordered branch keys a Gather editor/canvas should SHOW for this node —
 * mode-aware (legacy vs configurable), retry-aware, and compatibility-safe:
 *
 *  • Configurable (max_attempts set): digit keys, reason keys (shown when their
 *    retry is OFF, or already wired), max_attempts_exceeded, _default (if present),
 *    and legacy timeout/invalid ONLY if already wired (preserve active fallbacks;
 *    never offered new). Unwired legacy keys are hidden → no legacy/config mix.
 *  • Legacy (max_attempts unset): digit keys, timeout, invalid, _default (if present),
 *    plus any config-model key that is already wired (preserve; never offered new).
 *
 * Pure: never mutates node.branches. Hidden keys keep their saved targets in JSON.
 */
export function gatherBranchKeysFor(node) {
  const branches = node?.branches || {};
  const wired = k => branches[k] !== undefined && branches[k] !== '';
  const existing = Object.keys(branches);
  const reason = GATHER_INTERNAL_EVENTS.map(e => e.key);
  const reserved = new Set([...reason, ...GATHER_LEGACY_KEYS, '_default', 'max_attempts_exceeded']);
  const digits = existing.filter(k => !reserved.has(k));
  const out = [...digits];
  // EXTERNAL mode — one attempt; failures are explicit graph exits. Show the
  // success (digits/_default) plus timeout + invalid. No max_attempts_exceeded,
  // no internal reason ports. Any already-wired reason/max key is preserved.
  if (node?.retry_mode === 'external') {
    out.push('timeout');
    out.push('invalid');
    for (const k of [...GATHER_INTERNAL_EVENTS.map(e => e.key), 'max_attempts_exceeded']) {
      if (wired(k)) out.push(k);
    }
    out.push('_default');   // Continue — always a connectable success output
    return out;
  }
  // INTERNAL mode (explicit) or legacy configurable (max_attempts present).
  if (node?.retry_mode === 'internal' || gatherIsConfigurable(node)) {
    // Reason keys are governed SOLELY by their retry toggle: retry ON → hidden
    // (target, if any, is preserved in JSON and reappears when retry is set to No);
    // retry OFF → shown as an optional graph exit.
    for (const ev of GATHER_INTERNAL_EVENTS) {
      if (!gatherRetryEnabled(node, ev)) out.push(ev.key);
    }
    out.push('max_attempts_exceeded');
    // Legacy timeout/invalid have no toggle, so the only way to keep an ACTIVE
    // fallback visible/editable is show-if-wired. Unwired ones stay hidden → no
    // legacy/config key mixing on a clean node.
    for (const k of GATHER_LEGACY_KEYS) if (wired(k)) out.push(k);
  } else {
    for (const k of GATHER_LEGACY_KEYS) out.push(k);                 // legacy mode: timeout + invalid
    if (wired('max_attempts_exceeded')) out.push('max_attempts_exceeded');
    for (const ev of GATHER_INTERNAL_EVENTS) if (wired(ev.key)) out.push(ev.key); // preserve stray wired config keys
  }
  // Continue / _default is ALWAYS a connectable success output (menu catch-all or
  // completed multi-digit collection). It is pushed even when unwired so the port
  // can be connected; an unwired _default is still pruned by serialiseGraph, so no
  // empty branch is persisted. Runtime success routing (br[d] or br["_default"])
  // is unchanged.
  out.push('_default');
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
