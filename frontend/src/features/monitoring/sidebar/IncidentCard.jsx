/**
 * IncidentCard — compact single-row conference entry in the sidebar.
 *
 * Target: ~40 px tall so 15–20 conferences fit without scrolling.
 * Status encoded via color/shape only — no label reading needed.
 *
 * Left border color  = tier severity (red / amber / blue / gray).
 * Dot indicators     : green pulse = live speaker · red pulse = recording · amber = locked.
 * Far-right number   : participant count.
 */
import { memo } from 'react';
import { elapsedSec, fmtDur } from '../utils/time.js';

const TIER_HEX = {
  PRIMARY:   '#ef4444',
  SECONDARY: '#f59e0b',
  QUEUE:     '#3b82f6',
};

// ─── Component ────────────────────────────────────────────────────────────────

export const IncidentCard = memo(function IncidentCard({ incident, selected, onSelect, now }) {
  const tierHex = TIER_HEX[incident.tier] ?? '#6b7280';
  const live    = incident.members?.filter(m => m.talking).length ?? 0;
  const isRec   = incident.recordingState === 'ACTIVE';
  const secs    = elapsedSec(incident.createdAt, now);

  return (
    <button
      type="button"
      onClick={() => onSelect(incident.id)}
      style={{ borderLeftColor: tierHex, borderLeftWidth: 3 }}
      className={[
        'w-full text-left flex items-center gap-2 px-2 py-1.5 transition-colors rounded-r',
        'border border-l-0',
        selected
          ? 'bg-primary/10 border-primary/30'
          : 'border-surface-border hover:bg-surface-hover',
      ].join(' ')}
    >
      {/* Elapsed — fixed-width monospace so all cards line up */}
      <span className="text-[8px] font-mono text-text-muted/50 tabular-nums w-8 shrink-0">
        {fmtDur(secs)}
      </span>

      {/* Conference name */}
      <span className="flex-1 text-[10px] font-bold text-text-primary truncate">
        {incident.ersName}
      </span>

      {/* Status dots + count */}
      <div className="flex items-center gap-1 shrink-0">
        {live > 0 && (
          <span className="w-1.5 h-1.5 rounded-full bg-green-500 animate-pulse" title={`${live} speaking`} />
        )}
        {isRec && (
          <span className="w-1.5 h-1.5 rounded-full bg-red-500 animate-pulse" title="Recording" />
        )}
        {incident.locked && (
          <span className="w-1.5 h-1.5 rounded-full bg-amber-500" title="Locked" />
        )}
        <span className="text-[9px] font-mono tabular-nums text-text-muted w-4 text-right">
          {incident.participantCount}
        </span>
      </div>
    </button>
  );
});
