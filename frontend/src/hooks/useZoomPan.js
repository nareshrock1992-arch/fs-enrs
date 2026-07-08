import { useState, useCallback, useRef } from 'react';

const MIN_ZOOM = 0.3;
const MAX_ZOOM = 2.0;
const ZOOM_SPEED = 0.001;

/**
 * Canvas zoom + pan state.
 *
 * Returns:
 *   transform  — { x, y, scale } — apply as CSS transform on canvas container
 *   onWheel    — attach to canvas wrapper for zoom-to-cursor
 *   pan(dx,dy) — call from useCanvasDrag to offset pan
 *   reset()    — fit to default view
 *   toCanvas(clientX, clientY) — convert screen coords → canvas coords
 */
export function useZoomPan() {
  const [transform, setTransform] = useState({ x: 0, y: 0, scale: 1 });
  const transformRef = useRef(transform);
  transformRef.current = transform;

  const onWheel = useCallback((e) => {
    e.preventDefault();
    const rect = e.currentTarget.getBoundingClientRect();
    const mx = e.clientX - rect.left;
    const my = e.clientY - rect.top;

    setTransform(prev => {
      const delta  = -e.deltaY * ZOOM_SPEED;
      const scale  = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, prev.scale + delta * prev.scale));
      const factor = scale / prev.scale;
      // Zoom toward cursor point
      const x = mx - (mx - prev.x) * factor;
      const y = my - (my - prev.y) * factor;
      return { x, y, scale };
    });
  }, []);

  const pan = useCallback((dx, dy) => {
    setTransform(prev => ({ ...prev, x: prev.x + dx, y: prev.y + dy }));
  }, []);

  const reset = useCallback(() => {
    setTransform({ x: 40, y: 40, scale: 1 });
  }, []);

  // Convert screen (client) coords to canvas logical coords
  const toCanvas = useCallback((clientX, clientY, canvasRect) => {
    const t = transformRef.current;
    const rx = canvasRect ? clientX - canvasRect.left : clientX;
    const ry = canvasRect ? clientY - canvasRect.top  : clientY;
    return {
      x: (rx - t.x) / t.scale,
      y: (ry - t.y) / t.scale,
    };
  }, []);

  const cssTransform = `translate(${transform.x}px, ${transform.y}px) scale(${transform.scale})`;

  return { transform, setTransform, cssTransform, onWheel, pan, reset, toCanvas };
}
