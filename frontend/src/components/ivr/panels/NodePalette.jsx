import { useNodeTypes } from '../../../hooks/useNodeTypes.js';

// Phase 3: node types are no longer hardcoded here — they come entirely
// from GET /api/v1/ivr/node-types (backend/src/nodeTypes/registry.js).
// Adding a node type to the registry makes it appear here automatically,
// grouped by its `category` field, with zero edits to this file — see
// docs/EXTENDING_NODE_TYPES.md for the full walkthrough (uses exactly
// this file as the "zero-edit" proof).

// Display order for known categories — new categories from future node
// types (e.g. a "Integrations" group for webhook) sort after these.
const CATEGORY_ORDER = ['Audio', 'Input', 'Recording', 'Emergency', 'Flow'];

export default function NodePalette({ onAdd }) {
  const { nodeTypes, loading } = useNodeTypes();

  const groups = [];
  for (const n of nodeTypes) {
    let group = groups.find(g => g.label === n.category);
    if (!group) { group = { label: n.category, types: [] }; groups.push(group); }
    group.types.push(n);
  }
  groups.sort((a, b) => {
    const ai = CATEGORY_ORDER.indexOf(a.label);
    const bi = CATEGORY_ORDER.indexOf(b.label);
    return (ai === -1 ? 999 : ai) - (bi === -1 ? 999 : bi);
  });

  return (
    <div className="flex flex-col h-full">
      <div className="px-4 py-3 border-b border-surface-border">
        <p className="text-xs font-semibold text-text-muted uppercase tracking-wider">Node Types</p>
        <p className="text-[10px] text-text-muted mt-0.5">Click to add to canvas</p>
      </div>

      <div className="flex-1 overflow-y-auto p-3 space-y-4">
        {loading && (
          <p className="text-[10px] text-text-muted px-1">Loading node types…</p>
        )}
        {groups.map(group => (
          <div key={group.label}>
            <p className="text-[9px] font-semibold text-text-muted uppercase tracking-widest mb-1.5 px-1">
              {group.label}
            </p>
            <div className="space-y-1">
              {group.types.map(n => (
                <button
                  key={n.type}
                  onClick={() => onAdd(n.type)}
                  className="w-full text-left px-3 py-2 rounded-lg border transition-all
                             hover:brightness-110 hover:translate-x-0.5 active:scale-95"
                  style={{ background: n.bg, borderColor: n.border, color: n.color }}
                >
                  <div className="flex items-center gap-2">
                    <span className="text-sm leading-none shrink-0">{n.icon}</span>
                    <div className="min-w-0">
                      <p className="text-[11px] font-semibold truncate">{n.label}</p>
                      <p className="text-[9px] opacity-60 truncate">{n.description}</p>
                    </div>
                  </div>
                </button>
              ))}
            </div>
          </div>
        ))}
      </div>

      <div className="px-4 py-3 border-t border-surface-border">
        <p className="text-[10px] text-text-muted leading-relaxed">
          <span className="text-brand font-medium">Tip:</span> Drag output dots to connect.
          Double-click edge to disconnect. Delete key removes selected node.
        </p>
      </div>
    </div>
  );
}
