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
      const keys = [...declared, ...existing.filter(k => !declared.includes(k))];
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
