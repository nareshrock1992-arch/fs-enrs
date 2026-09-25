import { PORT_INSET } from './nodeGeometry.js';

// One output row: a right-aligned branch label + a connection dot whose CENTRE
// sits exactly PORT_INSET px left of the node's right edge (matching the edge
// anchor math in FlowCanvas.portPosition). The visible dot stays small; the
// interactive hit area is much larger so ports are easy to grab.
export default function ConnectionDot({ portKey, label, color = '#2563EB', connected, onDragStart }) {
  return (
    <div className="relative h-full select-none">
      {/* Branch label */}
      <span
        className="absolute top-1/2 -translate-y-1/2 text-[11px] text-text-secondary
                   text-right truncate leading-tight"
        style={{ right: PORT_INSET + 12, left: 10 }}
        title={label}
      >
        {label}
      </span>

      {/* Large invisible hit target (easy to grab) */}
      <div
        onPointerDown={(e) => { e.stopPropagation(); onDragStart?.(portKey); }}
        title={`Drag to connect (${portKey})`}
        className="absolute top-1/2 cursor-crosshair group"
        style={{ right: PORT_INSET, transform: 'translate(50%, -50%)', width: 26, height: 26,
                 display: 'flex', alignItems: 'center', justifyContent: 'center' }}
      >
        {/* Visible dot */}
        <span
          className="rounded-full transition-transform group-hover:scale-125"
          style={{
            width: 11, height: 11,
            background: connected ? color : 'rgb(var(--surface-panel))',
            border: `2px solid ${color}`,
            boxShadow: connected ? `0 0 0 3px ${color}22` : 'none',
          }}
        />
      </div>
    </div>
  );
}
