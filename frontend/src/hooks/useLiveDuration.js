import { useState, useEffect } from 'react';

/**
 * Returns a live-ticking HH:MM:SS string computed from a UTC ISO start time.
 * Updates every second. Returns '—' if startIso is falsy.
 *
 * Usage:
 *   const duration = useLiveDuration(incident.started_at);
 *   // → '04:32' or '01:02:15' when > 1 hour
 */
export function useLiveDuration(startIso) {
  const [elapsed, setElapsed] = useState(calcElapsed(startIso));

  useEffect(() => {
    if (!startIso) return;
    const id = setInterval(() => setElapsed(calcElapsed(startIso)), 1000);
    return () => clearInterval(id);
  }, [startIso]);

  return elapsed;
}

function calcElapsed(startIso) {
  if (!startIso) return '—';
  const secs = Math.max(0, Math.floor((Date.now() - new Date(startIso).getTime()) / 1000));
  const h = Math.floor(secs / 3600);
  const m = Math.floor((secs % 3600) / 60);
  const s = secs % 60;
  if (h > 0) return `${h}:${pad(m)}:${pad(s)}`;
  return `${pad(m)}:${pad(s)}`;
}

function pad(n) {
  return String(n).padStart(2, '0');
}
