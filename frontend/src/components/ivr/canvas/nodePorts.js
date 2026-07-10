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
export function getPortsForNode(node, portsStrategy) {
  switch (portsStrategy) {
    case 'next':
      return [{ key: 'next', label: 'next' }];
    case 'next_optional':
      return node.next ? [{ key: 'next', label: 'next' }] : [];
    case 'branches': {
      const branches = node.branches || {};
      return Object.keys(branches).map(k => ({ key: k, label: k }));
    }
    case 'goto_target':
      return [{ key: 'goto', label: 'target' }];
    case 'true_false':
      return [
        { key: 'true',  label: 'true'  },
        { key: 'false', label: 'false' },
      ];
    case 'none':
    default:
      return [];
  }
}

/** Just the keys — the shape FlowCanvas.jsx's positioning math wants. */
export function getPortKeysForNode(node, portsStrategy) {
  return getPortsForNode(node, portsStrategy).map(p => p.key);
}
