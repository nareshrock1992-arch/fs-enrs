/**
 * ParticipantTableWidget — grouped participant table.
 *
 * Participants are split into four sections for fast visual scanning:
 *   SPEAKING  → currently talking (green section header)
 *   CONNECTED → on call, not speaking
 *   MUTED     → mic muted
 *
 * All participant controls (mute, deaf, promote, floor, transfer, kick)
 * are wired to api.monitoring — same as the original CenterPanel table.
 *
 * Shared between ERS and STANDARD conference types.
 */
import { memo, useMemo } from 'react';
import {
  Mic, MicOff, EarOff, Shield, Signal,
  PhoneOff, PhoneForwarded, Users,
} from 'lucide-react';
import { api } from '../../../api/client.js';
import { elapsedSec, fmtDur } from '../utils/time.js';

// ─── Avatar ───────────────────────────────────────────────────────────────────

const AVATAR_COLORS = [
  'bg-blue-500/20 text-blue-400',
  'bg-emerald-500/20 text-emerald-400',
  'bg-purple-500/20 text-purple-400',
  'bg-amber-500/20 text-amber-500',
  'bg-rose-500/20 text-rose-400',
  'bg-cyan-500/20 text-cyan-400',
];

function initials(name) {
  if (!name) return '?';
  const words = name.replace(/[^a-zA-Z0-9\s]/g, '').trim().split(/\s+/).filter(Boolean);
  if (words.length >= 2) return (words[0][0] + words[1][0]).toUpperCase();
  if (words[0])          return words[0].slice(0, 2).toUpperCase();
  return '?';
}

function MemberAvatar({ id, name, talking }) {
  const color = AVATAR_COLORS[Number(id) % AVATAR_COLORS.length];
  return (
    <div className={[
      'w-7 h-7 rounded-lg flex items-center justify-center shrink-0 text-[10px] font-bold',
      color,
      talking ? 'ring-1 ring-emerald-500/60' : '',
    ].join(' ')}>
      {initials(name)}
    </div>
  );
}

function TalkingBars() {
  return (
    <div className="flex items-end gap-px h-3 shrink-0">
      {[1, 2, 3].map((_, i) => (
        <div key={i}
             className="w-px rounded-full bg-green-500"
             style={{
               height: `${(i + 1) * 4}px`,
               animation: `pulse 0.5s ease-in-out ${i * 0.12}s infinite alternate`,
             }} />
      ))}
    </div>
  );
}

// ─── Energy bar ───────────────────────────────────────────────────────────────

function EnergyBar({ energy }) {
  if (!energy) return null;
  return (
    <div className="flex items-end gap-px" title={`Energy: ${energy}`}>
      {[1, 2, 3, 4, 5].map(bar => (
        <div key={bar}
             className={`rounded-sm ${energy >= bar * 20 ? 'bg-emerald-500' : 'bg-surface-border'}`}
             style={{ width: 3, height: bar * 2 + 2 }} />
      ))}
    </div>
  );
}

// ─── Section header ───────────────────────────────────────────────────────────

function SectionHeader({ label, count, color = 'text-text-muted', stripe }) {
  if (count === 0) return null;
  return (
    <tr>
      <td colSpan={5}
          className={`px-2 pt-3 pb-1 text-[8px] font-bold uppercase tracking-widest ${color} select-none`}>
        <span
          className="inline-block w-1.5 h-1.5 rounded-full mr-1.5 align-middle"
          style={{ background: stripe }}
        />
        {label}
        <span className="ml-1.5 font-mono opacity-60">{count}</span>
      </td>
    </tr>
  );
}

// ─── Participant row ───────────────────────────────────────────────────────────

const ParticipantRow = memo(function ParticipantRow({ m, room, now, talkTracker }) {
  const display  = m.displayName || m.callerName || m.callerNum || `#${m.id}`;
  const ext      = m.extension   || m.callerNum  || '';
  const joinSecs = m.joinedAt ? elapsedSec(m.joinedAt, now) : null;

  const totalTalkMs = (() => {
    const key   = `${room}:${m.id}`;
    const entry = talkTracker?.current?.get(key);
    if (!entry) return 0;
    const live  = (m.talking && entry.startMs) ? (Date.now() - entry.startMs) : 0;
    return entry.totalMs + live;
  })();
  const talkSecs = Math.floor(totalTalkMs / 1000);

  async function act(fn, ...args) {
    try { await fn(room, ...args); }
    catch (e) { console.error('[monitoring] action failed:', e.message); }
  }

  function transfer() {
    const dest = window.prompt(`Transfer ${display} to extension:`);
    if (dest?.trim()) act(api.monitoring.transfer, m.id, dest.trim());
  }

  return (
    <tr className={[
      'border-b border-surface-border/25 transition-colors',
      m.talking ? 'bg-green-500/4' : 'hover:bg-surface-hover/50',
    ].join(' ')}>

      {/* Participant */}
      <td className="px-2 py-2">
        <div className="flex items-center gap-2 min-w-0">
          <MemberAvatar id={m.id} name={display} talking={m.talking} />
          <div className="min-w-0">
            <div className="flex items-center gap-1.5">
              {m.talking && <TalkingBars />}
              <span className="text-xs font-semibold text-text-primary truncate">{display}</span>
            </div>
            <span className="text-[9px] font-mono text-text-muted">{ext || `#${m.id}`}</span>
          </div>
        </div>
      </td>

      {/* Role badges */}
      <td className="px-2 py-2">
        <div className="flex items-center gap-1 flex-wrap">
          {m.moderator && (
            <span className="text-[9px] px-1.5 py-px rounded-full
                             bg-amber-500/15 text-amber-500 font-bold flex items-center gap-0.5">
              <Shield size={7} /> MOD
            </span>
          )}
          {m.floor && (
            <span className="text-[9px] px-1 py-px rounded bg-purple-500/15 text-purple-400 font-bold">
              FL
            </span>
          )}
          {!m.moderator && (
            <span className="text-[9px] px-1.5 py-px rounded-full bg-surface-hover text-text-muted">
              PART
            </span>
          )}
        </div>
      </td>

      {/* Audio state */}
      <td className="px-2 py-2">
        <div className="flex items-center gap-1">
          {m.muted ? (
            <span className="text-[9px] px-1.5 py-px rounded-full bg-red-500/15 text-red-500 font-bold flex items-center gap-0.5">
              <MicOff size={7} /> MUTED
            </span>
          ) : (
            <span className="text-[9px] text-emerald-500 font-medium flex items-center gap-0.5">
              <Mic size={8} /> ON
            </span>
          )}
          {m.deaf && (
            <span className="text-[9px] px-1 py-px rounded bg-orange-500/15 text-orange-500 font-bold flex items-center gap-0.5">
              <EarOff size={7} /> DEAF
            </span>
          )}
        </div>
      </td>

      {/* Joined / talk / energy */}
      <td className="px-2 py-2 hidden lg:table-cell">
        <div className="text-[9px] font-mono text-text-muted tabular-nums">
          {joinSecs != null ? fmtDur(joinSecs) : '—'}
        </div>
        {talkSecs > 0 && (
          <div className="text-[8px] font-mono text-green-500/70 tabular-nums flex items-center gap-0.5">
            <Mic size={7} /> {fmtDur(talkSecs)} talk
          </div>
        )}
        <EnergyBar energy={m.energy} />
      </td>

      {/* Actions */}
      <td className="px-2 py-2" style={{ minWidth: '148px' }}>
        <div className="flex items-center gap-0.5">
          <button
            title={m.muted ? 'Unmute' : 'Mute'}
            onClick={() => act(m.muted ? api.monitoring.unmute : api.monitoring.mute, m.id)}
            className={[
              'p-1.5 rounded-lg transition-colors',
              m.muted
                ? 'bg-red-500/10 text-red-400 hover:bg-red-500/20'
                : 'text-text-muted hover:bg-surface-hover hover:text-emerald-500',
            ].join(' ')}>
            {m.muted ? <MicOff size={11} /> : <Mic size={11} />}
          </button>

          <button
            title={m.deaf ? 'Undeaf' : 'Deaf'}
            onClick={() => act(m.deaf ? api.monitoring.undeaf : api.monitoring.deaf, m.id)}
            className={[
              'p-1.5 rounded-lg transition-colors',
              m.deaf
                ? 'bg-orange-500/10 text-orange-400 hover:bg-orange-500/20'
                : 'text-text-muted hover:bg-surface-hover hover:text-orange-400',
            ].join(' ')}>
            <EarOff size={11} />
          </button>

          <button
            title={m.moderator ? 'Remove moderator' : 'Promote to moderator'}
            onClick={() => act(api.monitoring.promote, m.id)}
            className={[
              'p-1.5 rounded-lg transition-colors',
              m.moderator
                ? 'bg-amber-500/10 text-amber-400 hover:bg-amber-500/20'
                : 'text-text-muted hover:bg-amber-500/10 hover:text-amber-400',
            ].join(' ')}>
            <Shield size={11} />
          </button>

          <button
            title={m.floor ? 'Release floor' : 'Give floor'}
            onClick={() => act(api.monitoring.floor, m.id)}
            className={[
              'p-1.5 rounded-lg transition-colors',
              m.floor
                ? 'bg-purple-500/10 text-purple-400 hover:bg-purple-500/20'
                : 'text-text-muted hover:bg-purple-500/10 hover:text-purple-400',
            ].join(' ')}>
            <Signal size={11} />
          </button>

          <button
            title="Transfer"
            onClick={transfer}
            className="p-1.5 rounded-lg text-text-muted hover:bg-blue-500/10 hover:text-blue-400 transition-colors">
            <PhoneForwarded size={11} />
          </button>

          <button
            title={`Copy: ${ext || m.id}`}
            onClick={() => navigator.clipboard?.writeText(ext || String(m.id))}
            className="p-1.5 rounded-lg text-text-muted hover:bg-surface-hover hover:text-text-primary transition-colors text-[8px] font-bold leading-none">
            #
          </button>

          <button title="Volume +"
            onClick={() => act(api.monitoring.volume, m.id, 'in', 1)}
            className="p-1.5 rounded-lg text-text-muted hover:bg-surface-hover hover:text-text-primary transition-colors text-[9px] font-bold leading-none">
            V+
          </button>
          <button title="Volume −"
            onClick={() => act(api.monitoring.volume, m.id, 'in', -1)}
            className="p-1.5 rounded-lg text-text-muted hover:bg-surface-hover hover:text-text-primary transition-colors text-[9px] font-bold leading-none">
            V−
          </button>

          <button
            title="Kick participant"
            onClick={() => {
              if (window.confirm(`Kick ${display} from ${room}?`))
                act(api.monitoring.kick, m.id);
            }}
            className="p-1.5 rounded-lg text-text-muted hover:bg-red-500/10 hover:text-red-500 transition-colors">
            <PhoneOff size={11} />
          </button>
        </div>
      </td>
    </tr>
  );
});

// ─── Main widget ──────────────────────────────────────────────────────────────

export const ParticipantTableWidget = memo(function ParticipantTableWidget({
  conf, now, talkTracker,
}) {
  const members = conf?.members || [];
  const room    = conf?.name    || '';

  // Group members into sections for fast visual scanning
  const { speaking, connected, muted } = useMemo(() => {
    const speaking   = [];
    const connected  = [];
    const muted      = [];
    for (const m of members) {
      if (m.talking)      speaking.push(m);
      else if (m.muted)   muted.push(m);
      else                connected.push(m);
    }
    // Within each section: moderators first
    const byMod = (a, b) => (b.moderator ? 1 : 0) - (a.moderator ? 1 : 0);
    speaking.sort(byMod);
    connected.sort(byMod);
    muted.sort(byMod);
    return { speaking, connected, muted };
  }, [members]);

  if (members.length === 0) {
    return (
      <div className="flex-1 flex flex-col items-center justify-center gap-2">
        <Users size={18} className="text-text-muted/25" />
        <p className="text-xs text-text-muted">No participants</p>
      </div>
    );
  }

  const liveCount = speaking.length;

  return (
    <div className="flex-1 flex flex-col min-w-0 overflow-hidden">
      {/* Sub-header */}
      <div className="flex items-center gap-2 mb-2 shrink-0 px-1">
        <Users size={11} className="text-blue-500" />
        <span className="text-xs font-bold text-text-primary">Participants</span>
        <span className="text-[10px] px-1.5 py-px rounded-full bg-blue-500/15 text-blue-400 font-bold ml-1">
          {members.length}
        </span>
        {liveCount > 0 && (
          <span className="text-[10px] px-1.5 py-px rounded-full bg-green-500/15 text-green-500 font-bold flex items-center gap-0.5">
            <span className="w-1 h-1 rounded-full bg-green-500 animate-pulse" />
            {liveCount} live
          </span>
        )}
      </div>

      <div className="card !p-0 overflow-hidden flex-1 min-h-0">
        <div className="overflow-auto h-full" style={{ minWidth: 0 }}>
          <table className="w-full text-left border-collapse" style={{ minWidth: '680px' }}>
            <thead>
              <tr>
                {['Participant', 'Role', 'Audio', 'Joined / Talk', 'Actions'].map(h => (
                  <th key={h}
                      className="px-2 py-2 text-[9px] font-bold uppercase tracking-wider
                                 text-text-muted bg-surface-hover/40 whitespace-nowrap
                                 border-b border-surface-border first:rounded-tl last:rounded-tr sticky top-0 z-10">
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              <SectionHeader
                label="Speaking" count={speaking.length}
                color="text-emerald-500" stripe="#22c55e" />
              {speaking.map(m => (
                <ParticipantRow key={m.id} m={m} room={room} now={now} talkTracker={talkTracker} />
              ))}

              <SectionHeader
                label="Connected" count={connected.length}
                color="text-blue-400" stripe="#60a5fa" />
              {connected.map(m => (
                <ParticipantRow key={m.id} m={m} room={room} now={now} talkTracker={talkTracker} />
              ))}

              <SectionHeader
                label="Muted" count={muted.length}
                color="text-text-muted" stripe="#6b7280" />
              {muted.map(m => (
                <ParticipantRow key={m.id} m={m} room={room} now={now} talkTracker={talkTracker} />
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
});
