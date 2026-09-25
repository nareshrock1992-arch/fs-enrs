/**
 * FlowEdge — SVG cubic bezier path between two nodes.
 * Rendered inside an <svg> overlay that sits on top of the canvas div.
 *
 * Props:
 *   fromX, fromY   — output port centre (canvas coords)
 *   toX, toY       — input port centre (canvas coords)
 *   label          — branch key label (e.g. "1", "timeout")
 *   color          — stroke colour
 *   onDoubleClick  — disconnect handler
 */
export default function FlowEdge({
  fromX, fromY, toX, toY,
  label,
  color = '#4f46e5',
  onDoubleClick,
}) {
  const dx = Math.abs(toX - fromX);
  const cp = Math.max(60, dx * 0.5);

  // Cubic bezier: control points offset horizontally from ports
  const d = `M ${fromX} ${fromY} C ${fromX + cp} ${fromY}, ${toX - cp} ${toY}, ${toX} ${toY}`;

  const midX = (fromX + toX) / 2;
  const midY = (fromY + toY) / 2;

  return (
    <g onDoubleClick={onDoubleClick} style={{ cursor: onDoubleClick ? 'pointer' : 'default' }}>
      {/* Wider invisible hit area */}
      <path d={d} stroke="transparent" strokeWidth={12} fill="none" />
      {/* Visible edge */}
      <path
        d={d}
        stroke={color}
        strokeWidth={1.8}
        fill="none"
        strokeDasharray={undefined}
        markerEnd={`url(#arrow-${color.replace('#', '')})`}
        opacity={0.8}
      />
      {label && (() => {
        const w = Math.max(20, String(label).length * 6.4 + 14);
        return (
          <g style={{ pointerEvents: 'none' }}>
            {/* Neutral pill — sits on the edge midpoint, not raw text on the line */}
            <rect
              x={midX - w / 2} y={midY - 9} width={w} height={18} rx={9}
              stroke={color} strokeWidth={1}
              style={{ fill: 'rgb(var(--surface-panel))' }}
            />
            <text
              x={midX} y={midY + 3.5} textAnchor="middle" fontSize={10} fontWeight={600}
              style={{ fill: 'rgb(var(--text-secondary))', userSelect: 'none' }}
            >
              {label}
            </text>
          </g>
        );
      })()}
    </g>
  );
}

/**
 * DraftEdge — the in-progress edge drawn while dragging a connection.
 */
export function DraftEdge({ fromX, fromY, toX, toY }) {
  const dx = Math.abs(toX - fromX);
  const cp = Math.max(60, dx * 0.5);
  const d  = `M ${fromX} ${fromY} C ${fromX + cp} ${fromY}, ${toX - cp} ${toY}, ${toX} ${toY}`;

  return (
    <path
      d={d}
      stroke="#94a3b8"
      strokeWidth={1.5}
      fill="none"
      strokeDasharray="6 3"
      opacity={0.7}
      style={{ pointerEvents: 'none' }}
    />
  );
}
