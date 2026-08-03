/**
 * NowSpeakingWidget — fixed-height (56 px) banner above the participant table.
 *
 * Height NEVER changes regardless of speaker state.
 * Only the waveform bars animate — no container resizing occurs.
 */
import { memo } from 'react';
import { Mic } from 'lucide-react';
import { elapsedSec, fmtDur } from '../utils/time.js';

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

// CSS-only waveform — animationPlayState is the only toggle; height never changes
function WaveBars({ active }) {
  const heights = [5, 9, 14, 11, 7, 13, 6, 10, 12, 8];
  return (
    <div className="flex items-center gap-px shrink-0" style={{ width: 64, height: 20 }}>
      {heights.map((h, i) => (
        <div
          key={i}
          style={{
            flex: 1,
            height: h,
            borderRadius: 2,
            backgroundColor: active ? '#22c55e' : 'rgba(107,114,128,0.18)',
            animationPlayState: active ? 'running' : 'paused',
            animation: `pulse ${0.22 + i * 0.055}s ease-in-out ${i * 0.035}s infinite alternate`,
          }}
        />
      ))}
    </div>
  );
}

export const NowSpeakingWidget = memo(function NowSpeakingWidget({ conf, now }) {
  const members  = conf?.members || [];
  const speaker  = members.find(m => m.floor) ?? members.find(m => m.talking) ?? null;
  const isTalking = speaker?.talking ?? false;
  const display  = speaker ? (speaker.displayName || speaker.callerNum || `#${speaker.id}`) : null;
  const ext      = speaker ? (speaker.extension || speaker.callerNum || '') : null;
  const isMod    = speaker?.moderator ?? false;
  const floorSecs = (speaker?.floor && conf?.floorGrantedAt)
    ? elapsedSec(conf.floorGrantedAt, now) : null;
  const joinSecs  = speaker?.joinedAt ? elapsedSec(speaker.joinedAt, now) : null;
  const avatarColor = speaker
    ? AVATAR_COLORS[Number(speaker.id || 0) % AVATAR_COLORS.length]
    : '';

  return (
    // height: 56px — FIXED, never changes
    <div
      className={[
        'shrink-0 flex items-center gap-3 px-4 border-b border-surface-border',
        isTalking ? 'bg-green-500/[0.04]' : '',
      ].join(' ')}
      style={{ height: 56 }}
    >
      {/* Section label */}
      <div className="flex items-center gap-1.5 w-[90px] shrink-0">
        <Mic size={10} className={isTalking ? 'text-green-500' : 'text-text-muted/30'} />
        <span className={`text-[8px] font-bold uppercase tracking-widest ${isTalking ? 'text-green-500' : 'text-text-muted/30'}`}>
          Now Speaking
        </span>
      </div>

      {/* Avatar — always same size */}
      <div className={[
        'w-8 h-8 rounded-lg flex items-center justify-center shrink-0 text-[10px] font-bold',
        speaker ? avatarColor : 'bg-surface-hover text-text-muted/30',
        isTalking ? 'ring-2 ring-green-500/50' : '',
      ].join(' ')}>
        {display ? initials(display) : <Mic size={11} className="opacity-20" />}
      </div>

      {/* Name + ext — fills available space */}
      <div className="min-w-0 flex-1">
        {display ? (
          <>
            <div className={`text-[12px] font-semibold truncate leading-tight ${isTalking ? 'text-text-primary' : 'text-text-secondary'}`}>
              {display}
              {isMod && <span className="ml-1.5 text-[8px] px-1 py-px rounded bg-amber-500/15 text-amber-500 font-bold align-middle">MOD</span>}
            </div>
            {ext && ext !== display && (
              <div className="text-[10px] font-mono text-text-muted leading-none mt-px">{ext}</div>
            )}
          </>
        ) : (
          <div className="text-[11px] text-text-muted/30 italic">No active speaker</div>
        )}
      </div>

      {/* Waveform — always rendered, play state controls animation */}
      <WaveBars active={isTalking} />

      {/* Timers — fixed-width, right-aligned */}
      <div className="flex items-center gap-4 shrink-0">
        <div className="text-right w-12">
          {floorSecs != null ? (
            <>
              <div className="text-[7px] uppercase tracking-widest text-text-muted/40">Floor</div>
              <div className="text-[10px] font-mono tabular-nums text-purple-400">{fmtDur(floorSecs)}</div>
            </>
          ) : (
            <div className="text-[9px] text-text-muted/20">—</div>
          )}
        </div>
        <div className="text-right w-12">
          {joinSecs != null ? (
            <>
              <div className="text-[7px] uppercase tracking-widest text-text-muted/40">Joined</div>
              <div className="text-[10px] font-mono tabular-nums text-text-muted">{fmtDur(joinSecs)}</div>
            </>
          ) : (
            <div className="text-[9px] text-text-muted/20">—</div>
          )}
        </div>
      </div>
    </div>
  );
});
