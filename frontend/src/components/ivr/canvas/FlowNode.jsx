import { useRef, useState } from 'react';
import { Trash2 } from 'lucide-react';
import { useDrag } from '../../../hooks/useDrag.js';
import { useNodeTypes } from '../../../hooks/useNodeTypes.js';
import { getPortsForNode } from './nodePorts.js';
import ConnectionDot from './ConnectionDot.jsx';

const FALLBACK_CFG = { label: 'Unknown', icon: '?', bg: '#2a2a2a', border: '#555', color: '#ccc' };

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

export const NODE_WIDTH  = 148;
export const NODE_HEIGHT = 80;

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
  onDragStart,
  onDragEnd,
}) {
  const { byType } = useNodeTypes();
  const cfg   = byType[node.type] || FALLBACK_CFG;
  const ports = getPortsForNode(node, cfg.ports);
  const nodeRef   = useRef(null);
  const startPos  = useRef({ x: node.x, y: node.y });
  const [isDragging, setIsDragging] = useState(false);

  const { onPointerDown: headerPointerDown } = useDrag({
    threshold: 5,
    onStart: (e) => {
      startPos.current = { x: node.x, y: node.y };
      setIsDragging(true);
      onDragStart?.(node.id, e);
    },
    onMove: (dx, dy) => {
      onMove(node.id, startPos.current.x + dx / scale, startPos.current.y + dy / scale);
    },
    onEnd: (dx, dy, e, moved) => {
      setIsDragging(false);
      if (moved) onMove(node.id, startPos.current.x + dx / scale, startPos.current.y + dy / scale);
      onDragEnd?.(node.id, e);
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
        position:        'absolute',
        left:            node.x,
        top:             node.y,
        width:           NODE_WIDTH,
        zIndex:          isDragging ? 100 : isSelected ? 10 : 1,
        // will-change lets the compositor layer this node independently
        willChange:      isDragging ? 'transform' : undefined,
        // No CSS transition during drag — it adds latency.
        // Transition only when not dragging (e.g. snap-into-place on drop).
        transition:      isDragging ? 'none' : 'box-shadow 0.1s',
      }}
      onClick={e => { e.stopPropagation(); }}
      onPointerUp={e => { e.stopPropagation(); onPortClick?.(node.id); }}
    >
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
          boxShadow: isDragging
            ? `0 0 0 2px #f1f5f940, 0 16px 48px #00000080, 0 4px 12px #00000060`
            : isSelected
            ? `0 0 0 2px #f1f5f960, 0 4px 20px #00000060`
            : hasErrors
            ? `0 0 0 2px #ef444440`
            : hasWarnings
            ? `0 0 0 2px #f59e0b30`
            : '0 2px 8px #00000040',
          overflow:  'hidden',
          userSelect: 'none',
          // Slight scale lift while dragging — gives tactile "picked up" feel
          transform: isDragging ? 'scale(1.025)' : undefined,
          transformOrigin: '50% 50%',
        }}
      >
        {/* Header — drag handle */}
        <div
          style={{
            borderBottom: `1px solid ${cfg.border}30`,
            cursor: isDragging ? 'grabbing' : 'grab',
          }}
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

        {/* Body — click opens settings panel */}
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
