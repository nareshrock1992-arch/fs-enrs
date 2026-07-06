import { useRef, useCallback } from 'react';

/**
 * Generic pointer-event drag hook.
 *
 * Usage:
 *   const { onPointerDown } = useDrag({
 *     onMove: (dx, dy, e) => {},
 *     onEnd:  (dx, dy, e) => {},
 *   });
 *
 * Attach onPointerDown to the drag handle element.
 * Uses setPointerCapture so moves are tracked even outside the element.
 */
export function useDrag({ onMove, onEnd, onStart, threshold = 2 }) {
  const state = useRef(null);

  const onPointerDown = useCallback((e) => {
    if (e.button !== 0) return; // left button only
    e.stopPropagation();

    const startX = e.clientX;
    const startY = e.clientY;
    let moved = false;

    state.current = { startX, startY, moved };
    e.currentTarget.setPointerCapture(e.pointerId);

    const handleMove = (me) => {
      const dx = me.clientX - startX;
      const dy = me.clientY - startY;
      if (!moved && Math.abs(dx) + Math.abs(dy) > threshold) {
        moved = true;
        state.current.moved = true;
        onStart?.(me);
      }
      if (moved) onMove?.(dx, dy, me);
    };

    const handleUp = (me) => {
      const dx = me.clientX - startX;
      const dy = me.clientY - startY;
      onEnd?.(dx, dy, me, moved);
      e.currentTarget.removeEventListener('pointermove', handleMove);
      e.currentTarget.removeEventListener('pointerup',   handleUp);
      state.current = null;
    };

    e.currentTarget.addEventListener('pointermove', handleMove);
    e.currentTarget.addEventListener('pointerup',   handleUp);
  }, [onMove, onEnd, onStart, threshold]);

  return { onPointerDown };
}

/**
 * Canvas-level drag hook — used for panning the canvas.
 * Returns onPointerDown for the canvas background.
 */
export function useCanvasDrag({ onPan }) {
  const origin = useRef(null);

  const onPointerDown = useCallback((e) => {
    // Middle mouse or right-click = pan; also allow shift+left
    if (e.button !== 1 && !(e.button === 0 && e.shiftKey)) return;
    e.preventDefault();
    origin.current = { x: e.clientX, y: e.clientY };
    e.currentTarget.setPointerCapture(e.pointerId);

    const handleMove = (me) => {
      if (!origin.current) return;
      const dx = me.clientX - origin.current.x;
      const dy = me.clientY - origin.current.y;
      origin.current = { x: me.clientX, y: me.clientY };
      onPan?.(dx, dy);
    };

    const handleUp = () => {
      origin.current = null;
      e.currentTarget.removeEventListener('pointermove', handleMove);
      e.currentTarget.removeEventListener('pointerup',   handleUp);
    };

    e.currentTarget.addEventListener('pointermove', handleMove);
    e.currentTarget.addEventListener('pointerup',   handleUp);
  }, [onPan]);

  return { onPointerDown };
}
