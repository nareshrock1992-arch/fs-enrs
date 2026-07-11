import { useRef } from 'react';
import { Trash2 } from 'lucide-react';
import { useDrag } from '../../../hooks/useDrag.js';
import { useNodeTypes } from '../../../hooks/useNodeTypes.js';
import { getPortsForNode } from './nodePorts.js';
import ConnectionDot from './ConnectionDot.jsx';

// Phase 3: per-type visual config (icon/colors/label) comes from the
// node-type registry (GET /api/v1/ivr/node-types) instead of being
// hardcoded here — see backend/src/nodeTypes/registry.js. This fallback
// is used only for the brief window before the registry fetch resolves,
// or if a node references a type the registry doesn't know about (e.g. a
// flow saved before a type was removed).
const FALLBACK_CFG = { label: 'Unknown', icon: '?', bg: '#2a2a2a', border: '#555', color: '#ccc' };

// Registry-driven node card summary line.
// Each node type in the registry supplies a summaryTemplate string with
// ${fieldName} placeholders; missing/empty fields render as '?'.
// Returns null when the type has no summaryTemplate (e.g. hangup).
function nodeSummary(node, cfg) {
  const tmpl = cfg?.summaryTemplate;
  if (!tmpl) return null;

  const text = tmpl.replace(/\$\{(\w+)\}/g, (_, key) => {
    const v = node[key];
    if (v === undefined || v === null || v === '') return '?';
    return String(v).slice(0, 24);
  });

  return <span className="truncate block">{text}</span>;
}

// ── FlowNode ──────────────────────────────────────────────────────────────────

const NODE_WIDTH  = 148;
const NODE_HEIGHT = 80; // approximate — used for port position calculation

export { NODE_WIDTH, NODE_HEIGHT };

export default function FlowNode({
  node,
  isSelected,
  isEntry,
  hasErrors,
  hasWarnings,
  edges,
  scale,
  onSelect,
  onMove,
  onDelete,
  onPortDragStart,
  onPortClick,
}) {
  const { byType } = useNodeTypes();
  const cfg   = byType[node.type] || FALLBACK_CFG;
  const ports = getPortsForNode(node, cfg.ports);
  const nodeRef = useRef(null);

  const startPos = useRef({ x: node.x, y: node.y });

  // Drag is attached only to the HEADER div (5px threshold) so body
  // clicks can open the settings panel without accidentally moving the node.
  const { onPointerDown: headerPointerDown } = useDrag({
    threshold: 5,
    onStart: () => { startPos.current = { x: node.x, y: node.y }; },
    onMove:  (dx, dy) => onMove(node.id, startPos.current.x + dx / scale, startPos.current.y + dy / scale),
    onEnd:   (dx, dy, _e, moved) => {
      if (moved) onMove(node.id, startPos.current.x + dx / scale, startPos.current.y + dy / scale);
    },
  });

  const connectedPorts = new Set(edges.filter(e => e.from === node.id).map(e => e.fromPort));

  const borderColor = hasErrors
    ? '#ef4444'
    : isSelected
    ? '#f1f5f9'
    : hasWarnings
    ? '#f59e0b'
    : cfg.border;

  return (
    <div
      ref={nodeRef}
      data-node-id={node.id}
      style={{
        position:    'absolute',
        left:        node.x,
        top:         node.y,
        width:       NODE_WIDTH,
        zIndex:      isSelected ? 10 : 1,
      }}
      onClick={e => { e.stopPropagation(); }}
      onPointerUp={e => { e.stopPropagation(); onPortClick?.(node.id); }}
    >
      {/* Entry badge */}
      {isEntry && (
        <div className="absolute -top-5 left-0 text-[9px] text-brand font-bold uppercase tracking-widest">
          ▼ Entry
        </div>
      )}

      <div
        style={{
          background:   cfg.bg,
          border:       `1.5px solid ${borderColor}`,
          borderRadius: 10,
          boxShadow: isSelected
            ? `0 0 0 2px #f1f5f960, 0 4px 20px #00000060`
            : hasErrors
            ? `0 0 0 2px #ef444440`
            : hasWarnings
            ? `0 0 0 2px #f59e0b30`
            : '0 2px 8px #00000040',
          overflow:     'hidden',
          userSelect:   'none',
        }}
      >
        {/* Header — drag handle. 5px threshold prevents accidental drags. */}
        <div
          style={{ borderBottom: `1px solid ${cfg.border}30`, cursor: 'grab' }}
          className="px-2.5 py-1.5 flex items-center gap-1.5"
          onPointerDown={headerPointerDown}
        >
          <span className="text-sm leading-none">{cfg.icon}</span>
          <span style={{ color: cfg.color }} className="text-[10px] font-bold uppercase tracking-wide truncate flex-1">
            {node.nickname || cfg.label}
          </span>
          {isSelected && (
            <button
              className="ml-auto opacity-60 hover:opacity-100 hover:text-red-400 transition-opacity"
              style={{ color: cfg.color }}
              onPointerDown={e => e.stopPropagation()}
              onClick={e => { e.stopPropagation(); onDelete(node.id); }}
            >
              <Trash2 size={11} />
            </button>
          )}
        </div>

        {/* Body — click opens settings panel (onPortClick selects node) */}
        <div
          className="px-2.5 py-1.5 text-[10px] text-text-muted space-y-0.5 cursor-pointer"
          onClick={e => { e.stopPropagation(); onSelect(node.id); }}
        >
          {nodeSummary(node, cfg)}
        </div>

        {/* Output ports */}
        {ports.length > 0 && (
          <div className="px-2 pb-2 pt-0.5">
            {ports.map(p => (
              <ConnectionDot
                key={p.key}
                portKey={p.key}
                label={p.label}
                color={cfg.border}
                connected={connectedPorts.has(p.key)}
                onDragStart={(portKey) => onPortDragStart?.(node.id, portKey)}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
