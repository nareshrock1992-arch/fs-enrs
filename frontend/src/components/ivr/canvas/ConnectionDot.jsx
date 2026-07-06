/**
 * ConnectionDot — output port handle on a node.
 * When dragged, starts a new edge. When clicked on a node target, completes it.
 *
 * Props:
 *   portKey      — 'next' | 'goto' | branch key (e.g. '1', 'timeout')
 *   label        — display label
 *   color        — dot fill colour
 *   connected    — bool — whether this port already has a connection
 *   onDragStart  — (portKey, dotEl) => void
 */
export default function ConnectionDot({ portKey, label, color = '#4f46e5', connected, onDragStart }) {
  return (
    <div className="flex items-center gap-1.5 mt-1" data-port={portKey}>
      <span className="text-[9px] text-text-muted shrink-0 w-12 text-right truncate">{label}</span>
      <div
        className="w-3 h-3 rounded-full border-2 cursor-crosshair shrink-0 transition-all hover:scale-125"
        style={{
          background:   connected ? color : 'transparent',
          borderColor:  color,
          boxShadow:    connected ? `0 0 4px ${color}60` : 'none',
        }}
        title={`Drag to connect (${portKey})`}
        onPointerDown={(e) => {
          e.stopPropagation();
          onDragStart?.(portKey, e.currentTarget);
        }}
      />
    </div>
  );
}
