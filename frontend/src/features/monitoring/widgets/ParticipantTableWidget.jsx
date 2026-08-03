/**
 * ParticipantTableWidget — enterprise conference participant table.
 *
 * Design principles (matches reference image):
 *  - Fixed 40 px row height — never grows regardless of audio state
 *  - Columns: # · Participant · Role · Mic · Talk Time · Audio Level · Status · Actions
 *  - Audio energy shown as horizontal bars (energy 0-100); bars animate when talking
 *  - Status: Speaking (green) / Listening (blue) / Muted (red) / Deaf (amber)
 *  - Search filter on display name / extension
 *  - Sort: speaking → connected → muted (stable within each group: moderators first)
 *  - All action controls always visible — no hover-reveal
 */
import { memo, useMemo, useState } from 'react';
import {
  Mic, MicOff, EarOff, Shield, Signal,
  PhoneOff, PhoneForwarded, Users, Search,
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

// ─── Horizontal audio energy bars ────────────────────────────────────────────
// Always rendered at fixed size. animationPlayState controls movement — no DOM changes.

function AudioLevel({ energy, talking }) {
  const filled = talking
    ? Math.max(3, Math.round((energy ?? 60) / 100 * 7))
    : Math.round((energy ?? 0) / 100 * 7);
  return (
    <div className="flex items-center gap-px" style={{ width: 50, height: 14 }}>
      {Array.from({ length: 7 }, (_, i) => (
        <div
          key={i}
          style={{
            flex: 1,
            height: 12,
            borderRadius: 2,
            backgroundColor: i < filled
              ? (talking ? '#22c55e' : '#6b7280')
              : 'rgba(107,114,128,0.12)',
            animationPlayState: (talking && i < filled) ? 'running' : 'paused',
            animation: `pulse ${0.22 + i * 0.07}s ease-in-out ${i * 0.04}s infinite alternate`,
          }}
        />
      ))}
    </div>
  );
}

// ─── Status chip ─────────────────────────────────────────────────────────────

function StatusChip({ talking, muted, deaf }) {
  if (talking) return (
    <span className="inline-flex items-center gap-1 text-[10px] font-medium text-green-500">
      <span className="w-1.5 h-1.5 rounded-full bg-green-500 animate-pulse shrink-0" />
      Speaking
    </span>
  );
  if (muted) return (
    <span className="inline-flex items-center gap-1 text-[10px] font-medium text-red-400">
      <span className="w-1.5 h-1.5 rounded-full bg-red-400 shrink-0" />
      Muted
    </span>
  );
  if (deaf) return (
    <span className="inline-flex items-center gap-1 text-[10px] font-medium text-amber-400">
      <span className="w-1.5 h-1.5 rounded-full bg-amber-400 shrink-0" />
      Deaf
    </span>
  );
  return (
    <span className="inline-flex items-center gap-1 text-[10px] font-medium text-text-muted">
      <span className="w-1.5 h-1.5 rounded-full bg-blue-400/40 shrink-0" />
      Listening
    </span>
  );
}

// ─── Participant row ──────────────────────────────────────────────────────────
// Row height is fixed at 40 px via style — never grows on audio events.

const ParticipantRow = memo(function ParticipantRow({ m, room, now, talkTracker, rowNum }) {
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

  const avatarColor = AVATAR_COLORS[Number(m.id) % AVATAR_COLORS.length];

  async function act(fn, ...args) {
    try { await fn(room, ...args); }
    catch (e) { console.error('[monitoring] action failed:', e.message); }
  }

  function transfer() {
    const dest = window.prompt(`Transfer ${display} to extension:`);
    if (dest?.trim()) act(api.monitoring.transfer, m.id, dest.trim());
  }

  const rowBg = m.talking ? 'bg-green-500/[0.03]'
              : m.muted   ? 'opacity-75'
              : '';

  return (
    <tr
      style={{ height: 40 }}  // ← FIXED row height — never changes
      className={`border-b border-surface-border/20 transition-colors ${rowBg} hover:bg-surface-hover/40`}
    >
      {/* Row number */}
      <td className="pl-3 pr-1 w-8 shrink-0 select-none">
        <span className="text-[10px] text-text-muted/30 tabular-nums">{rowNum}</span>
      </td>

      {/* Participant — avatar + name + extension */}
      <td className="px-2">
        <div className="flex items-center gap-2 overflow-hidden">
          <div className={[
            'w-7 h-7 rounded-lg flex items-center justify-center shrink-0 text-[10px] font-bold',
            avatarColor,
            m.talking ? 'ring-1 ring-green-500/50' : '',
          ].join(' ')}>
            {initials(display)}
          </div>
          <div className="min-w-0 overflow-hidden">
            <div className="text-[12px] font-medium text-text-primary truncate leading-tight">
              {display}
            </div>
            <div className="text-[10px] font-mono text-text-muted truncate leading-none">
              {ext || `#${m.id}`}
            </div>
          </div>
        </div>
      </td>

      {/* Role */}
      <td className="px-2 w-16 hidden sm:table-cell">
        {m.moderator ? (
          <span className="text-[9px] px-1.5 py-0.5 rounded bg-amber-500/12 text-amber-500 font-bold border border-amber-500/20">
            MOD
          </span>
        ) : m.floor ? (
          <span className="text-[9px] px-1.5 py-0.5 rounded bg-purple-500/12 text-purple-400 font-bold border border-purple-500/20">
            FLOOR
          </span>
        ) : null}
      </td>

      {/* Mic state */}
      <td className="px-2 w-8 text-center">
        {m.muted
          ? <MicOff size={13} className="text-red-400 mx-auto" />
          : <Mic    size={13} className="text-text-muted/25 mx-auto" />
        }
      </td>

      {/* Talk time + join time */}
      <td className="px-2 w-20 hidden md:table-cell">
        <div className="text-[10px] font-mono tabular-nums text-text-muted">
          {joinSecs != null ? fmtDur(joinSecs) : '—'}
        </div>
        {talkSecs > 0 && (
          <div className="text-[9px] font-mono tabular-nums text-green-500/70">{fmtDur(talkSecs)}</div>
        )}
      </td>

      {/* Audio level bars */}
      <td className="px-2 w-16 hidden lg:table-cell">
        <AudioLevel energy={m.energy} talking={m.talking} />
      </td>

      {/* Status */}
      <td className="px-2 w-24 hidden sm:table-cell">
        <StatusChip talking={m.talking} muted={m.muted} deaf={m.deaf} />
      </td>

      {/* Actions — compact icon buttons, always visible */}
      <td className="pr-3 pl-1 w-36">
        <div className="flex items-center gap-px">
          <button title={m.muted ? 'Unmute' : 'Mute'}
            onClick={() => act(m.muted ? api.monitoring.unmute : api.monitoring.mute, m.id)}
            className={['p-1.5 rounded transition-colors', m.muted ? 'bg-red-500/10 text-red-400 hover:bg-red-500/20' : 'text-text-muted/50 hover:text-text-primary hover:bg-surface-hover'].join(' ')}>
            {m.muted ? <MicOff size={13} /> : <Mic size={13} />}
          </button>
          <button title={m.deaf ? 'Undeaf' : 'Deaf'}
            onClick={() => act(m.deaf ? api.monitoring.undeaf : api.monitoring.deaf, m.id)}
            className={['p-1.5 rounded transition-colors', m.deaf ? 'bg-amber-500/10 text-amber-400 hover:bg-amber-500/20' : 'text-text-muted/50 hover:text-text-primary hover:bg-surface-hover'].join(' ')}>
            <EarOff size={13} />
          </button>
          <button title={m.moderator ? 'Demote' : 'Promote to moderator'}
            onClick={() => act(api.monitoring.promote, m.id)}
            className={['p-1.5 rounded transition-colors', m.moderator ? 'bg-amber-500/10 text-amber-400 hover:bg-amber-500/20' : 'text-text-muted/50 hover:text-amber-400 hover:bg-surface-hover'].join(' ')}>
            <Shield size={13} />
          </button>
          <button title={m.floor ? 'Release floor' : 'Give floor'}
            onClick={() => act(api.monitoring.floor, m.id)}
            className={['p-1.5 rounded transition-colors', m.floor ? 'bg-purple-500/10 text-purple-400 hover:bg-purple-500/20' : 'text-text-muted/50 hover:text-purple-400 hover:bg-surface-hover'].join(' ')}>
            <Signal size={13} />
          </button>
          <button title="Transfer" onClick={transfer}
            className="p-1.5 rounded text-text-muted/50 hover:text-blue-400 hover:bg-surface-hover transition-colors">
            <PhoneForwarded size={13} />
          </button>
          <button title="Volume +" onClick={() => act(api.monitoring.volume, m.id, 'in', 1)}
            className="p-1.5 rounded text-text-muted/50 hover:text-text-primary hover:bg-surface-hover transition-colors text-[8px] font-bold leading-none tabular-nums">
            V+
          </button>
          <button title="Volume −" onClick={() => act(api.monitoring.volume, m.id, 'in', -1)}
            className="p-1.5 rounded text-text-muted/50 hover:text-text-primary hover:bg-surface-hover transition-colors text-[8px] font-bold leading-none tabular-nums">
            V−
          </button>
          <button title="Kick participant"
            onClick={() => { if (window.confirm(`Kick ${display} from ${room}?`)) act(api.monitoring.kick, m.id); }}
            className="p-1.5 rounded text-text-muted/50 hover:text-red-500 hover:bg-red-500/10 transition-colors">
            <PhoneOff size={13} />
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
  const [search, setSearch] = useState('');
  const members = conf?.members || [];
  const room    = conf?.name    || '';

  // Sort: speaking → connected → muted; moderators first within each group
  const sorted = useMemo(() => {
    const statusOrder = m => m.talking ? 0 : m.muted ? 2 : m.deaf ? 1 : 1;
    const q = search.trim().toLowerCase();
    return [...members]
      .filter(m => {
        if (!q) return true;
        const name = (m.displayName || m.callerName || m.callerNum || '').toLowerCase();
        const ext  = (m.extension || m.callerNum || '').toLowerCase();
        return name.includes(q) || ext.includes(q);
      })
      .sort((a, b) => {
        const sd = statusOrder(a) - statusOrder(b);
        if (sd !== 0) return sd;
        return (b.moderator ? 1 : 0) - (a.moderator ? 1 : 0);
      });
  }, [members, search]);

  const liveCount  = members.filter(m => m.talking).length;
  const mutedCount = members.filter(m => m.muted).length;

  if (members.length === 0) {
    return (
      <div className="flex-1 flex flex-col items-center justify-center gap-2 text-center">
        <Users size={20} className="text-text-muted/20" />
        <p className="text-[11px] text-text-muted">No participants in this conference</p>
      </div>
    );
  }

  return (
    <div className="flex-1 flex flex-col min-w-0 overflow-hidden">

      {/* ── Sub-header: label + counters + search ───────────────────────── */}
      <div className="flex items-center gap-2 mb-2 shrink-0">
        <Users size={12} className="text-text-muted/50" />
        <span className="text-[11px] font-semibold text-text-primary">
          Participants
        </span>
        <span className="text-[10px] font-mono text-text-muted/50 tabular-nums">
          ({members.length})
        </span>

        {liveCount > 0 && (
          <span className="flex items-center gap-1 text-[10px] font-medium text-green-500">
            <span className="w-1.5 h-1.5 rounded-full bg-green-500 animate-pulse" />
            {liveCount} speaking
          </span>
        )}
        {mutedCount > 0 && (
          <span className="text-[10px] text-red-400/70">· {mutedCount} muted</span>
        )}

        {/* Search */}
        <div className="ml-auto flex items-center gap-1.5 border border-surface-border rounded-lg px-2 py-1
                        focus-within:border-primary/40 transition-colors bg-surface-card">
          <Search size={11} className="text-text-muted/40 shrink-0" />
          <input
            type="text"
            value={search}
            onChange={e => setSearch(e.target.value)}
            placeholder="Search…"
            className="text-[11px] bg-transparent text-text-primary placeholder:text-text-muted/40
                       outline-none w-28 min-w-0"
          />
        </div>
      </div>

      {/* ── Table ───────────────────────────────────────────────────────── */}
      <div className="card !p-0 overflow-hidden flex-1 min-h-0">
        <div className="overflow-auto h-full">
          <table className="w-full text-left border-collapse" style={{ minWidth: 640 }}>
            <thead>
              <tr className="border-b border-surface-border">
                {[
                  { label: '#',           cls: 'w-8  pl-3'                        },
                  { label: 'PARTICIPANT', cls: 'min-w-[160px]'                    },
                  { label: 'ROLE',        cls: 'w-16 hidden sm:table-cell'        },
                  { label: 'MIC',         cls: 'w-8  text-center'                 },
                  { label: 'TIME',        cls: 'w-20 hidden md:table-cell'        },
                  { label: 'AUDIO',       cls: 'w-16 hidden lg:table-cell'        },
                  { label: 'STATUS',      cls: 'w-24 hidden sm:table-cell'        },
                  { label: 'ACTIONS',     cls: 'w-36'                             },
                ].map(({ label, cls }) => (
                  <th key={label}
                      className={`px-2 py-2 text-[9px] font-bold uppercase tracking-wider
                                  text-text-muted/60 bg-surface-hover/30 whitespace-nowrap
                                  sticky top-0 z-10 ${cls}`}>
                    {label}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {sorted.length === 0 ? (
                <tr>
                  <td colSpan={8} className="py-10 text-center text-[11px] text-text-muted">
                    No participants match "{search}"
                  </td>
                </tr>
              ) : (
                sorted.map((m, idx) => (
                  <ParticipantRow
                    key={m.id}
                    m={m}
                    room={room}
                    now={now}
                    talkTracker={talkTracker}
                    rowNum={idx + 1}
                  />
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
});
