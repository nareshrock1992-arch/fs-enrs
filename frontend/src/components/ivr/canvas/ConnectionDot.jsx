import { PORT_INSET } from './nodeGeometry.js';

// One output row: a branch label + a connection dot whose CENTRE sits exactly
// PORT_INSET px left of the node's right edge (matching the edge anchor math in
// FlowCanvas.portPosition). The visible dot stays small; the interactive hit
// area is much larger so ports are easy to grab.
//
// variant "row" (Menu nodes): each exit is a bordered row with its name on the
// left and the dot inside its right end. Same geometry, so wiring is unchanged.
export default function ConnectionDot({ portKey, label, color = '#2563EB', connected, onDragStart, variant }) {
  const row = variant === 'row';
  return (
    <div className="relative h-full select-none">
      {row && (
        <span
          aria-hidden
          className="absolute rounded-md pointer-events-none"
          style={{ left: 10, right: 4, top: 3, bottom: 3, border: '1px solid rgb(var(--node-border))' }}
        />
      )}
      {/* Branch label */}
      <span
        className={`absolute top-1/2 -translate-y-1/2 text-[11px] truncate leading-tight ${row ? 'text-left' : 'text-right'}`}
        style={{
          right: PORT_INSET + 12,
          left: row ? 18 : 10,
          color: row && connected ? 'rgb(var(--text-primary))' : 'rgb(var(--text-secondary))',
        }}
        title={label}
      >
        {label}
      </span>

      {/* Large invisible hit target (easy to grab) */}
      <div
        onPointerDown={(e) => { e.stopPropagation(); onDragStart?.(portKey); }}
        title={row ? `Drag to connect: ${label}` : `Drag to connect (${portKey})`}
        className="absolute top-1/2 cursor-crosshair group"
        style={{ right: PORT_INSET, transform: 'translate(50%, -50%)', width: 26, height: 26,
                 display: 'flex', alignItems: 'center', justifyContent: 'center' }}
      >
        {/* Visible dot */}
        <span
          className="rounded-full transition-transform group-hover:scale-125"
          style={{
            width: 11, height: 11,
            background: connected ? color : '#FFFFFF',
            border: `2px solid ${color}`,
            boxShadow: connected ? `0 0 0 3px ${color}22` : 'none',
          }}
        />
      </div>
    </div>
  );
}
