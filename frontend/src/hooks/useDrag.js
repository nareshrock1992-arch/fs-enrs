import { useRef, useCallback } from 'react';

/**
 * Generic pointer-event drag hook — enterprise-grade precision.
 *
 * Ghost-movement fix: when the activation threshold is crossed we reset
 * dragOriginX/Y to the CURRENT cursor position before firing onStart.
 * This means dx/dy passed to onMove are always relative to where the drag
 * physically began — never to the pointer-down point — so no initial jump
 * ever occurs regardless of threshold size.
 *
 * Element-ref fix: e.currentTarget becomes null after the synchronous
 * handler returns. We capture it immediately so the async cleanup can
 * safely call removeEventListener.
 */
export function useDrag({ onMove, onEnd, onStart, threshold = 2 }) {
  const state = useRef(null);

  const onPointerDown = useCallback((e) => {
    if (e.button !== 0) return;
    e.stopPropagation();

    // Capture element before the handler returns — e.currentTarget is null
    // in any async callback (closure over the event object, not the element).
    const el = e.currentTarget;
    const startX = e.clientX;
    const startY = e.clientY;
    let moved = false;

    // Drag origin is reset to the cursor position at the moment the
    // threshold is crossed.  Until that moment these hold the pointer-down
    // position but they are never used for onMove computation — they are
    // only used for the threshold check below.
    let dragOriginX = startX;
    let dragOriginY = startY;

    el.setPointerCapture(e.pointerId);

    const handleMove = (me) => {
      if (!moved) {
        // Use Euclidean distance for a clean circular dead zone.
        const dist = Math.hypot(me.clientX - startX, me.clientY - startY);
        if (dist < threshold) return;

        moved = true;
        // Reset origin to current cursor position so the very first onMove
        // call delivers dx=0, dy=0 (node stays under the cursor, no jump).
        dragOriginX = me.clientX;
        dragOriginY = me.clientY;
        onStart?.(me);
        // Return without calling onMove — let the NEXT event carry the real
        // delta so the node doesn't start with even a sub-pixel offset.
        return;
      }
      onMove?.(me.clientX - dragOriginX, me.clientY - dragOriginY, me);
    };

    const handleUp = (me) => {
      el.removeEventListener('pointermove', handleMove);
      el.removeEventListener('pointerup',   handleUp);
      state.current = null;
      onEnd?.(
        moved ? me.clientX - dragOriginX : 0,
        moved ? me.clientY - dragOriginY : 0,
        me,
        moved,
      );
    };

    state.current = { startX, startY, moved };
    el.addEventListener('pointermove', handleMove);
    el.addEventListener('pointerup',   handleUp);
  }, [onMove, onEnd, onStart, threshold]);

  return { onPointerDown };
}

/**
 * Canvas-level pan hook (middle-mouse / shift+left).
 * Kept for backwards compatibility but FlowCanvas now handles all pan
 * modes inline.
 */
export function useCanvasDrag({ onPan }) {
  const origin = useRef(null);

  const onPointerDown = useCallback((e) => {
    if (e.button !== 1 && !(e.button === 0 && e.shiftKey)) return;
    e.preventDefault();
    origin.current = { x: e.clientX, y: e.clientY };
    const el = e.currentTarget;
    el.setPointerCapture(e.pointerId);

    const handleMove = (me) => {
      if (!origin.current) return;
      onPan?.(me.clientX - origin.current.x, me.clientY - origin.current.y);
      origin.current = { x: me.clientX, y: me.clientY };
    };
    const handleUp = () => {
      origin.current = null;
      el.removeEventListener('pointermove', handleMove);
      el.removeEventListener('pointerup',   handleUp);
    };
    el.addEventListener('pointermove', handleMove);
    el.addEventListener('pointerup',   handleUp);
  }, [onPan]);

  return { onPointerDown };
}
