import { useRef, useState } from 'react';
import { Trash2 } from 'lucide-react';
import { useDrag } from '../../../hooks/useDrag.js';
import { useNodeTypes } from '../../../hooks/useNodeTypes.js';
import { getPortsForNode } from './nodePorts.js';
import { nodeSubtitleLines } from './nodeSubtitle.js';
import { nodeStyle, NODE_TEXT } from './nodeStyle.js';
import {
  NODE_WIDTH, HEADER_H, SUMMARY_H, PORT_ROW_H, PORT_TOP, nodeHeight,
} from './nodeGeometry.js';
import ConnectionDot from './ConnectionDot.jsx';

// Re-export geometry so existing importers (FlowCanvas) keep working.
export { NODE_WIDTH } from './nodeGeometry.js';
export { NODE_HEIGHT } from './nodeGeometry.js';

const FALLBACK_CFG = { label: 'Unknown', type: '', category: '', ports: [] };

export default function FlowNode({
  node, isSelected, isEntry, hasErrors, hasWarnings, edges, scale,
  onSelect, onMove, onDelete, onPortDragStart, onPortClick,
  onDragStart, onDragEnd, onContextMenu, summaryResolvers,
}) {
  const { byType } = useNodeTypes();
  const cfg   = byType[node.type] || FALLBACK_CFG;
  const ports = getPortsForNode(node, cfg.ports, cfg.branchKeys, cfg.portLabels);
  const v = nodeStyle(cfg);
  const { accent, Icon } = v;
  const startPos = useRef({ x: node.x, y: node.y });
  const [isDragging, setIsDragging] = useState(false);
  const [hovered, setHovered] = useState(false);

  const { onPointerDown: headerPointerDown } = useDrag({
    threshold: 5,
    onStart: (e) => { startPos.current = { x: node.x, y: node.y }; setIsDragging(true); onDragStart?.(node.id, e); },
    onMove:  (dx, dy) => onMove(node.id, startPos.current.x + dx / scale, startPos.current.y + dy / scale),
    onEnd:   (dx, dy, e, moved) => {
      setIsDragging(false);
      if (moved) onMove(node.id, startPos.current.x + dx / scale, startPos.current.y + dy / scale);
      onDragEnd?.(node.id, e);
    },
  });

  const connectedPorts = new Set(edges.filter(e => e.from === node.id).map(e => e.fromPort));
  const { primary, secondary } = nodeSubtitleLines(node, cfg, summaryResolvers);
  const height = nodeHeight(ports.length);

  // Category-tinted surface — subtle at rest, stronger on hover, stronger still
  // when selected (selection PRESERVES the category identity, per spec).
  const surface = isSelected ? v.surfaceSel : hovered ? v.surfaceHover : v.surface;
  // Border: error/warning are semantic overrides; otherwise category border,
  // strengthened to the accent when selected/entry.
  const borderColor = hasErrors ? '#DC2626'
    : hasWarnings ? '#D97706'
    : (isSelected || isEntry) ? v.borderSel
    : v.border;
  const ring = hasErrors
    ? '0 0 0 1px #DC2626'
    : isSelected
    ? `0 0 0 1px ${v.borderSel}`
    : null;
  const shadow = isDragging
    ? '0 12px 28px rgb(0 0 0 / 0.35)'
    : isSelected
    ? '0 4px 14px rgb(0 0 0 / 0.28)'
    : '0 2px 6px rgb(0 0 0 / 0.22)';

  return (
    <div
      data-node-id={node.id}
      style={{
        position: 'absolute', left: node.x, top: node.y, width: NODE_WIDTH, height,
        zIndex: isDragging ? 100 : isSelected ? 10 : 1,
        willChange: isDragging ? 'transform' : undefined,
        transition: isDragging ? 'none' : 'box-shadow 140ms',
      }}
      onClick={e => e.stopPropagation()}
      onPointerUp={e => { e.stopPropagation(); onPortClick?.(node.id); }}
      onPointerEnter={() => setHovered(true)}
      onPointerLeave={() => setHovered(false)}
      onContextMenu={e => { e.preventDefault(); e.stopPropagation(); onContextMenu?.(node.id, e); }}
    >
      {isEntry && (
        <div
          title="This node executes first when a call arrives"
          style={{ position: 'absolute', top: -20, left: 0, background: 'rgb(var(--brand))' }}
          className="flex items-center gap-1 px-1.5 py-0.5 rounded-md text-white text-[10px]
                     font-semibold uppercase tracking-wide select-none whitespace-nowrap pointer-events-none"
        >
          ▶ Start
        </div>
      )}

      <div
        className="h-full rounded-lg overflow-hidden"
        style={{
          background: surface,
          border: `1px solid ${borderColor}`,
          boxShadow: [ring, shadow].filter(Boolean).join(', '),
          transform: isDragging ? 'scale(1.02)' : undefined,
          transition: isDragging ? 'none' : 'background 140ms, border-color 140ms, box-shadow 140ms',
        }}
      >
        {/* Category accent bar */}
        <div style={{ position: 'absolute', left: 0, top: 0, bottom: 0, width: 4, background: accent }} />

        {/* Header — drag handle */}
        <div
          onPointerDown={headerPointerDown}
          style={{ height: HEADER_H, cursor: isDragging ? 'grabbing' : 'grab', borderBottom: `1px solid ${accent}22` }}
          className="pl-3 pr-2 flex items-center gap-2"
        >
          <span className="flex items-center justify-center w-6 h-6 rounded-md shrink-0"
                style={{ background: `${accent}22`, color: accent }}>
            <Icon size={14} strokeWidth={2} />
          </span>
          <span className="text-[13px] font-semibold truncate flex-1 leading-tight" style={{ color: NODE_TEXT.title }}>
            {node.nickname || cfg.label}
          </span>
          {isSelected && (
            <button
              className="shrink-0 transition-colors hover:opacity-80"
              style={{ color: NODE_TEXT.muted }}
              aria-label="Delete node"
              onPointerDown={e => e.stopPropagation()}
              onClick={e => { e.stopPropagation(); onDelete(node.id); }}
            >
              <Trash2 size={13} />
            </button>
          )}
        </div>

        {/* Summary (reserved area) — click opens inspector */}
        <div
          style={{ height: SUMMARY_H, color: NODE_TEXT.summary }}
          className="px-3 py-1 text-[11px] leading-tight cursor-pointer overflow-hidden"
          onClick={e => { e.stopPropagation(); onSelect(node.id); }}
          title={[primary, secondary].filter(Boolean).join(' — ')}
        >
          {primary && <span className="truncate block">{primary}</span>}
          {secondary && <span className="truncate block italic" style={{ color: NODE_TEXT.muted }}>{secondary}</span>}
        </div>

        {/* Output ports — absolutely positioned to match FlowCanvas anchor math */}
        {ports.map((p, i) => (
          <div key={p.key}
               style={{ position: 'absolute', left: 0, right: 0, top: PORT_TOP + i * PORT_ROW_H, height: PORT_ROW_H }}>
            <ConnectionDot
              portKey={p.key}
              label={p.label}
              color={accent}
              connected={connectedPorts.has(p.key)}
              onDragStart={(portKey) => onPortDragStart?.(node.id, portKey)}
            />
          </div>
        ))}
      </div>
    </div>
  );
}
