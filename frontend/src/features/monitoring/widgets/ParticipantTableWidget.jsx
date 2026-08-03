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
      'w-6 h-6 rounded flex items-center justify-center shrink-0 text-[9px] font-bold',
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

// ─── Section divider — minimal: 1px rule + label ─────────────────────────────

function SectionHeader({ label, count, stripe }) {
  if (count === 0) return null;
  return (
    <tr>
      <td colSpan={4}
          className="px-2 pt-2 pb-0.5 text-[7px] font-bold uppercase tracking-widest select-none"
          style={{ color: stripe, opacity: 0.7 }}>
        {label}
        <span className="ml-1.5 font-mono opacity-60">{count}</span>
      </td>
    </tr>
  );
}

// ─── Participant row — dense, color-coded left border ─────────────────────────
//
// status: 'speaking' | 'connected' | 'muted'
// Left border color is the primary status signal — readable at a glance.

const STATUS_BORDER = {
  speaking:  '#22c55e',
  connected: '#3b82f6',
  muted:     '#6b7280',
};

const ParticipantRow = memo(function ParticipantRow({ m, room, now, talkTracker, status }) {
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

  const borderColor = STATUS_BORDER[status] ?? STATUS_BORDER.connected;
  const rowBg = status === 'speaking'
    ? 'bg-green-500/5'
    : status === 'muted'
      ? 'opacity-80'
      : '';

  return (
    <tr
      style={{ borderLeft: `3px solid ${borderColor}` }}
      className={`border-b border-surface-border/20 transition-colors ${rowBg} hover:bg-surface-hover/40`}
    >
      {/* Participant — avatar + name + ext */}
      <td className="pl-2 pr-1 py-1">
        <div className="flex items-center gap-1.5 min-w-0">
          <MemberAvatar id={m.id} name={display} talking={m.talking} />
          <div className="min-w-0">
            <div className="flex items-center gap-1">
              {m.talking && <TalkingBars />}
              <span className="text-[10px] font-semibold text-text-primary truncate">{display}</span>
            </div>
            <span className="text-[8px] font-mono text-text-muted">{ext || `#${m.id}`}</span>
          </div>
        </div>
      </td>

      {/* Status badges — role + audio in one compact column */}
      <td className="px-1 py-1">
        <div className="flex items-center gap-0.5 flex-wrap">
          {m.moderator && (
            <span className="text-[7px] px-1 py-px rounded bg-amber-500/15 text-amber-500 font-bold">MOD</span>
          )}
          {m.floor && (
            <span className="text-[7px] px-1 py-px rounded bg-purple-500/15 text-purple-400 font-bold">FL</span>
          )}
          {m.muted && (
            <span className="text-[7px] px-1 py-px rounded bg-red-500/15 text-red-400 font-bold">MUT</span>
          )}
          {m.deaf && (
            <span className="text-[7px] px-1 py-px rounded bg-orange-500/15 text-orange-400 font-bold">DEF</span>
          )}
        </div>
      </td>

      {/* Duration — joined + talk time */}
      <td className="px-1 py-1 hidden lg:table-cell whitespace-nowrap">
        <div className="text-[8px] font-mono text-text-muted tabular-nums">
          {joinSecs != null ? fmtDur(joinSecs) : '—'}
        </div>
        {talkSecs > 0 && (
          <div className="text-[7px] font-mono text-green-500/70 tabular-nums">{fmtDur(talkSecs)}</div>
        )}
      </td>

      {/* Actions — always visible, compact icon buttons */}
      <td className="px-1 py-1" style={{ minWidth: 132 }}>
        <div className="flex items-center gap-px">
          <button title={m.muted ? 'Unmute' : 'Mute'}
            onClick={() => act(m.muted ? api.monitoring.unmute : api.monitoring.mute, m.id)}
            className={['p-1 rounded transition-colors', m.muted ? 'bg-red-500/10 text-red-400 hover:bg-red-500/20' : 'text-text-muted hover:text-emerald-500 hover:bg-surface-hover'].join(' ')}>
            {m.muted ? <MicOff size={10} /> : <Mic size={10} />}
          </button>
          <button title={m.deaf ? 'Undeaf' : 'Deaf'}
            onClick={() => act(m.deaf ? api.monitoring.undeaf : api.monitoring.deaf, m.id)}
            className={['p-1 rounded transition-colors', m.deaf ? 'bg-orange-500/10 text-orange-400 hover:bg-orange-500/20' : 'text-text-muted hover:text-orange-400 hover:bg-surface-hover'].join(' ')}>
            <EarOff size={10} />
          </button>
          <button title={m.moderator ? 'Demote' : 'Promote to MOD'}
            onClick={() => act(api.monitoring.promote, m.id)}
            className={['p-1 rounded transition-colors', m.moderator ? 'bg-amber-500/10 text-amber-400 hover:bg-amber-500/20' : 'text-text-muted hover:text-amber-400 hover:bg-surface-hover'].join(' ')}>
            <Shield size={10} />
          </button>
          <button title={m.floor ? 'Release floor' : 'Give floor'}
            onClick={() => act(api.monitoring.floor, m.id)}
            className={['p-1 rounded transition-colors', m.floor ? 'bg-purple-500/10 text-purple-400 hover:bg-purple-500/20' : 'text-text-muted hover:text-purple-400 hover:bg-surface-hover'].join(' ')}>
            <Signal size={10} />
          </button>
          <button title="Transfer" onClick={transfer}
            className="p-1 rounded text-text-muted hover:text-blue-400 hover:bg-surface-hover transition-colors">
            <PhoneForwarded size={10} />
          </button>
          <button title={`Copy ext: ${ext || m.id}`}
            onClick={() => navigator.clipboard?.writeText(ext || String(m.id))}
            className="p-1 rounded text-text-muted hover:text-text-primary hover:bg-surface-hover transition-colors text-[7px] font-bold leading-none">
            #
          </button>
          <button title="Volume +" onClick={() => act(api.monitoring.volume, m.id, 'in', 1)}
            className="p-1 rounded text-text-muted hover:text-text-primary hover:bg-surface-hover transition-colors text-[7px] font-bold leading-none">V+</button>
          <button title="Volume −" onClick={() => act(api.monitoring.volume, m.id, 'in', -1)}
            className="p-1 rounded text-text-muted hover:text-text-primary hover:bg-surface-hover transition-colors text-[7px] font-bold leading-none">V−</button>
          <button title="Kick"
            onClick={() => { if (window.confirm(`Kick ${display} from ${room}?`)) act(api.monitoring.kick, m.id); }}
            className="p-1 rounded text-text-muted hover:text-red-500 hover:bg-red-500/10 transition-colors">
            <PhoneOff size={10} />
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
          <table className="w-full text-left border-collapse" style={{ minWidth: '560px' }}>
            <thead>
              <tr>
                {['Participant', 'Status', 'Time', 'Actions'].map(h => (
                  <th key={h}
                      className="px-2 py-1.5 text-[8px] font-bold uppercase tracking-wider
                                 text-text-muted bg-surface-hover/40 whitespace-nowrap
                                 border-b border-surface-border sticky top-0 z-10">
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              <SectionHeader label="Speaking"  count={speaking.length}  stripe="#22c55e" />
              {speaking.map(m => (
                <ParticipantRow key={m.id} m={m} room={room} now={now} talkTracker={talkTracker} status="speaking" />
              ))}

              <SectionHeader label="Connected" count={connected.length} stripe="#3b82f6" />
              {connected.map(m => (
                <ParticipantRow key={m.id} m={m} room={room} now={now} talkTracker={talkTracker} status="connected" />
              ))}

              <SectionHeader label="Muted"     count={muted.length}     stripe="#6b7280" />
              {muted.map(m => (
                <ParticipantRow key={m.id} m={m} room={room} now={now} talkTracker={talkTracker} status="muted" />
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
});
