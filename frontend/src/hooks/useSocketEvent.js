import { useEffect, useRef } from 'react';
import { socket } from '../api/socket.js';

/**
 * Subscribe to a Socket.IO event for the lifetime of the component.
 * Handler is always current — no stale-closure risk.
 *
 * Usage:
 *   useSocketEvent('enrs::ens_delivery', (payload) => setBlast(b => update(b, payload)));
 */
export function useSocketEvent(event, handler) {
  const handlerRef = useRef(handler);
  handlerRef.current = handler;

  useEffect(() => {
    const listener = (payload) => handlerRef.current(payload);
    socket.on(event, listener);
    return () => socket.off(event, listener);
  }, [event]);
}
