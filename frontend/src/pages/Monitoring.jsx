/**
 * Conference Operations Center — Enterprise NOC Dashboard
 */
import {
  useEffect, useState, useCallback, useRef, useMemo, memo,
} from 'react';
import {
  Activity, Wifi, WifiOff, Users, Lock, Unlock,
  Mic, MicOff, PhoneOff, Radio, Square,
  PhoneIncoming, Trash2, ChevronDown,
  Headphones, EarOff, Shield, RefreshCw, Zap,
  PhoneCall, Bell, Signal, ArrowRight,
  Monitor, BarChart2, Hash, PhoneForwarded,
  CheckCircle, AlertCircle, Circle,
} from 'lucide-react';
import { api } from '../api/client.js';
import { socket } from '../api/socket.js';
import { IncidentSidebar } from '../features/monitoring/sidebar/IncidentSidebar.jsx';

// ─────────────────────────────────────────────────────────────────────────────
const MAX_EVENTS        = 120;
const CHART_INTERVAL_MS = 10_000;
const MAX_CHART_POINTS  = 60;

const EV = {
  'conference.created':        { label: 'Conference Created',  color: 'text-emerald-500', Icon: PhoneCall     },
  'conference.ended':          { label: 'Conference Ended',    color: 'text-slate-400',   Icon: PhoneOff      },
  'conference.member.joined':  { label: 'Member Joined',       color: 'text-blue-500',    Icon: PhoneIncoming },
  'conference.member.left':    { label: 'Member Left',         color: 'text-orange-400',  Icon: PhoneOff      },
  'conference.member.muted':   { label: 'Mute Changed',        color: 'text-yellow-500',  Icon: MicOff        },
  'conference.member.deaf':    { label: 'Deaf Changed',        color: 'text-orange-500',  Icon: EarOff        },
  'conference.member.talking': { label: 'Speaking',            color: 'text-green-400',   Icon: Mic           },
  'conference.floor.changed':  { label: 'Floor Changed',       color: 'text-purple-400',  Icon: Shield        },
  'conference.locked':         { label: 'Lock Changed',        color: 'text-amber-500',   Icon: Lock          },
  'conference.recording':      { label: 'Recording',           color: 'text-red-400',     Icon: Radio         },
};

// ─────────────────────────────────────────────────────────────────────────────
function elapsedSec(isoStart, now = Date.now()) {
  if (!isoStart) return 0;
  return Math.max(0, Math.floor((now - new Date(isoStart)) / 1000));
}
function fmtDur(secs) {
  if (secs < 60)   return `${secs}s`;
  if (secs < 3600) return `${Math.floor(secs / 60)}m ${secs % 60}s`;
  return `${Math.floor(secs / 3600)}h ${Math.floor((secs % 3600) / 60)}m`;
}
function fmtTime(iso) {
  if (!iso) return '';
  return new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

// ─────────────────────────────────────────────────────────────────────────────
// Toggle Switch — replaces dual-button lock/mute patterns
// ─────────────────────────────────────────────────────────────────────────────
function ToggleSwitch({ checked, onChange, disabled, labelOn, labelOff, colorOn = 'bg-brand', Icon }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      disabled={disabled}
      onClick={onChange}
      className={[
        'group flex items-center gap-2.5 w-full px-3 py-2.5 rounded-xl border text-xs font-medium',
        'transition-all duration-150 select-none',
        disabled
          ? 'opacity-35 cursor-not-allowed border-surface-border text-text-muted'
          : checked
            ? 'border-brand/40 bg-brand/8 text-brand'
            : 'border-surface-border text-text-secondary hover:border-primary/20 hover:bg-surface-hover',
      ].join(' ')}
    >
      {Icon && <Icon size={13} className="shrink-0" />}
      <span className="flex-1 text-left">{checked ? labelOn : labelOff}</span>
      {/* Pill toggle */}
      <span
        className={[
          'relative inline-flex h-4 w-7 shrink-0 rounded-full border-2 border-transparent',
          'transition-colors duration-200',
          disabled ? 'bg-surface-border' : checked ? colorOn : 'bg-surface-border',
        ].join(' ')}
      >
        <span
          className={[
            'pointer-events-none h-3 w-3 rounded-full bg-white shadow-sm',
            'transition-transform duration-200',
            checked ? 'translate-x-3' : 'translate-x-0',
          ].join(' ')}
        />
      </span>
    </button>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
const Sparkline = memo(function Sparkline({ data = [], color = '#22c55e', height = 40 }) {
  if (data.length < 2) return <svg width="100%" height={height} />;
  const W = 200, H = height;
  const mx = Math.max(...data, 1);
  const step = W / (data.length - 1);
  const pts = data.map((v, i) => [i * step, H - (v / mx) * H * 0.85 - H * 0.05]);
  const line = pts.map(([x, y], i) => `${i ? 'L' : 'M'}${x.toFixed(1)},${y.toFixed(1)}`).join('');
  const area = `${line}L${pts.at(-1)[0]},${H}L0,${H}Z`;
  return (
    <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" width="100%" height={height}>
      <path d={area} fill={color} fillOpacity="0.10" />
      <path d={line} fill="none" stroke={color} strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
      <circle cx={pts.at(-1)[0]} cy={pts.at(-1)[1]} r="2.5" fill={color} />
    </svg>
  );
});

// ─────────────────────────────────────────────────────────────────────────────
const KpiCard = memo(function KpiCard({
  icon: Icon, label, value, sub,
  valueClass = 'text-text-primary',
  sparkData, sparkColor,
  pulse = false, danger = false,
}) {
  const isDanger = danger && value > 0;
  return (
    <div className={`card !p-3 relative overflow-hidden flex flex-col gap-0.5
      ${isDanger ? 'border-red-500/30 bg-red-500/5' : ''}`}>
      <div className="flex items-center justify-between">
        <span className={`text-[10px] uppercase tracking-widest font-semibold
          ${isDanger ? 'text-red-400' : 'text-text-muted'}`}>
          <Icon size={10} className="inline mr-1 -mt-px" />
          {label}
        </span>
        {pulse && value > 0 && (
          <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 animate-pulse" />
        )}
      </div>
      <div className={`text-2xl font-bold tabular-nums leading-none mt-0.5
        ${isDanger ? 'text-red-500' : valueClass}`}>
        {value ?? '—'}
      </div>
      {sub && <p className="text-[10px] text-text-muted leading-none">{sub}</p>}
      {sparkData && sparkData.length > 1 && (
        <div className="absolute bottom-0 left-0 right-0 opacity-40 pointer-events-none">
          <Sparkline data={sparkData} color={sparkColor || '#22c55e'} height={26} />
        </div>
      )}
    </div>
  );
});

// ─────────────────────────────────────────────────────────────────────────────
// LEFT PANEL — Conference Cards
// ─────────────────────────────────────────────────────────────────────────────
const ConfCard = memo(function ConfCard({ conf, selected, onSelect, now }) {
  const secs  = elapsedSec(conf.createdAt, now);
  const count = conf.members?.length ?? 0;
  const mods  = conf.members?.filter(m => m.moderator).length ?? 0;
  const live  = conf.members?.filter(m => m.talking).length  ?? 0;

  return (
    <button
      onClick={() => onSelect(conf.name)}
      className={[
        'w-full text-left rounded-xl border p-3 transition-all duration-150 cursor-pointer',
        selected
          ? 'border-primary/50 bg-primary/8 shadow-sm'
          : 'border-surface-border bg-surface-card hover:border-primary/20 hover:bg-surface-hover',
      ].join(' ')}
    >
      <div className="flex items-start gap-2 mb-2">
        <div className="flex-1 min-w-0">
          <p className="text-sm font-bold font-mono text-text-primary leading-none truncate">
            {conf.name}
          </p>
          {conf.incident?.organization_name && (
            <p className="text-[10px] text-text-muted mt-0.5 truncate">
              {conf.incident.organization_name}
            </p>
          )}
          {conf.incident?.ers_name && (
            <p className="text-[10px] text-primary/80 mt-0.5 truncate font-medium">
              {conf.incident.ers_name}
            </p>
          )}
        </div>
        <div className="flex flex-col items-end gap-1 shrink-0">
          {conf.recordingState === 'STARTING' && (
            <span className="text-[8px] px-1.5 py-px rounded-full bg-amber-500/15 text-amber-500
                             font-bold flex items-center gap-0.5 animate-pulse">
              <Radio size={6} /> START
            </span>
          )}
          {conf.recordingState === 'ACTIVE' && (
            <span className="text-[8px] px-1.5 py-px rounded-full bg-red-500/15 text-red-500
                             font-bold flex items-center gap-0.5 animate-pulse">
              <Radio size={6} /> REC
            </span>
          )}
          {conf.recordingState === 'STOPPING' && (
            <span className="text-[8px] px-1.5 py-px rounded-full bg-slate-500/15 text-slate-400
                             font-bold flex items-center gap-0.5 animate-pulse">
              <Square size={6} /> STOP
            </span>
          )}
          {conf.locked && (
            <span className="text-[8px] px-1.5 py-px rounded-full bg-amber-500/15 text-amber-500
                             font-bold flex items-center gap-0.5">
              <Lock size={6} /> LOCK
            </span>
          )}
        </div>
      </div>

      <div className="flex items-center gap-2 text-[10px]">
        <span className={`flex items-center gap-1 font-semibold
          ${live > 0 ? 'text-green-500' : 'text-text-secondary'}`}>
          <span className={`w-1.5 h-1.5 rounded-full shrink-0
            ${live > 0 ? 'bg-green-500 animate-pulse' : 'bg-text-muted/30'}`} />
          {count} {count === 1 ? 'member' : 'members'}
        </span>
        {mods > 0 && (
          <span className="flex items-center gap-0.5 text-amber-500">
            <Shield size={8} /> {mods}
          </span>
        )}
        {live > 0 && (
          <span className="flex items-center gap-0.5 text-green-500">
            <Mic size={8} /> {live}
          </span>
        )}
        <span className="ml-auto font-mono text-text-muted tabular-nums">
          {fmtDur(secs)}
        </span>
      </div>
    </button>
  );
});

function LeftPanel({ conferences, selectedConf, onSelect, now, loading }) {
  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center gap-2 mb-2.5 shrink-0">
        <PhoneCall size={12} className="text-emerald-500" />
        <span className="text-xs font-bold text-text-primary">Active Conferences</span>
        <span className="ml-1 text-[10px] px-1.5 py-px rounded-full
                         bg-emerald-500/15 text-emerald-500 font-bold">
          {conferences.length}
        </span>
      </div>

      <div className="flex-1 overflow-y-auto space-y-2 pr-0.5">
        {loading ? (
          <div className="space-y-2">
            {[1, 2, 3].map(i => (
              <div key={i} className="h-20 rounded-xl bg-surface-hover animate-pulse" />
            ))}
          </div>
        ) : conferences.length === 0 ? (
          <div className="flex flex-col items-center gap-3 py-12 text-center">
            <Headphones size={22} className="text-text-muted/25" />
            <div>
              <p className="text-xs font-medium text-text-secondary">No Active Conferences</p>
              <p className="text-[10px] text-text-muted mt-0.5">Waiting for FreeSWITCH…</p>
            </div>
            <span className="w-2 h-2 rounded-full bg-emerald-500 animate-pulse" />
          </div>
        ) : (
          conferences.map(c => (
            <ConfCard
              key={c.name}
              conf={c}
              selected={selectedConf === c.name}
              onSelect={onSelect}
              now={now}
            />
          ))
        )}
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// CENTER PANEL — Conference Details + Participant Table
// ─────────────────────────────────────────────────────────────────────────────
function MetaItem({ label, children, span }) {
  return (
    <div className={`flex items-start gap-2 py-1.5 border-b border-surface-border/30 last:border-0 ${span ? 'col-span-2' : ''}`}>
      <span className="text-[10px] text-text-muted w-24 shrink-0 pt-px">{label}</span>
      <div className="text-[11px] font-medium text-text-primary flex-1">{children}</div>
    </div>
  );
}

// Talking bars animation
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

// Derive 1-2 initials from a display name or number for the avatar.
function initials(name) {
  if (!name) return '?';
  const clean = name.replace(/[^a-zA-Z0-9\s]/g, '').trim();
  const words = clean.split(/\s+/).filter(Boolean);
  if (words.length >= 2) return (words[0][0] + words[1][0]).toUpperCase();
  if (words.length === 1) return words[0].slice(0, 2).toUpperCase();
  return '?';
}

// Avatar colors cycle by member id so each participant has a consistent color.
const AVATAR_COLORS = [
  'bg-blue-500/20 text-blue-400',
  'bg-emerald-500/20 text-emerald-400',
  'bg-purple-500/20 text-purple-400',
  'bg-amber-500/20 text-amber-500',
  'bg-rose-500/20 text-rose-400',
  'bg-cyan-500/20 text-cyan-400',
];

function MemberAvatar({ id, name, talking }) {
  const color = AVATAR_COLORS[Number(id) % AVATAR_COLORS.length];
  return (
    <div className={[
      'w-7 h-7 rounded-lg flex items-center justify-center shrink-0 text-[10px] font-bold',
      color,
      talking ? 'ring-1 ring-green-500/60' : '',
    ].join(' ')}>
      {initials(name)}
    </div>
  );
}

function ParticipantRow({ m, room, now }) {
  const display  = m.displayName || m.callerName || m.callerNum || `#${m.id}`;
  const ext      = m.extension   || m.callerNum  || '';
  const joinSecs = m.joinedAt ? elapsedSec(m.joinedAt, now) : null;

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

      {/* Participant — avatar + name + extension + talking bars */}
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

      {/* Role */}
      <td className="px-2 py-2">
        <div className="flex items-center gap-1">
          {m.moderator ? (
            <span className="text-[9px] px-1.5 py-px rounded-full
                             bg-amber-500/15 text-amber-500 font-bold flex items-center gap-0.5">
              <Shield size={7} /> MOD
            </span>
          ) : (
            <span className="text-[9px] px-1.5 py-px rounded-full bg-surface-hover text-text-muted">
              PART
            </span>
          )}
          {m.floor && (
            <span className="text-[9px] px-1 py-px rounded bg-purple-500/15 text-purple-400 font-bold">FL</span>
          )}
        </div>
      </td>

      {/* Audio — muted / deaf / on */}
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

      {/* Joined — duration since join */}
      <td className="px-2 py-2 hidden lg:table-cell">
        <div className="text-[9px] font-mono text-text-muted tabular-nums">
          {joinSecs != null ? fmtDur(joinSecs) : '—'}
        </div>
        <div className="text-[8px] text-text-muted/50 tabular-nums">
          {m.energy ? `⚡${m.energy}` : ''}
        </div>
      </td>

      {/* Actions */}
      <td className="px-2 py-2" style={{ minWidth: '148px' }}>
        <div className="flex items-center gap-0.5">
          {/* Mic toggle — state comes ONLY from socket events (xml_list verified) */}
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

          {/* Deaf toggle */}
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

          {/* Give floor */}
          <button
            title="Give floor"
            onClick={() => act(api.monitoring.floor, m.id)}
            className="p-1.5 rounded-lg text-text-muted hover:bg-purple-500/10 hover:text-purple-400 transition-colors">
            <Shield size={11} />
          </button>

          {/* Transfer */}
          <button
            title="Transfer"
            onClick={transfer}
            className="p-1.5 rounded-lg text-text-muted hover:bg-blue-500/10 hover:text-blue-400 transition-colors">
            <PhoneForwarded size={11} />
          </button>

          {/* Volume */}
          <button
            title="Volume +"
            onClick={() => act(api.monitoring.volume, m.id, 'in', 1)}
            className="p-1.5 rounded-lg text-text-muted hover:bg-surface-hover hover:text-text-primary transition-colors text-[9px] font-bold leading-none">
            V+
          </button>
          <button
            title="Volume −"
            onClick={() => act(api.monitoring.volume, m.id, 'in', -1)}
            className="p-1.5 rounded-lg text-text-muted hover:bg-surface-hover hover:text-text-primary transition-colors text-[9px] font-bold leading-none">
            V−
          </button>

          {/* Kick */}
          <button
            title="Kick participant"
            onClick={() => {
              if (window.confirm(`Kick ${display} from ${room}?`)) {
                act(api.monitoring.kick, m.id);
              }
            }}
            className="p-1.5 rounded-lg text-text-muted hover:bg-red-500/10 hover:text-red-500 transition-colors">
            <PhoneOff size={11} />
          </button>
        </div>
      </td>
    </tr>
  );
}

function ParticipantTable({ members, room, now }) {
  const sorted = useMemo(() => [...members].sort((a, b) => {
    if (a.moderator !== b.moderator) return a.moderator ? -1 : 1;
    if (a.talking   !== b.talking)   return a.talking   ? -1 : 1;
    return 0;
  }), [members]);

  if (sorted.length === 0) {
    return (
      <div className="flex flex-col items-center gap-2 py-8">
        <Users size={18} className="text-text-muted/25" />
        <p className="text-xs text-text-muted">No participants</p>
      </div>
    );
  }

  return (
    <div className="overflow-x-auto">
      <table className="w-full text-left border-collapse" style={{ minWidth: '640px' }}>
        <thead>
          <tr>
            {['Participant', 'Role', 'Audio', 'Joined', 'Actions'].map(h => (
              <th key={h}
                  className="px-2 py-2 text-[9px] font-bold uppercase tracking-wider
                             text-text-muted bg-surface-hover/40 whitespace-nowrap
                             border-b border-surface-border first:rounded-tl last:rounded-tr">
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {sorted.map(m => (
            <ParticipantRow key={m.id} m={m} room={room} now={now} />
          ))}
        </tbody>
      </table>
    </div>
  );
}

function CenterPanel({ conf, now }) {
  if (!conf) {
    return (
      <div className="h-full flex flex-col items-center justify-center gap-4 text-center px-6">
        <div className="w-16 h-16 rounded-2xl bg-surface-hover flex items-center justify-center">
          <Monitor size={26} className="text-text-muted/30" />
        </div>
        <div>
          <p className="text-sm font-semibold text-text-secondary">Select a Conference</p>
          <p className="text-xs text-text-muted mt-1 leading-relaxed">
            Click a conference card to view participants and details
          </p>
        </div>
      </div>
    );
  }

  const secs  = elapsedSec(conf.createdAt, now);
  const count = conf.members?.length ?? 0;
  const mods  = conf.members?.filter(m => m.moderator).length ?? 0;
  const live  = conf.members?.filter(m => m.talking).length  ?? 0;

  return (
    <div className="h-full flex flex-col gap-4 overflow-y-auto">
      {/* Conference metadata */}
      <div>
        <div className="flex items-center gap-2 mb-2 shrink-0">
          <Hash size={11} className="text-primary" />
          <span className="text-xs font-bold text-text-primary">Conference Details</span>
          <span className="text-xs font-mono text-text-muted ml-1">— {conf.name}</span>
        </div>
        <div className="card !p-3 grid grid-cols-2 gap-x-6">
          <div>
            <MetaItem label="Conference ID">
              <span className="font-mono">{conf.name}</span>
            </MetaItem>
            <MetaItem label="Duration">
              <span className="font-mono tabular-nums">{fmtDur(secs)}</span>
            </MetaItem>
            <MetaItem label="Participants">
              <div className="flex items-center gap-2">
                <span>{count}</span>
                {mods > 0 && <span className="text-[9px] text-amber-500">{mods} mod{mods > 1 ? 's' : ''}</span>}
                {live > 0 && (
                  <span className="flex items-center gap-0.5 text-[9px] text-green-500">
                    <span className="w-1 h-1 rounded-full bg-green-500 animate-pulse" /> {live} speaking
                  </span>
                )}
              </div>
            </MetaItem>
            <MetaItem label="Sample Rate">
              {conf.rate ? `${conf.rate} Hz` : '8000 Hz'}
            </MetaItem>
          </div>
            {conf.incident?.primary_bridge_number && (
              <MetaItem label="Bridge Number">
                <span className="font-mono">{conf.incident.primary_bridge_number}</span>
              </MetaItem>
            )}
            {conf.incident?.incident_uuid && (
              <MetaItem label="Incident UUID">
                <span className="font-mono text-[10px] break-all">{conf.incident.incident_uuid}</span>
              </MetaItem>
            )}
            <MetaItem label="Created">
              <span className="font-mono tabular-nums">{conf.createdAt ? fmtTime(conf.createdAt) : '—'}</span>
            </MetaItem>
          </div>
          <div>
            <MetaItem label="Recording">
              {conf.recordingState === 'STARTING' ? (
                <span className="flex items-center gap-1 text-[10px] px-1.5 py-px rounded-full
                                 bg-amber-500/15 text-amber-500 font-bold w-fit animate-pulse">
                  <Radio size={8} /> STARTING…
                </span>
              ) : conf.recordingState === 'ACTIVE' ? (
                <div className="flex flex-col gap-0.5">
                  <span className="flex items-center gap-1 text-[10px] px-1.5 py-px rounded-full
                                   bg-red-500/15 text-red-500 font-bold animate-pulse w-fit">
                    <Radio size={8} /> RECORDING
                  </span>
                  {conf.recordingPath && (
                    <span className="text-[9px] text-text-muted truncate max-w-[160px] font-mono" title={conf.recordingPath}>
                      {conf.recordingPath.split('/').pop()}
                    </span>
                  )}
                </div>
              ) : conf.recordingState === 'STOPPING' ? (
                <span className="flex items-center gap-1 text-[10px] px-1.5 py-px rounded-full
                                 bg-slate-500/15 text-slate-400 font-bold w-fit animate-pulse">
                  <Square size={8} /> STOPPING…
                </span>
              ) : conf.recordingState === 'FAILED' ? (
                <div className="flex flex-col gap-0.5">
                  <span className="flex items-center gap-1 text-[10px] text-red-500 font-bold">
                    <AlertCircle size={8} /> Failed
                  </span>
                  {conf.recordingError && (
                    <span className="text-[9px] text-red-400 whitespace-pre-wrap break-words">{conf.recordingError}</span>
                  )}
                </div>
              ) : (
                <span className="text-text-muted text-[10px]">Off</span>
              )}
            </MetaItem>
            <MetaItem label="Lock State">
              {conf.locked ? (
                <span className="flex items-center gap-1 text-[10px] px-1.5 py-px rounded-full
                                 bg-amber-500/15 text-amber-500 font-bold w-fit">
                  <Lock size={8} /> LOCKED
                </span>
              ) : (
                <span className="text-emerald-500 text-[10px] font-medium flex items-center gap-1">
                  <Unlock size={8} /> Open
                </span>
              )}
            </MetaItem>
            <MetaItem label="Flags">
              <div className="flex flex-wrap gap-1">
                {conf.isDynamic  && <span className="text-[9px] px-1.5 py-px rounded bg-blue-500/15 text-blue-400 font-bold">Dynamic</span>}
                {conf.isRunning  && <span className="text-[9px] px-1.5 py-px rounded bg-emerald-500/15 text-emerald-500 font-bold">Running</span>}
                {conf.isModerated && <span className="text-[9px] px-1.5 py-px rounded bg-purple-500/15 text-purple-400 font-bold">Moderated</span>}
                {!conf.isDynamic && !conf.isRunning && !conf.isModerated && (
                  <span className="text-[9px] text-text-muted">Standard</span>
                )}
              </div>
            </MetaItem>
            {(conf.incident?.organization_name || conf.incident?.ers_name) && (
              <>
                {conf.incident?.organization_name && (
                  <MetaItem label="Organization">{conf.incident.organization_name}</MetaItem>
                )}
                {conf.incident?.ers_name && (
                  <MetaItem label="ERS Config">{conf.incident.ers_name}</MetaItem>
                )}
              </>
            )}
          </div>
        </div>
      </div>

      {/* Participant table */}
      <div className="flex-1 min-h-0">
        <div className="flex items-center gap-2 mb-2 shrink-0">
          <Users size={11} className="text-blue-500" />
          <span className="text-xs font-bold text-text-primary">Participants</span>
          <span className="text-[10px] px-1.5 py-px rounded-full bg-blue-500/15 text-blue-400 font-bold ml-1">
            {count}
          </span>
          {live > 0 && (
            <span className="text-[10px] px-1.5 py-px rounded-full bg-green-500/15 text-green-500 font-bold flex items-center gap-0.5">
              <span className="w-1 h-1 rounded-full bg-green-500 animate-pulse" /> {live} live
            </span>
          )}
        </div>
        <div className="card !p-0 overflow-hidden">
          <ParticipantTable members={conf.members || []} room={conf.name} now={now} />
        </div>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// RIGHT PANEL — Controls
// ─────────────────────────────────────────────────────────────────────────────
function RightPanel({ conf }) {
  const [sayText,    setSayText]    = useState('');
  const [dialStr,    setDialStr]    = useState('');
  const [showSay,    setShowSay]    = useState(false);
  const [showInvite, setShowInvite] = useState(false);
  const [actionBusy, setActionBusy] = useState({});

  const disabled    = !conf;
  const name        = conf?.name;
  const recState    = conf?.recordingState || 'OFF';
  const isStarting  = recState === 'STARTING';
  const isRecording = recState === 'ACTIVE';
  const isStopping  = recState === 'STOPPING';
  const isFailed    = recState === 'FAILED';
  const recBusy     = isStarting || isStopping;

  async function act(key, fn, ...args) {
    if (!name) return;
    setActionBusy(b => ({ ...b, [key]: true }));
    try { await fn(name, ...args); }
    catch (e) { alert('Command failed: ' + (e.message || 'Unknown error')); }
    finally { setActionBusy(b => ({ ...b, [key]: false })); }
  }

  // Recording button label + icon
  const recBtn = recBusy
    ? { label: isStarting ? 'Starting…' : 'Stopping…', icon: RefreshCw, variant: 'busy' }
    : (recState === 'OFF' || isFailed)
      ? { label: 'Start Recording',  icon: Radio,  variant: 'start' }
      : { label: 'Stop Recording',   icon: Square, variant: 'stop' };

  return (
    <div className="h-full flex flex-col">
      <div className="flex items-center gap-2 mb-3 shrink-0">
        <Zap size={12} className="text-amber-500" />
        <span className="text-xs font-bold text-text-primary">Controls</span>
        {/* Recording state chip */}
        {isStarting  && <span className="ml-auto text-[9px] px-1.5 py-px rounded-full bg-amber-500/15 text-amber-500 font-bold animate-pulse flex items-center gap-0.5"><Radio size={7} /> STARTING</span>}
        {isRecording && <span className="ml-auto text-[9px] px-1.5 py-px rounded-full bg-red-500/15 text-red-500 font-bold animate-pulse flex items-center gap-0.5"><Radio size={7} /> REC</span>}
        {isStopping  && <span className="ml-auto text-[9px] px-1.5 py-px rounded-full bg-slate-500/15 text-slate-400 font-bold animate-pulse flex items-center gap-0.5"><Square size={7} /> STOPPING</span>}
        {isFailed    && <span className="ml-auto text-[9px] px-1.5 py-px rounded-full bg-red-900/20 text-red-400 font-bold flex items-center gap-0.5"><AlertCircle size={7} /> FAILED</span>}
        {!conf && <span className="ml-auto text-[9px] text-text-muted">No selection</span>}
      </div>

      <div className="flex-1 overflow-y-auto space-y-4">

        {/* Conference controls */}
        <div>
          <p className="text-[9px] uppercase tracking-widest text-text-muted font-bold mb-2">Conference</p>
          <div className="space-y-2">
            {/* Lock — toggle switch */}
            <ToggleSwitch
              checked={conf?.locked ?? false}
              disabled={disabled || !!actionBusy.lock}
              labelOn="Conference Locked"
              labelOff="Lock Conference"
              Icon={conf?.locked ? Lock : Unlock}
              colorOn="bg-amber-500"
              onChange={() => act('lock', conf?.locked ? api.monitoring.unlock : api.monitoring.lock)}
            />

            {/* Mute All / Unmute All — two small buttons */}
            <div className="flex gap-1.5">
              <button
                disabled={disabled}
                onClick={() => conf?.members?.forEach(m => api.monitoring.mute(name, m.id))}
                className="flex-1 flex items-center justify-center gap-1 text-xs py-1.5 rounded-lg
                           border border-surface-border text-text-secondary
                           hover:bg-red-500/10 hover:text-red-400 hover:border-red-500/20
                           disabled:opacity-35 disabled:cursor-not-allowed transition-colors">
                <MicOff size={11} /> Mute All
              </button>
              <button
                disabled={disabled}
                onClick={() => conf?.members?.forEach(m => api.monitoring.unmute(name, m.id))}
                className="flex-1 flex items-center justify-center gap-1 text-xs py-1.5 rounded-lg
                           border border-surface-border text-text-secondary
                           hover:bg-emerald-500/10 hover:text-emerald-500 hover:border-emerald-500/20
                           disabled:opacity-35 disabled:cursor-not-allowed transition-colors">
                <Mic size={11} /> Unmute All
              </button>
            </div>
          </div>
        </div>

        {/* Recording */}
        <div>
          <p className="text-[9px] uppercase tracking-widest text-text-muted font-bold mb-2">Recording</p>
          <div className="space-y-2">
            {/* Status text */}
            {isStarting  && <div className="flex items-center gap-1.5 text-[10px] text-amber-400"><Radio size={9} className="animate-pulse" /> Starting…</div>}
            {isRecording && <div className="flex items-center gap-1.5 text-[10px] text-red-400"><Radio size={9} className="animate-pulse" /> Recording active</div>}
            {isStopping  && <div className="flex items-center gap-1.5 text-[10px] text-slate-400"><Square size={9} className="animate-pulse" /> Stopping…</div>}
            {isFailed    && <div className="text-[10px] text-red-400">Recording failed — check backend logs</div>}

            {/* Primary recording button (single button, state-aware label) */}
            {!recBusy && (
              <button
                disabled={disabled}
                onClick={() => {
                  if (recState === 'OFF' || isFailed) {
                    act('record', api.monitoring.recordStart);
                  } else if (isRecording) {
                    act('record', api.monitoring.recordStop);
                  } else {
                    act('record', api.monitoring.recordStop);
                  }
                }}
                className={[
                  'w-full flex items-center justify-center gap-2 px-3 py-2.5 rounded-xl border',
                  'text-xs font-medium transition-all',
                  disabled ? 'opacity-35 cursor-not-allowed border-surface-border text-text-muted'
                    : (recState === 'OFF' || isFailed)
                      ? 'border-red-500/30 bg-red-500/8 text-red-400 hover:bg-red-500/15 hover:border-red-500/50'
                      : 'border-red-500/40 bg-red-500/15 text-red-400 hover:bg-red-500/25',
                ].join(' ')}
              >
                {(recState === 'OFF' || isFailed)
                  ? <><Radio size={13} /> Start Recording</>
                  : <><Square size={13} /> Stop Recording</>}
              </button>
            )}


            {recBusy && (
              <button disabled
                className="w-full flex items-center justify-center gap-2 px-3 py-2.5 rounded-xl border
                           border-surface-border text-text-muted text-xs opacity-35 cursor-not-allowed">
                <RefreshCw size={12} className="animate-spin" />
                {isStarting ? 'Starting…' : 'Stopping…'}
              </button>
            )}
          </div>
        </div>

        {/* Broadcast */}
        <div>
          <p className="text-[9px] uppercase tracking-widest text-text-muted font-bold mb-2">Broadcast</p>
          <div className="space-y-1.5">
            {/* TTS */}
            <button
              disabled={disabled}
              onClick={() => { if (!disabled) { setShowSay(s => !s); setShowInvite(false); } }}
              className={[
                'w-full flex items-center gap-2 px-3 py-2 rounded-xl border text-xs font-medium transition-colors',
                disabled ? 'opacity-35 cursor-not-allowed border-surface-border text-text-muted'
                  : showSay
                    ? 'border-primary/40 bg-primary/8 text-primary'
                    : 'border-surface-border text-text-secondary hover:bg-surface-hover',
              ].join(' ')}
            >
              <Radio size={12} /> Broadcast TTS
              <ChevronDown size={10} className={`ml-auto transition-transform ${showSay ? 'rotate-180' : ''}`} />
            </button>
            {showSay && (
              <form
                onSubmit={async e => {
                  e.preventDefault();
                  if (!sayText.trim()) return;
                  await act('say', api.monitoring.say, sayText.trim());
                  setSayText(''); setShowSay(false);
                }}
                className="flex gap-1.5"
              >
                <input autoFocus value={sayText} onChange={e => setSayText(e.target.value)}
                  placeholder="Announcement text…"
                  className="flex-1 input text-xs py-1.5 px-2.5" />
                <button type="submit" className="btn-primary text-xs px-3">Say</button>
              </form>
            )}

            {/* Invite */}
            <button
              disabled={disabled}
              onClick={() => { if (!disabled) { setShowInvite(s => !s); setShowSay(false); } }}
              className={[
                'w-full flex items-center gap-2 px-3 py-2 rounded-xl border text-xs font-medium transition-colors',
                disabled ? 'opacity-35 cursor-not-allowed border-surface-border text-text-muted'
                  : showInvite
                    ? 'border-primary/40 bg-primary/8 text-primary'
                    : 'border-surface-border text-text-secondary hover:bg-surface-hover',
              ].join(' ')}
            >
              <PhoneIncoming size={12} /> Invite Participant
              <ChevronDown size={10} className={`ml-auto transition-transform ${showInvite ? 'rotate-180' : ''}`} />
            </button>
            {showInvite && (
              <form
                onSubmit={async e => {
                  e.preventDefault();
                  if (!dialStr.trim()) return;
                  await act('invite', api.monitoring.invite, dialStr.trim());
                  setDialStr(''); setShowInvite(false);
                }}
                className="flex gap-1.5"
              >
                <input autoFocus value={dialStr} onChange={e => setDialStr(e.target.value)}
                  placeholder="Extension or sip:user@domain"
                  className="flex-1 input text-xs py-1.5 px-2.5" />
                <button type="submit" className="btn-primary text-xs px-3">Dial</button>
              </form>
            )}
          </div>
        </div>

        {/* Danger zone */}
        <div className="pt-2 border-t border-surface-border">
          <p className="text-[9px] uppercase tracking-widest text-red-500/40 font-bold mb-2">
            Danger Zone
          </p>
          <button
            disabled={disabled}
            onClick={() => {
              if (window.confirm(
                `Terminate conference "${name}"?\n\n` +
                `All ${conf?.members?.length ?? 0} participant(s) will be disconnected immediately.`
              )) {
                act('terminate', api.monitoring.terminate);
              }
            }}
            className="w-full flex items-center justify-center gap-2 px-3 py-2 rounded-xl border
                       border-red-500/30 text-red-500 text-xs font-medium
                       hover:bg-red-500/10 hover:border-red-500/50
                       disabled:opacity-35 disabled:cursor-not-allowed transition-colors"
          >
            <Trash2 size={12} /> Terminate Conference
          </button>
        </div>

      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// BOTTOM — Live Event Timeline
// ─────────────────────────────────────────────────────────────────────────────
const TimelineRow = memo(function TimelineRow({ ev }) {
  const cfg = EV[ev.type] || { label: ev.type, color: 'text-text-muted', Icon: Bell };
  const { Icon } = cfg;
  return (
    <div className="flex items-center gap-3 py-1.5 border-b border-surface-border/20 last:border-0">
      <span className="text-[9px] font-mono text-text-muted/50 shrink-0 tabular-nums w-16">
        {fmtTime(ev.ts)}
      </span>
      <Icon size={10} className={`${cfg.color} shrink-0`} />
      <span className={`text-[10px] font-semibold shrink-0 w-32 ${cfg.color}`}>{cfg.label}</span>
      <span className="text-[10px] text-text-muted truncate">{ev.detail}</span>
    </div>
  );
});

function BottomTimeline({ events }) {
  const listRef = useRef();
  const prevLen = useRef(0);
  useEffect(() => {
    if (events.length !== prevLen.current && listRef.current) {
      listRef.current.scrollTop = 0;
      prevLen.current = events.length;
    }
  }, [events.length]);

  return (
    <div className="card !p-0">
      <div className="flex items-center gap-2 px-4 py-2.5 border-b border-surface-border shrink-0">
        <Activity size={12} className="text-emerald-500" />
        <span className="text-xs font-bold text-text-primary">Live Event Timeline</span>
        {events.length > 0 && (
          <span className="ml-2 text-[10px] px-1.5 py-px rounded-full bg-surface-hover text-text-muted font-mono">
            {events.length}
          </span>
        )}
        <span className="ml-auto w-1.5 h-1.5 rounded-full bg-emerald-500 animate-pulse" />
      </div>
      <div ref={listRef} className="overflow-y-auto px-4 py-1" style={{ maxHeight: '180px' }}>
        {events.length === 0 ? (
          <div className="flex items-center justify-center gap-2 py-5">
            <Bell size={12} className="text-text-muted/25" />
            <p className="text-xs text-text-muted">Subscribed — waiting for events…</p>
          </div>
        ) : (
          events.map(e => <TimelineRow key={e.id} ev={e} />)
        )}
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Main
// ─────────────────────────────────────────────────────────────────────────────
export default function Monitoring() {
  const [conferences,   setConferences]   = useState([]);
  const [esl,           setEsl]           = useState(null);
  const [events,        setEvents]        = useState([]);
  const [selectedConf,  setSelectedConf]  = useState(null);
  const [loading,       setLoading]       = useState(true);
  const [eslLatency,    setEslLatency]    = useState(null);
  const [now,           setNow]           = useState(() => Date.now());
  const [lastSync,      setLastSync]      = useState(null);

  const confsRef      = useRef([]);
  const eventCountRef = useRef(0);
  const eventIdRef    = useRef(0);
  const [partHist,  setPartHist]  = useState([0]);
  const [confHist,  setConfHist]  = useState([0]);
  const [evHist,    setEvHist]    = useState([0]);

  useEffect(() => { confsRef.current = conferences; }, [conferences]);

  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);

  useEffect(() => {
    const t = setInterval(() => {
      const cs    = confsRef.current;
      const total = cs.reduce((s, c) => s + (c.members?.length ?? 0), 0);
      const addPt = (setter, v) => setter(prev => {
        const n = [...prev, v];
        return n.length > MAX_CHART_POINTS ? n.slice(-MAX_CHART_POINTS) : n;
      });
      addPt(setPartHist, total);
      addPt(setConfHist, cs.length);
      addPt(setEvHist,   eventCountRef.current);
      eventCountRef.current = 0;
    }, CHART_INTERVAL_MS);
    return () => clearInterval(t);
  }, []);

  useEffect(() => {
    async function ping() {
      const t0 = Date.now();
      try   { await api.monitoring.status(); setEslLatency(Date.now() - t0); }
      catch { setEslLatency(null); }
    }
    ping();
    const t = setInterval(ping, 30_000);
    return () => clearInterval(t);
  }, []);

  const load = useCallback(async () => {
    try {
      const data = await api.monitoring.conferences();
      setConferences(data.conferences || []);
      setEsl(data.esl);
      setLastSync(new Date().toISOString());
    } catch (e) {
      console.error('[monitoring] load failed:', e);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const pushEvent = useCallback((type, detail) => {
    eventCountRef.current++;
    setEvents(prev => {
      const next = [
        { id: eventIdRef.current++, type, detail, ts: new Date().toISOString() },
        ...prev,
      ];
      return next.length > MAX_EVENTS ? next.slice(0, MAX_EVENTS) : next;
    });
  }, []);

  useEffect(() => {
    function upConf(name, fn) {
      setConferences(prev => {
        const i = prev.findIndex(c => c.name === name);
        if (i === -1) return prev;
        const next = [...prev];
        next[i] = fn(next[i]);
        return next;
      });
    }
    function upMember(confName, id, fn) {
      upConf(confName, c => ({
        ...c,
        members: c.members.map(m => m.id === id ? fn(m) : m),
      }));
    }

    const handlers = {
      'esl.status': (status) => {
        setEsl(status);
        if (status.connected) setTimeout(load, 1000);
      },
      'conference.created': ({ confName }) => {
        setConferences(prev => {
          if (prev.find(c => c.name === confName)) return prev;
          return [...prev, {
            name: confName, members: [], locked: false,
            recording: false, recordingState: 'OFF',
            recordingPath: null, recordingError: null,
            rate: null, isDynamic: true, isRunning: false,
            isAnswered: false, isModerated: false,
            createdAt: new Date().toISOString(),
          }];
        });
        pushEvent('conference.created', `Conference ${confName} created`);
      },
      'conference.ended': ({ confName }) => {
        setConferences(prev => prev.filter(c => c.name !== confName));
        setSelectedConf(s => s === confName ? null : s);
        pushEvent('conference.ended', `Conference ${confName} ended`);
      },
      'conference.member.joined': ({ confName, memberData, callerNum, callerName, member: memberId }) => {
        const data = memberData || {
          id:          memberId || callerNum || String(Date.now()),
          displayName: callerName || callerNum || `Member #${memberId}`,
          extension:   callerNum || '',
          callerNum:   callerNum || '',
          callerName:  callerName || '',
          role:        'participant',
          muted:       false,
          deaf:        false,
          moderator:   false,
          talking:     false,
          floor:       false,
          energy:      0,
          joinedAt:    new Date().toISOString(),
        };
        upConf(confName, c => {
          if (c.members.find(m => m.id === data.id)) return c;
          return { ...c, members: [...c.members, data] };
        });
        const display = data.displayName || callerName || callerNum || 'Member';
        pushEvent('conference.member.joined', `${display} joined ${confName}`);
      },
      'conference.member.left': ({ confName, member: id, callerNum }) => {
        upConf(confName, c => ({ ...c, members: c.members.filter(m => m.id !== id) }));
        pushEvent('conference.member.left', `${callerNum || id} left ${confName}`);
      },
      'conference.member.muted': ({ confName, member: id, muted, callerNum }) => {
        upMember(confName, id, m => ({ ...m, muted }));
        pushEvent('conference.member.muted', `${callerNum || id} ${muted ? 'muted' : 'unmuted'} in ${confName}`);
      },
      'conference.member.deaf': ({ confName, member: id, deaf }) => {
        upMember(confName, id, m => ({ ...m, deaf }));
        pushEvent('conference.member.deaf', `Deaf state changed in ${confName}`);
      },
      'conference.member.talking': ({ confName, member: id, talking, callerNum }) => {
        upMember(confName, id, m => ({ ...m, talking }));
        if (talking) pushEvent('conference.member.talking', `${callerNum || id} speaking in ${confName}`);
      },
      'conference.floor.changed': ({ confName, member: id }) => {
        upConf(confName, c => ({
          ...c,
          floorHolder: id,
          members: c.members.map(m => ({ ...m, floor: m.id === id })),
        }));
        pushEvent('conference.floor.changed', `Floor → member ${id} in ${confName}`);
      },
      'conference.locked': ({ confName, locked }) => {
        upConf(confName, c => ({ ...c, locked }));
        pushEvent('conference.locked', `${confName} ${locked ? 'locked' : 'unlocked'}`);
      },
      'conference.recording': ({ confName, recording, recordingState, recordingPath, recordingError }) => {
        upConf(confName, c => ({
          ...c,
          recording,
          recordingState: recordingState || (recording ? 'ACTIVE' : 'OFF'),
          recordingPath:  recordingPath ?? c.recordingPath,
          recordingError: recordingError ?? (recordingState === 'FAILED' ? c.recordingError : null),
        }));
        const state = recordingState || (recording ? 'ACTIVE' : 'OFF');
        const label = state === 'STARTING' ? 'starting' : state === 'ACTIVE' ? 'started'
          : state === 'FAILED' ? 'FAILED' : 'stopped';
        pushEvent('conference.recording',
          state === 'FAILED'
            ? `${confName}: recording FAILED — ${recordingError || 'unknown error'}`
            : `${confName}: recording ${label}`);
      },
    };

    for (const [ev, fn] of Object.entries(handlers)) socket.on(ev, fn);
    return () => {
      for (const [ev, fn] of Object.entries(handlers)) socket.off(ev, fn);
    };
  }, [pushEvent, load]);

  const totalMembers    = useMemo(() => conferences.reduce((s, c) => s + (c.members?.length ?? 0), 0), [conferences]);
  const totalModerators = useMemo(() => conferences.reduce((s, c) => s + (c.members?.filter(m => m.moderator).length ?? 0), 0), [conferences]);
  const recordingCount  = useMemo(() => conferences.filter(c => c.recordingState === 'ACTIVE').length, [conferences]);
  const selectedConference = useMemo(() => conferences.find(c => c.name === selectedConf) ?? null, [conferences, selectedConf]);
  const clockStr = useMemo(() => new Date(now).toLocaleTimeString(), [now]);

  function toggleSelect(name) {
    setSelectedConf(s => s === name ? null : name);
  }

  return (
    <div className="space-y-3 pb-10">

      {/* Header */}
      <div className="flex items-center gap-3 flex-wrap">
        <div className="flex items-center gap-2.5 min-w-0">
          <div className="w-9 h-9 rounded-xl bg-emerald-500/15 flex items-center justify-center shrink-0">
            <Monitor size={17} className="text-emerald-500" />
          </div>
          <div>
            <h1 className="text-base font-bold text-text-primary leading-tight">
              Conference Operations Center
            </h1>
            <p className="text-[10px] text-text-muted">
              Real-time FreeSWITCH monitoring &amp; control
              {lastSync && ` · synced ${fmtTime(lastSync)}`}
            </p>
          </div>
        </div>

        <div className="ml-auto flex items-center gap-2.5 flex-wrap">
          <div className={`flex items-center gap-1.5 text-[11px] px-2.5 py-1 rounded-full border font-semibold
              ${esl?.connected
                ? 'border-emerald-500/30 bg-emerald-500/8 text-emerald-500'
                : 'border-red-500/30 bg-red-500/8 text-red-500'}`}>
            {esl?.connected ? <Wifi size={10} /> : <WifiOff size={10} />}
            {esl?.connected ? `ESL · ${esl.host}:${esl.port}` : 'ESL Offline'}
            <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${esl?.connected ? 'bg-emerald-500 animate-pulse' : 'bg-red-500'}`} />
          </div>
          {eslLatency != null && (
            <span className="text-[11px] text-text-muted flex items-center gap-1">
              <Signal size={10} className={eslLatency < 80 ? 'text-emerald-500' : 'text-amber-500'} />
              <span className="tabular-nums">{eslLatency}ms</span>
            </span>
          )}
          <span className="text-[11px] font-mono tabular-nums text-text-muted">{clockStr}</span>
          <button onClick={load}
            className="flex items-center gap-1 text-[11px] px-2 py-1 rounded-lg text-text-muted
                       hover:text-text-primary hover:bg-surface-hover transition-colors">
            <RefreshCw size={10} /> Refresh
          </button>
        </div>
      </div>

      {/* KPI strip */}
      <div className="grid grid-cols-3 sm:grid-cols-6 gap-2">
        <KpiCard icon={PhoneCall}  label="Conferences"  value={conferences.length}
          sub="Live"              valueClass="text-emerald-500"
          sparkData={confHist}   sparkColor="#10b981"  pulse={conferences.length > 0} />
        <KpiCard icon={Users}      label="Participants"  value={totalMembers}
          sub="Across all rooms"  valueClass="text-blue-400"
          sparkData={partHist}   sparkColor="#60a5fa" />
        <KpiCard icon={Shield}     label="Moderators"   value={totalModerators}
          sub="Active"            valueClass="text-amber-400" />
        <KpiCard icon={Radio}      label="Recording"    value={recordingCount}
          sub="Active sessions"   danger               pulse={recordingCount > 0} />
        <KpiCard icon={Activity}   label="Event Rate"   value={evHist.at(-1) ?? 0}
          sub={`Per ${CHART_INTERVAL_MS / 1000}s`}     valueClass="text-purple-400"
          sparkData={evHist}     sparkColor="#c084fc" />
        <KpiCard icon={Signal}     label="ESL Latency"  value={eslLatency != null ? `${eslLatency}ms` : '—'}
          sub="Round-trip"
          valueClass={eslLatency != null && eslLatency < 80 ? 'text-emerald-500' : 'text-amber-400'} />
      </div>

      {/* 3-panel grid */}
      <div className="grid grid-cols-12 gap-3" style={{ minHeight: '520px', maxHeight: '640px' }}>
        <div className="col-span-3 card !p-4 overflow-hidden flex flex-col">
          <IncidentSidebar
            conferences={conferences}
            selectedConf={selectedConf}
            onSelect={toggleSelect}
            now={now}
            loading={loading}
          />
        </div>
        <div className="col-span-6 card !p-4 overflow-hidden">
          <CenterPanel conf={selectedConference} now={now} />
        </div>
        <div className="col-span-3 card !p-4 overflow-hidden">
          <RightPanel conf={selectedConference} />
        </div>
      </div>

      {/* Live Event Timeline */}
      <BottomTimeline events={events} />

      {/* Sparklines */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
        {[
          { label: 'Participants Over Time', data: partHist, color: '#60a5fa', current: totalMembers },
          { label: 'Active Conferences',     data: confHist, color: '#10b981', current: conferences.length },
          { label: 'Events / Interval',      data: evHist,   color: '#c084fc', current: evHist.at(-1) ?? 0 },
        ].map(({ label, data, color, current }) => (
          <div key={label} className="card !pb-2">
            <div className="flex items-center justify-between mb-1.5">
              <span className="text-[10px] font-bold uppercase tracking-widest text-text-muted flex items-center gap-1">
                <BarChart2 size={9} /> {label}
              </span>
              <span className="text-sm font-bold tabular-nums" style={{ color }}>{current}</span>
            </div>
            <Sparkline data={data} color={color} height={44} />
            <p className="text-[9px] text-text-muted mt-0.5 tabular-nums">
              {data.length} samples · {data.length * (CHART_INTERVAL_MS / 1000)}s window
            </p>
          </div>
        ))}
      </div>

    </div>
  );
}
