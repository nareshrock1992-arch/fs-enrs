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

// Per-type one-line summary shown in the node card body. Additive-only —
// a node type without an entry here just shows the header with no extra
// summary line, so adding a new type never requires touching this.
function nodeSummary(node) {
  switch (node.type) {
    case 'play':           return <span className="truncate block">{node.audio_url || node.audio_file_id || '—'}</span>;
    case 'say':             return <span className="truncate block italic">"{node.text?.slice(0,28) || '…'}"</span>;
    case 'gather':          return <span>max {node.max_digits || 1} digit · {node.timeout_seconds || 5}s</span>;
    case 'goto':             return <span>→ {node.target_node_id || '?'}</span>;
    case 'ens':              return <span>Config {node.ens_configuration_id || node.ens_config_var || '?'}</span>;
    case 'ers':              return <span>Config {node.ers_configuration_id || '?'}</span>;
    case 'hangup':           return <span className="text-green-400">End of call</span>;
    case 'condition':
      return (
        <span className="truncate block font-mono">
          {node.variable || '?'} {node.operator || '=='} {(node.expected_value || '?').slice(0,14)}
        </span>
      );
    case 'record_message':
      return <span className="truncate block">→ {node.variable_name || '?'} · max {node.max_seconds || 60}s</span>;
    case 'set_variable':
      return (
        <span className="truncate block font-mono">
          {node.variable || '?'} = {(node.value || '').slice(0,16)}
        </span>
      );
    case 'transfer':        return <span className="truncate block">→ {node.destination || '?'}</span>;
    default:                return null;
  }
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
  const { onPointerDown } = useDrag({
    onStart: () => { startPos.current = { x: node.x, y: node.y }; },
    onMove:  (dx, dy) => onMove(node.id, startPos.current.x + dx / scale, startPos.current.y + dy / scale),
    onEnd:   (dx, dy, _e, moved) => {
      if (!moved) onSelect(node.id);
      else        onMove(node.id, startPos.current.x + dx / scale, startPos.current.y + dy / scale);
    },
  });

  const connectedPorts = new Set(edges.filter(e => e.from === node.id).map(e => e.fromPort));

  return (
    <div
      ref={nodeRef}
      data-node-id={node.id}
      style={{
        position:    'absolute',
        left:        node.x,
        top:         node.y,
        width:       NODE_WIDTH,
        cursor:      'grab',
        zIndex:      isSelected ? 10 : 1,
      }}
      onPointerDown={onPointerDown}
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
          border:       `1.5px solid ${
            hasErrors ? '#ef4444'
            : isSelected ? '#f1f5f9'
            : cfg.border
          }`,
          borderRadius: 10,
          boxShadow: isSelected
            ? `0 0 0 2px #f1f5f960, 0 4px 20px #00000060`
            : hasErrors
            ? `0 0 0 2px #ef444440`
            : '0 2px 8px #00000040',
          overflow:     'hidden',
          userSelect:   'none',
        }}
      >
        {/* Header */}
        <div style={{ borderBottom: `1px solid ${cfg.border}30` }}
             className="px-2.5 py-1.5 flex items-center gap-1.5">
          <span className="text-sm leading-none">{cfg.icon}</span>
          <span style={{ color: cfg.color }} className="text-[10px] font-bold uppercase tracking-wide truncate flex-1">
            {cfg.label}
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

        {/* Body — key field summary */}
        <div className="px-2.5 py-1.5 text-[10px] text-text-muted space-y-0.5">
          {nodeSummary(node)}
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
