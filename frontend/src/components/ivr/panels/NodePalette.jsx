import { useState, useMemo } from 'react';
import { Search, PanelLeftClose } from 'lucide-react';
import { useNodeTypes } from '../../../hooks/useNodeTypes.js';
import { nodeStyle } from '../canvas/nodeStyle.js';

// Node types come entirely from GET /api/v1/ivr/node-types (registry). This file
// only presents them — grouped by the registry `category`, with search. Adding a
// node type to the registry still makes it appear here with zero edits.
const CATEGORY_ORDER = ['Audio', 'Input', 'Recording', 'Emergency', 'Flow', 'Integrations'];

export default function NodePalette({ onAdd, onCollapse }) {
  const { nodeTypes, loading } = useNodeTypes();
  const [q, setQ] = useState('');

  const groups = useMemo(() => {
    const needle = q.trim().toLowerCase();
    const filtered = needle
      ? nodeTypes.filter(n =>
          `${n.label} ${n.type} ${n.description || ''} ${n.category}`.toLowerCase().includes(needle))
      : nodeTypes;
    const g = [];
    for (const n of filtered) {
      let group = g.find(x => x.label === n.category);
      if (!group) { group = { label: n.category, types: [] }; g.push(group); }
      group.types.push(n);
    }
    g.sort((a, b) => {
      const ai = CATEGORY_ORDER.indexOf(a.label), bi = CATEGORY_ORDER.indexOf(b.label);
      return (ai === -1 ? 999 : ai) - (bi === -1 ? 999 : bi);
    });
    return g;
  }, [nodeTypes, q]);

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="px-3 py-2.5 border-b border-surface-border flex items-center justify-between gap-2">
        <p className="text-[11px] font-semibold text-text-secondary uppercase tracking-wider">Node Library</p>
        {onCollapse && (
          <button onClick={onCollapse} title="Collapse" aria-label="Collapse node library"
                  className="text-text-muted hover:text-text-primary transition-colors">
            <PanelLeftClose size={15} />
          </button>
        )}
      </div>

      {/* Search */}
      <div className="px-3 pt-2.5 pb-1">
        <div className="relative">
          <Search size={13} className="absolute left-2 top-1/2 -translate-y-1/2 text-text-muted pointer-events-none" />
          <input
            value={q}
            onChange={e => setQ(e.target.value)}
            placeholder="Search nodes…"
            aria-label="Search node types"
            className="w-full pl-7 pr-2 py-1.5 text-[12px] rounded-md bg-surface-bg border border-surface-border
                       text-text-primary placeholder:text-text-muted focus:outline-none focus:border-primary
                       focus:ring-2 focus:ring-primary/20"
          />
        </div>
      </div>

      {/* Groups */}
      <div className="flex-1 overflow-y-auto px-2 pb-3 pt-1 space-y-3">
        {loading && <p className="text-[11px] text-text-muted px-2">Loading node types…</p>}
        {!loading && groups.length === 0 && (
          <p className="text-[11px] text-text-muted px-2">No nodes match “{q}”.</p>
        )}
        {groups.map(group => (
          <div key={group.label}>
            <p className="text-[10px] font-semibold text-text-muted uppercase tracking-widest mb-1 px-1.5">
              {group.label}
            </p>
            <div className="space-y-0.5">
              {group.types.map(n => {
                const { accent, Icon } = nodeStyle(n);
                return (
                  <button
                    key={n.type}
                    draggable
                    onDragStart={e => {
                      e.dataTransfer.setData('application/ivr-node-type', n.type);
                      e.dataTransfer.effectAllowed = 'copy';
                    }}
                    onClick={() => onAdd(n.type)}
                    title={n.description || n.label}
                    className="w-full text-left px-2 py-1.5 rounded-md flex items-center gap-2
                               text-text-primary hover:bg-surface-hover focus:outline-none
                               focus:ring-2 focus:ring-primary/25 transition-colors cursor-grab active:cursor-grabbing"
                  >
                    <span className="flex items-center justify-center w-6 h-6 rounded-md shrink-0"
                          style={{ background: `${accent}1a`, color: accent }}>
                      <Icon size={13} strokeWidth={2} />
                    </span>
                    <span className="min-w-0">
                      <span className="block text-[12px] font-medium truncate">{n.label}</span>
                      {n.description && (
                        <span className="block text-[10px] text-text-muted truncate">{n.description}</span>
                      )}
                    </span>
                  </button>
                );
              })}
            </div>
          </div>
        ))}
      </div>

      <div className="px-3 py-2 border-t border-surface-border">
        <p className="text-[10px] text-text-muted leading-relaxed">
          Click or drag to add · drag a port dot to connect · double-click an edge to disconnect.
        </p>
      </div>
    </div>
  );
}
