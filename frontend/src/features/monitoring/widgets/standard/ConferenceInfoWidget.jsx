/**
 * ConferenceInfoWidget — STANDARD conference top info card.
 *
 * Shows conference room name, duration, sample rate, flags and recording
 * state. Only rendered when confType === 'STANDARD'.
 */
import { memo } from 'react';
import { Hash, Clock, Radio, Lock, Unlock } from 'lucide-react';
import { elapsedSec, fmtDur, fmtTime } from '../../utils/time.js';

function kv(label, children) {
  return (
    <div className="flex items-center gap-2 py-0.5">
      <span className="text-[9px] text-text-muted w-24 shrink-0">{label}</span>
      <div className="text-[10px] font-medium text-text-primary flex-1">{children}</div>
    </div>
  );
}

export const ConferenceInfoWidget = memo(function ConferenceInfoWidget({ conf, now }) {
  if (!conf) return null;

  const secs     = elapsedSec(conf.createdAt, now);
  const count    = conf.members?.length ?? 0;
  const mods     = conf.members?.filter(m => m.moderator).length ?? 0;
  const live     = conf.members?.filter(m => m.talking).length  ?? 0;
  const isRec    = conf.recordingState === 'ACTIVE';
  const isLocked = conf.locked;

  return (
    <div className="card !p-3 shrink-0">
      <div className="flex items-start gap-4">
        {/* Left column */}
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 mb-1.5">
            <Hash size={11} className="text-primary shrink-0" />
            <span className="text-xs font-bold text-text-primary font-mono truncate">
              {conf.name}
            </span>
            {isRec && (
              <span className="text-[8px] px-1.5 py-px rounded-full bg-red-500/15 text-red-500
                               font-bold flex items-center gap-0.5 animate-pulse ml-1">
                <Radio size={7} /> REC
              </span>
            )}
            {isLocked && (
              <span className="text-[8px] px-1.5 py-px rounded-full bg-amber-500/15 text-amber-500
                               font-bold flex items-center gap-0.5">
                <Lock size={7} /> LOCKED
              </span>
            )}
            {!isLocked && (
              <span className="text-[8px] text-emerald-500 flex items-center gap-0.5 ml-1">
                <Unlock size={8} /> Open
              </span>
            )}
          </div>

          <div className="grid grid-cols-2 gap-x-6">
            {kv('Duration',
              <span className="font-mono tabular-nums">{fmtDur(secs)}</span>
            )}
            {kv('Participants',
              <span>
                {count}
                {mods > 0 && <span className="text-amber-500 ml-1.5 text-[9px]">{mods} mod{mods > 1 ? 's' : ''}</span>}
                {live > 0 && (
                  <span className="text-green-500 ml-1.5 text-[9px] flex items-center gap-0.5 inline-flex">
                    <span className="w-1 h-1 rounded-full bg-green-500 animate-pulse" />
                    {live} live
                  </span>
                )}
              </span>
            )}
            {kv('Sample Rate', conf.rate ? `${conf.rate} Hz` : '8000 Hz')}
            {kv('Created', <span className="font-mono">{fmtTime(conf.createdAt) || '—'}</span>)}
          </div>
        </div>

        {/* Flags */}
        <div className="shrink-0 flex flex-wrap gap-1 pt-1">
          {conf.isDynamic   && <span className="text-[9px] px-1.5 py-px rounded bg-blue-500/15 text-blue-400 font-bold">Dynamic</span>}
          {conf.isRunning   && <span className="text-[9px] px-1.5 py-px rounded bg-emerald-500/15 text-emerald-500 font-bold">Running</span>}
          {conf.isModerated && <span className="text-[9px] px-1.5 py-px rounded bg-purple-500/15 text-purple-400 font-bold">Moderated</span>}
          {!conf.isDynamic && !conf.isRunning && !conf.isModerated && (
            <span className="text-[9px] text-text-muted">Standard</span>
          )}
        </div>
      </div>
    </div>
  );
});
