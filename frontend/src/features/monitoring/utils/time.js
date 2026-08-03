/** Shared time/duration helpers for all monitoring components. */

export function elapsedSec(isoStart, now = Date.now()) {
  if (!isoStart) return 0;
  return Math.max(0, Math.floor((now - new Date(isoStart)) / 1000));
}

export function fmtDur(secs) {
  if (secs < 60)   return `${secs}s`;
  if (secs < 3600) return `${Math.floor(secs / 60)}m ${secs % 60}s`;
  return `${Math.floor(secs / 3600)}h ${Math.floor((secs % 3600) / 60)}m`;
}

export function fmtTime(iso) {
  if (!iso) return '';
  return new Date(iso).toLocaleTimeString([], {
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  });
}
