/**
 * NowSpeakingWidget — pinned panel showing the current floor holder.
 *
 * Shared between ERS and STANDARD conference types.
 * Renders nothing meaningful when no participant holds the floor.
 */
import { memo } from 'react';
import { Mic, Radio } from 'lucide-react';
import { elapsedSec, fmtDur } from '../utils/time.js';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function initials(name) {
  if (!name) return '?';
  const words = name.replace(/[^a-zA-Z0-9\s]/g, '').trim().split(/\s+/).filter(Boolean);
  if (words.length >= 2) return (words[0][0] + words[1][0]).toUpperCase();
  if (words[0])          return words[0].slice(0, 2).toUpperCase();
  return '?';
}

const AVATAR_COLORS = [
  'bg-blue-500/20 text-blue-400',
  'bg-emerald-500/20 text-emerald-400',
  'bg-purple-500/20 text-purple-400',
  'bg-amber-500/20 text-amber-500',
  'bg-rose-500/20 text-rose-400',
  'bg-cyan-500/20 text-cyan-400',
];

// ─── VU Bars — CSS-only animation, zero React re-renders ──────────────────────

function VuBars({ active }) {
  return (
    <div className="flex items-end gap-px" style={{ height: 28 }}>
      {[0.4, 0.7, 1, 0.85, 0.6, 0.9, 0.5, 0.75].map((scale, i) => (
        <div
          key={i}
          className="w-1.5 rounded-sm bg-emerald-500"
          style={{
            height: `${scale * 100}%`,
            opacity: active ? 1 : 0.15,
            animation: active
              ? `pulse ${0.3 + i * 0.07}s ease-in-out ${i * 0.04}s infinite alternate`
              : 'none',
          }}
        />
      ))}
    </div>
  );
}

// ─── Component ────────────────────────────────────────────────────────────────

export const NowSpeakingWidget = memo(function NowSpeakingWidget({ conf, now }) {
  const members = conf?.members || [];

  // Priority: explicit floor holder → first talking → null
  const floorMember   = members.find(m => m.floor)   ?? null;
  const firstTalking  = members.find(m => m.talking)  ?? null;
  const speaker       = floorMember || firstTalking   || null;

  const display   = speaker?.displayName || speaker?.callerNum || `#${speaker?.id}`;
  const ext       = speaker?.extension   || speaker?.callerNum || '';
  const isMod     = speaker?.moderator   ?? false;
  const isRec     = conf?.recordingState === 'ACTIVE';
  const floorSecs = speaker?.floor && conf?.floorGrantedAt
    ? elapsedSec(conf.floorGrantedAt, now)
    : null;
  const joinSecs  = speaker?.joinedAt ? elapsedSec(speaker.joinedAt, now) : null;

  const avatarColor = AVATAR_COLORS[Number(speaker?.id || 0) % AVATAR_COLORS.length];

  return (
    <div className="w-48 shrink-0 card !p-0 flex flex-col overflow-hidden">
      {/* Header */}
      <div className="flex items-center gap-2 px-3 py-2 border-b border-surface-border shrink-0">
        <Mic size={10} className="text-emerald-500 shrink-0" />
        <span className="text-[9px] font-bold uppercase tracking-widest text-text-muted flex-1">
          Floor
        </span>
        {speaker?.talking && (
          <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 animate-pulse shrink-0" />
        )}
        {isRec && (
          <Radio size={9} className="text-red-500 animate-pulse shrink-0" />
        )}
      </div>

      {speaker ? (
        <div className="flex-1 flex flex-col items-center gap-3 p-3 overflow-hidden">
          {/* Avatar */}
          <div className={[
            'w-12 h-12 rounded-xl flex items-center justify-center shrink-0',
            'text-sm font-bold',
            speaker.talking
              ? 'ring-2 ring-emerald-500/60 ring-offset-1 ring-offset-surface-card'
              : '',
            avatarColor,
          ].join(' ')}>
            {initials(display)}
          </div>

          {/* Name + role */}
          <div className="text-center w-full">
            <p className="text-xs font-bold text-text-primary truncate leading-tight">
              {display}
            </p>
            {ext && ext !== display && (
              <p className="text-[9px] font-mono text-text-muted mt-px truncate">{ext}</p>
            )}
            {isMod && (
              <span className="inline-block mt-1 text-[8px] px-1.5 py-px rounded-full
                               bg-amber-500/15 text-amber-500 font-bold">
                MOD
              </span>
            )}
          </div>

          {/* VU bars */}
          <VuBars active={speaker.talking} />

          {/* Floor / join stats */}
          <div className="w-full space-y-1">
            {floorSecs != null && (
              <div className="flex items-center justify-between">
                <span className="text-[8px] text-text-muted">Floor</span>
                <span className="text-[9px] font-mono tabular-nums text-purple-400">
                  {fmtDur(floorSecs)}
                </span>
              </div>
            )}
            {joinSecs != null && (
              <div className="flex items-center justify-between">
                <span className="text-[8px] text-text-muted">Joined</span>
                <span className="text-[9px] font-mono tabular-nums text-text-secondary">
                  {fmtDur(joinSecs)}
                </span>
              </div>
            )}
          </div>

          {/* Conference label */}
          {conf?.name && (
            <p className="text-[8px] font-mono text-text-muted/50 truncate w-full text-center mt-auto">
              {conf.name}
            </p>
          )}
        </div>
      ) : (
        /* No active speaker */
        <div className="flex-1 flex flex-col items-center justify-center gap-2 p-3">
          <div className="w-10 h-10 rounded-xl bg-surface-hover flex items-center justify-center">
            <Mic size={16} className="text-text-muted/25" />
          </div>
          <p className="text-[9px] text-text-muted text-center leading-relaxed">
            No active speaker
          </p>
        </div>
      )}
    </div>
  );
});
