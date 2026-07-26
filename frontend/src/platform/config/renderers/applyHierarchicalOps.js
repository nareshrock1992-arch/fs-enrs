/**
 * applyHierarchicalOps — pure client-side op application for hierarchical providers.
 *
 * Takes a DialplanNode[] (server state) and a ChangeOperation[] (active ops from
 * the configChangesStore ordered-ops slice) and returns a new DialplanNode[] that
 * reflects all ops applied in sequence.
 *
 * Used by HierarchicalRenderer to compute the display state (server state + pending
 * ops) without mutating the server state or making extra API calls.
 *
 * This mirrors the backend's DialplanParser.applyChanges() logic for client-side
 * preview. On deploy the backend applies the same ops authoritatively — this is
 * display-only.
 *
 * Rules:
 *  - Pure: no mutation, no I/O, no side effects.
 *  - Tolerant: unknown ops return nodes unchanged (never throw).
 *  - Temp IDs: _tempId is a client-only field used for new nodes; stripped before deploy.
 */

// ── Helpers ────────────────────────────────────────────────────────────────────

/** Copy only the listed keys that exist on src into a new object. */
function pickDefined(src, keys) {
  const result = {};
  for (const k of keys) {
    if (k in src && src[k] !== undefined) result[k] = src[k];
  }
  return result;
}

// ── Individual op handlers ──────────────────────────────────────────────────────

function applyUpdateExtension(nodes, op) {
  return nodes.map(n =>
    n.id === op.id && n.type === 'extension'
      ? { ...n, ...pickDefined(op, ['name', 'enabled', 'continue']) }
      : n
  );
}

function applyUpdateCondition(nodes, op) {
  return nodes.map(n => {
    if (n.id !== op.extensionId || n.type !== 'extension') return n;
    return {
      ...n,
      conditions: (n.conditions ?? []).map(c =>
        c.id === op.id
          ? { ...c, ...pickDefined(op, ['field', 'expression', 'break', 'enabled']) }
          : c
      ),
    };
  });
}

function applyUpdateAction(nodes, op) {
  return nodes.map(n => {
    if (n.id !== op.extensionId || n.type !== 'extension') return n;
    return {
      ...n,
      conditions: (n.conditions ?? []).map(c => {
        if (c.id !== op.conditionId) return c;
        return {
          ...c,
          actions: (c.actions ?? []).map(a =>
            a.id === op.id
              ? { ...a, ...pickDefined(op, ['application', 'data', 'enabled']) }
              : a
          ),
        };
      }),
    };
  });
}

function applyAddAction(nodes, op) {
  return nodes.map(n => {
    if (n.id !== op.extensionId || n.type !== 'extension') return n;
    return {
      ...n,
      conditions: (n.conditions ?? []).map(c => {
        if (c.id !== op.conditionId) return c;
        const newAction = {
          id: op._tempId ?? `temp_a_${Date.now()}`,
          application: op.application ?? '',
          data: op.data ?? '',
          enabled: true,
        };
        return { ...c, actions: [...(c.actions ?? []), newAction] };
      }),
    };
  });
}

function applyDeleteAction(nodes, op) {
  return nodes.map(n => {
    if (n.id !== op.extensionId || n.type !== 'extension') return n;
    return {
      ...n,
      conditions: (n.conditions ?? []).map(c => {
        if (c.id !== op.conditionId) return c;
        return { ...c, actions: (c.actions ?? []).filter(a => a.id !== op.id) };
      }),
    };
  });
}

function applyUpdateAntiAction(nodes, op) {
  return nodes.map(n => {
    if (n.id !== op.extensionId || n.type !== 'extension') return n;
    return {
      ...n,
      conditions: (n.conditions ?? []).map(c => {
        if (c.id !== op.conditionId) return c;
        return {
          ...c,
          antiActions: (c.antiActions ?? []).map(a =>
            a.id === op.id
              ? { ...a, ...pickDefined(op, ['application', 'data', 'enabled']) }
              : a
          ),
        };
      }),
    };
  });
}

function applyAddAntiAction(nodes, op) {
  return nodes.map(n => {
    if (n.id !== op.extensionId || n.type !== 'extension') return n;
    return {
      ...n,
      conditions: (n.conditions ?? []).map(c => {
        if (c.id !== op.conditionId) return c;
        const newAntiAction = {
          id: op._tempId ?? `temp_aa_${Date.now()}`,
          application: op.application ?? '',
          data: op.data ?? '',
          enabled: true,
        };
        return { ...c, antiActions: [...(c.antiActions ?? []), newAntiAction] };
      }),
    };
  });
}

function applyDeleteAntiAction(nodes, op) {
  return nodes.map(n => {
    if (n.id !== op.extensionId || n.type !== 'extension') return n;
    return {
      ...n,
      conditions: (n.conditions ?? []).map(c => {
        if (c.id !== op.conditionId) return c;
        return { ...c, antiActions: (c.antiActions ?? []).filter(a => a.id !== op.id) };
      }),
    };
  });
}

function applyAddExtension(nodes, op) {
  const newExt = {
    id:         op._tempId ?? `temp_ext_${Date.now()}`,
    type:       'extension',
    name:       op.name ?? 'new_extension',
    enabled:    true,
    conditions: [],
  };
  if (op.after) {
    const idx = nodes.findIndex(n => n.id === op.after);
    if (idx >= 0) {
      const result = [...nodes];
      result.splice(idx + 1, 0, newExt);
      return result;
    }
  }
  return [...nodes, newExt];
}

function applyDeleteExtension(nodes, op) {
  return nodes.filter(n => n.id !== op.id);
}

function applyMoveExtension(nodes, op) {
  // Move extension `op.id` to position `op.position` (0-indexed among all nodes).
  const idx = nodes.findIndex(n => n.id === op.id);
  if (idx < 0 || op.position === undefined) return nodes;
  const result = [...nodes];
  const [moved] = result.splice(idx, 1);
  const insertAt = Math.max(0, Math.min(op.position, result.length));
  result.splice(insertAt, 0, moved);
  return result;
}

// ── Dispatch table ──────────────────────────────────────────────────────────────

const HANDLERS = {
  update_extension:   applyUpdateExtension,
  update_condition:   applyUpdateCondition,
  update_action:      applyUpdateAction,
  add_action:         applyAddAction,
  delete_action:      applyDeleteAction,
  update_anti_action: applyUpdateAntiAction,
  add_anti_action:    applyAddAntiAction,
  delete_anti_action: applyDeleteAntiAction,
  add_extension:      applyAddExtension,
  delete_extension:   applyDeleteExtension,
  move_extension:     applyMoveExtension,
};

function applyOp(nodes, op) {
  const handler = HANDLERS[op.op];
  return handler ? handler(nodes, op) : nodes; // tolerant: unknown op = no-op
}

/**
 * Apply a list of change operations to a DialplanNode[] and return
 * a new node array with all ops applied in sequence.
 *
 * @param {DialplanNode[]} nodes — server-side nodes (not mutated)
 * @param {ChangeOperation[]} ops — active ops (pointer-bounded slice from store)
 * @returns {DialplanNode[]}
 */
export function applyOps(nodes, ops) {
  if (!nodes?.length && !ops?.length) return [];
  if (!ops?.length) return nodes;
  return ops.reduce((acc, op) => applyOp(acc, op), nodes ?? []);
}

// ── Op → change description (for DeployModal's ChangeSummary) ──────────────────

const OP_LABELS = {
  update_extension:   op => `Update extension "${op.name ?? op.id}"`,
  add_extension:      op => `Add extension "${op.name ?? 'new_extension'}"`,
  delete_extension:   op => `Delete extension "${op.id}"`,
  move_extension:     op => `Reorder extension "${op.id}"`,
  update_condition:   op => `Update condition in extension "${op.extensionId}"`,
  update_action:      op => `Update action "${op.application ?? op.id}"`,
  add_action:         op => `Add action "${op.application ?? ''}"`,
  delete_action:      op => `Delete action "${op.id}"`,
  update_anti_action: op => `Update anti-action "${op.application ?? op.id}"`,
  add_anti_action:    op => `Add anti-action "${op.application ?? ''}"`,
  delete_anti_action: op => `Delete anti-action "${op.id}"`,
};

/**
 * Convert a ChangeOperation to the changeDescription shape expected by
 * ChangeSummary / DeployModal.
 *
 * @param {ChangeOperation} op
 * @returns {{ key, label, from, to, restartRequired, riskLevel, sensitive }}
 */
export function describeOp(op, index) {
  const labelFn = OP_LABELS[op.op] ?? (o => `${o.op} (${o.id ?? ''})`);
  return {
    key:             `op_${index}`,
    label:           labelFn(op),
    from:            '(current)',
    to:              '(new)',
    restartRequired: false,
    riskLevel:       'low',
    sensitive:       false,
  };
}
