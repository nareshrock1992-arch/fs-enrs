/**
 * NowSpeakingWidget — full-width horizontal banner pinned above the participant table.
 *
 * When someone holds the floor: shows avatar, name, animated VU bars, floor + join timers.
 * When idle: renders a compact single-line placeholder (~28 px tall).
 * Active speaker is identifiable within 1 second — no text reading required.
 */
import { memo } from 'react';
import { Mic } from 'lucide-react';
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

// ─── VU Bars — CSS-only, zero React re-renders on audio events ────────────────

function VuBars({ active }) {
  return (
    <div className="flex items-end gap-px" style={{ height: 28, width: 80 }}>
      {[0.4, 0.7, 1, 0.85, 0.6, 0.9, 0.5, 0.75, 0.65, 0.8].map((scale, i) => (
        <div
          key={i}
          className="flex-1 rounded-sm bg-emerald-500"
          style={{
            height: `${scale * 100}%`,
            opacity: active ? 1 : 0.12,
            animationPlayState: active ? 'running' : 'paused',
            animation: `pulse ${0.3 + i * 0.07}s ease-in-out ${i * 0.04}s infinite alternate`,
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
  const floorMember  = members.find(m => m.floor)  ?? null;
  const firstTalking = members.find(m => m.talking) ?? null;
  const speaker      = floorMember || firstTalking  || null;

  const isTalking = speaker?.talking ?? false;

  // Idle — compact single-line placeholder
  if (!speaker) {
    return (
      <div className="shrink-0 flex items-center gap-3 px-4 border-b border-surface-border"
           style={{ height: 32 }}>
        <Mic size={10} className="text-text-muted/30 shrink-0" />
        <span className="text-[9px] font-bold uppercase tracking-widest text-text-muted/30">
          Floor — no active speaker
        </span>
      </div>
    );
  }

  const display   = speaker.displayName || speaker.callerNum || `#${speaker.id}`;
  const ext       = speaker.extension   || speaker.callerNum || '';
  const isMod     = speaker.moderator   ?? false;
  const floorSecs = speaker.floor && conf?.floorGrantedAt
    ? elapsedSec(conf.floorGrantedAt, now) : null;
  const joinSecs  = speaker.joinedAt ? elapsedSec(speaker.joinedAt, now) : null;
  const avatarColor = AVATAR_COLORS[Number(speaker.id || 0) % AVATAR_COLORS.length];

  return (
    <div
      className={[
        'shrink-0 flex items-center gap-4 px-4 border-b transition-colors',
        isTalking
          ? 'bg-green-500/6 border-green-500/25'
          : 'bg-surface-hover/10 border-surface-border',
      ].join(' ')}
      style={{ height: 60 }}
    >
      {/* Label */}
      <div className="flex items-center gap-1.5 shrink-0">
        <Mic size={11} className={isTalking ? 'text-green-500' : 'text-text-muted/40'} />
        <span className={[
          'text-[8px] font-bold uppercase tracking-widest',
          isTalking ? 'text-green-500' : 'text-text-muted/40',
        ].join(' ')}>
          FLOOR
        </span>
        {isTalking && (
          <span className="w-1.5 h-1.5 rounded-full bg-green-500 animate-pulse" />
        )}
      </div>

      {/* Avatar */}
      <div className={[
        'w-9 h-9 rounded-lg flex items-center justify-center shrink-0 text-sm font-bold',
        avatarColor,
        isTalking ? 'ring-2 ring-green-500/60' : '',
      ].join(' ')}>
        {initials(display)}
      </div>

      {/* Name + sub-line */}
      <div className="min-w-0">
        <div className={[
          'text-sm font-bold truncate leading-tight',
          isTalking ? 'text-green-400' : 'text-text-primary',
        ].join(' ')}>
          {display}
        </div>
        <div className="flex items-center gap-2 mt-px">
          {ext && ext !== display && (
            <span className="text-[9px] font-mono text-text-muted">{ext}</span>
          )}
          {isMod && (
            <span className="text-[7px] px-1 py-px rounded bg-amber-500/15 text-amber-500 font-bold">
              MOD
            </span>
          )}
        </div>
      </div>

      {/* VU meter */}
      <VuBars active={isTalking} />

      {/* Timers — pinned to right */}
      <div className="ml-auto flex items-center gap-5 shrink-0">
        {floorSecs != null && (
          <div className="text-center">
            <div className="text-[7px] font-bold uppercase tracking-widest text-text-muted/50">Floor</div>
            <div className="text-[11px] font-mono tabular-nums text-purple-400">{fmtDur(floorSecs)}</div>
          </div>
        )}
        {joinSecs != null && (
          <div className="text-center">
            <div className="text-[7px] font-bold uppercase tracking-widest text-text-muted/50">Joined</div>
            <div className="text-[11px] font-mono tabular-nums text-text-secondary">{fmtDur(joinSecs)}</div>
          </div>
        )}
      </div>
    </div>
  );
});
