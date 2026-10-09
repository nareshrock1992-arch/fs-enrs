import { useRef, useState } from 'react';
import { Trash2, CheckCircle2, AlertTriangle, XCircle } from 'lucide-react';
import { useDrag } from '../../../hooks/useDrag.js';
import { useNodeTypes } from '../../../hooks/useNodeTypes.js';
import { getPortsForNode } from './nodePorts.js';
import { nodeSubtitleLines } from './nodeSubtitle.js';
import { nodeHeaderParts } from './nodeIdentity.js';
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
  node, isSelected, isEntry, hasErrors, hasWarnings, errorCount = 0, warningCount = 0, edges, scale,
  onSelect, onMove, onDelete, onPortDragStart, onPortClick,
  onDragStart, onDragEnd, onContextMenu, onHover, summaryResolvers,
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
  // Card header hierarchy (Phase 2b): prominent title + a type eyebrow shown
  // only when it adds information (a real configured name/summary is present).
  // Preserves Phase-1 identity exactly (title === previous cardTitle).
  const { title: cardTitle, typeLabel } = nodeHeaderParts(node, cfg, summaryResolvers);
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
  // Restrained, enterprise shadows (slate, not pure black) so cards read as
  // flat surfaces on the light canvas; kept subtle in dark mode too.
  const shadow = isDragging
    ? '0 10px 24px rgb(15 23 42 / 0.18)'
    : isSelected
    ? '0 2px 8px rgb(15 23 42 / 0.12)'
    : '0 1px 2px rgb(15 23 42 / 0.06)';

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
      onPointerEnter={() => { setHovered(true); onHover?.(node.id); }}
      onPointerLeave={() => { setHovered(false); onHover?.(null); }}
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
          style={{ height: HEADER_H, cursor: isDragging ? 'grabbing' : 'grab', borderBottom: '1px solid rgb(var(--node-border))' }}
          className="pl-2.5 pr-2 flex items-center gap-2"
        >
          <span className="flex items-center justify-center w-7 h-7 rounded-lg shrink-0"
                style={{ background: `${accent}1f`, color: accent }}>
            <Icon size={15} strokeWidth={2} />
          </span>
          {/* Title (prominent) over an optional type eyebrow (secondary) */}
          <span className="flex flex-col min-w-0 flex-1 justify-center" style={{ lineHeight: 1.15 }}>
            <span className="text-[12.5px] font-semibold truncate" style={{ color: NODE_TEXT.title }} title={cardTitle}>
              {cardTitle}
            </span>
            {typeLabel && (
              <span className="text-[9px] font-semibold uppercase tracking-wide truncate"
                    style={{ color: NODE_TEXT.muted }}>
                {typeLabel}
              </span>
            )}
          </span>
          {/* Status badge: error count > warning count > valid. Non-color-only
              (icon + count) so it reads for color-blind users. */}
          {errorCount > 0 ? (
            <span className="shrink-0 flex items-center gap-0.5 text-[10px] font-bold" style={{ color: '#DC2626' }}
                  title={`${errorCount} error${errorCount !== 1 ? 's' : ''} — open to fix`}>
              <XCircle size={12} />{errorCount}
            </span>
          ) : warningCount > 0 ? (
            <span className="shrink-0 flex items-center gap-0.5 text-[10px] font-bold" style={{ color: '#D97706' }}
                  title={`${warningCount} warning${warningCount !== 1 ? 's' : ''}`}>
              <AlertTriangle size={12} />{warningCount}
            </span>
          ) : (
            <CheckCircle2 size={13} className="shrink-0" style={{ color: '#059669', opacity: 0.55 }} title="Valid" />
          )}
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
          style={{ height: SUMMARY_H }}
          className="px-3 py-1 leading-tight cursor-pointer overflow-hidden"
          onClick={e => { e.stopPropagation(); onSelect(node.id); }}
          title={[primary, secondary].filter(Boolean).join(' — ')}
        >
          {primary && <span className="truncate block text-[11px] font-medium" style={{ color: NODE_TEXT.summary }}>{primary}</span>}
          {secondary && <span className="truncate block text-[10px]" style={{ color: NODE_TEXT.muted }}>{secondary}</span>}
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
