import { useState, useCallback, useRef } from 'react';

const MIN_ZOOM   = 0.15;
const MAX_ZOOM   = 3.0;

function clamp(v, lo, hi) { return Math.min(hi, Math.max(lo, v)); }

/**
 * Canvas zoom + pan state.
 *
 * IMPORTANT: attach onWheel as a NATIVE (non-passive) listener, NOT as a
 * React synthetic event.  React 17+ attaches synthetic wheel handlers
 * passively, making e.preventDefault() a no-op.  FlowCanvas uses a
 * useEffect to attach the handler with { passive: false }.
 *
 * Behaviour:
 *   - Ctrl/Meta + wheel  →  zoom toward cursor   (matches Figma / Chrome)
 *   - Plain wheel        →  pan vertically
 *   - Shift + wheel      →  pan horizontally
 *   - Trackpad two-finger scroll passes as plain wheel (correct)
 *   - Trackpad pinch passes as Ctrl+wheel (correct)
 */
export function useZoomPan(initialTransform = { x: 40, y: 40, scale: 1 }) {
  const [transform, setTransform] = useState(initialTransform);
  // Keep a synchronous ref so wheel/pan handlers always read fresh values
  // without being re-created every render.
  const transformRef = useRef(transform);
  transformRef.current = transform;

  // Wheel handler — attach natively with { passive: false }.
  // Receives the raw DOM WheelEvent.
  const onWheel = useCallback((e) => {
    e.preventDefault();

    if (e.ctrlKey || e.metaKey) {
      // ── Zoom toward cursor ──────────────────────────────────────────────
      // Exponential scale feels logarithmic / natural: equal wheel distance
      // = equal perceived zoom step regardless of current zoom level.
      const el = e.currentTarget ?? e.target?.closest('.canvas-bg');
      const rect = el?.getBoundingClientRect();
      if (!rect) return;
      const mx = e.clientX - rect.left;
      const my = e.clientY - rect.top;
      const factor = Math.pow(0.998, e.deltaY);
      setTransform(prev => {
        const scale = clamp(prev.scale * factor, MIN_ZOOM, MAX_ZOOM);
        const f = scale / prev.scale;
        return { x: mx - (mx - prev.x) * f, y: my - (my - prev.y) * f, scale };
      });
    } else {
      // ── Pan ─────────────────────────────────────────────────────────────
      const dx = e.shiftKey ? -e.deltaY : -e.deltaX;
      const dy = e.shiftKey ?  0        : -e.deltaY;
      setTransform(prev => ({ ...prev, x: prev.x + dx, y: prev.y + dy }));
    }
  }, []);

  const pan = useCallback((dx, dy) => {
    setTransform(prev => ({ ...prev, x: prev.x + dx, y: prev.y + dy }));
  }, []);

  // Zoom toward a canvas-space centre point (used by toolbar buttons).
  const zoomTo = useCallback((targetScale, cx, cy) => {
    setTransform(prev => {
      const scale  = clamp(targetScale, MIN_ZOOM, MAX_ZOOM);
      const factor = scale / prev.scale;
      return { x: cx - (cx - prev.x) * factor, y: cy - (cy - prev.y) * factor, scale };
    });
  }, []);

  const reset = useCallback(() => {
    setTransform({ x: 40, y: 40, scale: 1 });
  }, []);

  // Convert screen (client) coords → canvas logical coords.
  const toCanvas = useCallback((clientX, clientY, canvasRect) => {
    const t  = transformRef.current;
    const rx = canvasRect ? clientX - canvasRect.left : clientX;
    const ry = canvasRect ? clientY - canvasRect.top  : clientY;
    return { x: (rx - t.x) / t.scale, y: (ry - t.y) / t.scale };
  }, []);

  const cssTransform = `translate(${transform.x}px,${transform.y}px) scale(${transform.scale})`;

  return {
    transform, setTransform, transformRef, cssTransform,
    onWheel, pan, zoomTo, reset, toCanvas,
    MIN_ZOOM, MAX_ZOOM,
  };
}
