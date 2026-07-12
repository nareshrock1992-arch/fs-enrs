/**
 * Conference Operations Center — Enterprise NOC Dashboard
 * Real-time FreeSWITCH conference monitoring and control.
 * All state is socket-driven; no polling after initial seed.
 */
import {
  useEffect, useState, useCallback, useRef, useMemo, memo,
} from 'react';
import {
  Activity, Wifi, WifiOff, Users, Lock, Unlock,
  Mic, MicOff, PhoneOff, Radio, Pause, Square,
  PhoneIncoming, Trash2, ChevronRight, ChevronDown,
  Headphones, EarOff, Shield, RefreshCw, Zap,
  PhoneCall, Bell, Signal, ArrowRight, Database,
  Monitor, BarChart2,
} from 'lucide-react';
import { api } from '../api/client.js';
import { socket } from '../api/socket.js';

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────

const MAX_EVENTS        = 120;
const MAX_CHART_POINTS  = 60;   // 60 samples × 10 s = 10-min window
const CHART_INTERVAL_MS = 10_000;

const EV = {
  'conference.created':        { label: 'Conference Created',  color: 'text-emerald-500', bg: 'bg-emerald-500/10', borderColor: '#10b981', Icon: PhoneCall  },
  'conference.ended':          { label: 'Conference Ended',    color: 'text-slate-400',   bg: 'bg-slate-500/10',   borderColor: '#94a3b8', Icon: PhoneOff   },
  'conference.member.joined':  { label: 'Member Joined',       color: 'text-blue-500',    bg: 'bg-blue-500/10',    borderColor: '#3b82f6', Icon: PhoneIncoming },
  'conference.member.left':    { label: 'Member Left',         color: 'text-orange-400',  bg: 'bg-orange-500/10',  borderColor: '#fb923c', Icon: PhoneOff   },
  'conference.member.muted':   { label: 'Mute State Changed',  color: 'text-yellow-500',  bg: 'bg-yellow-500/10',  borderColor: '#eab308', Icon: MicOff     },
  'conference.member.deaf':    { label: 'Deaf State Changed',  color: 'text-orange-500',  bg: 'bg-orange-500/10',  borderColor: '#f97316', Icon: EarOff     },
  'conference.member.talking': { label: 'Speaking',            color: 'text-green-400',   bg: 'bg-green-500/10',   borderColor: '#4ade80', Icon: Mic        },
  'conference.floor.changed':  { label: 'Floor Changed',       color: 'text-purple-400',  bg: 'bg-purple-500/10',  borderColor: '#c084fc', Icon: Shield     },
  'conference.locked':         { label: 'Lock State Changed',  color: 'text-amber-500',   bg: 'bg-amber-500/10',   borderColor: '#f59e0b', Icon: Lock       },
  'conference.recording':      { label: 'Recording',           color: 'text-red-400',     bg: 'bg-red-500/10',     borderColor: '#f87171', Icon: Radio      },
};

// ─────────────────────────────────────────────────────────────────────────────
// Utilities
// ─────────────────────────────────────────────────────────────────────────────

function elapsedSec(isoStart, now = Date.now()) {
  return isoStart ? Math.floor((now - new Date(isoStart)) / 1000) : 0;
}
function fmtElapsed(secs) {
  if (secs < 60)   return `${secs}s`;
  if (secs < 3600) return `${Math.floor(secs / 60)}m ${secs % 60}s`;
  return `${Math.floor(secs / 3600)}h ${Math.floor((secs % 3600) / 60)}m`;
}
function fmtTime(iso) {
  return new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}
function fmtDateTime(iso) {
  if (!iso) return '—';
  return new Date(iso).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}
function initials(name, num) {
  const src = name || num || '?';
  return src[0].toUpperCase();
}

// ─────────────────────────────────────────────────────────────────────────────
// Sparkline — pure SVG, no library
// ─────────────────────────────────────────────────────────────────────────────

const Sparkline = memo(function Sparkline({ data = [], color = '#22c55e', height = 40 }) {
  if (data.length < 2) return <svg width="100%" height={height} />;
  const W = 200, H = height;
  const mx = Math.max(...data, 1);
  const step = W / (data.length - 1);
  const pts = data.map((v, i) => [
    i * step,
    H - (v / mx) * H * 0.88 - H * 0.06,
  ]);
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
// KPI Card
// ─────────────────────────────────────────────────────────────────────────────

const KpiCard = memo(function KpiCard({
  icon: Icon, label, value, sub, valueClass = 'text-text-primary',
  sparkData, sparkColor, pulse = false, danger = false,
}) {
  return (
    <div className={`card !p-3 relative overflow-hidden flex flex-col gap-0.5
      ${danger && value > 0 ? 'border-red-500/30 bg-red-500/5' : ''}`}>
      <div className="flex items-center justify-between">
        <span className={`text-[10px] uppercase tracking-widest font-semibold
          ${danger && value > 0 ? 'text-red-400' : 'text-text-muted'}`}>
          <Icon size={10} className="inline mr-1 -mt-px" />
          {label}
        </span>
        {pulse && value > 0 && (
          <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 animate-pulse" />
        )}
      </div>
      <div className={`text-2xl font-bold tabular-nums leading-none mt-0.5
        ${danger && value > 0 ? 'text-red-500' : valueClass}`}>
        {value ?? '—'}
      </div>
      {sub && <p className="text-[10px] text-text-muted leading-none">{sub}</p>}
      {sparkData && sparkData.length > 1 && (
        <div className="absolute bottom-0 left-0 right-0 opacity-50 pointer-events-none">
          <Sparkline data={sparkData} color={sparkColor || '#22c55e'} height={26} />
        </div>
      )}
    </div>
  );
});

// ─────────────────────────────────────────────────────────────────────────────
// Live Event Feed
// ─────────────────────────────────────────────────────────────────────────────

const EventItem = memo(function EventItem({ ev }) {
  const cfg = EV[ev.type] || { label: ev.type, color: 'text-text-muted', bg: 'bg-surface-hover', borderColor: '#64748b', Icon: Bell };
  const { Icon } = cfg;
  return (
    <div className="flex items-start gap-2 py-1.5 pl-2 border-l-2 transition-colors"
         style={{ borderColor: cfg.borderColor }}>
      <div className={`w-5 h-5 rounded flex items-center justify-center shrink-0 mt-0.5 ${cfg.bg}`}>
        <Icon size={10} className={cfg.color} />
      </div>
      <div className="flex-1 min-w-0">
        <p className={`text-[11px] font-semibold leading-tight ${cfg.color}`}>{cfg.label}</p>
        <p className="text-[10px] text-text-muted leading-tight truncate">{ev.detail}</p>
        <p className="text-[9px] text-text-muted/50 mt-px">{fmtTime(ev.ts)}</p>
      </div>
    </div>
  );
});

function EventFeed({ events }) {
  const listRef = useRef();
  const prevLen = useRef(0);
  useEffect(() => {
    if (events.length !== prevLen.current && listRef.current) {
      listRef.current.scrollTop = 0;
      prevLen.current = events.length;
    }
  }, [events.length]);

  return (
    <div className="card !p-0 flex flex-col" style={{ height: '420px' }}>
      <div className="flex items-center gap-2 px-3 py-2.5 border-b border-surface-border shrink-0">
        <Activity size={12} className="text-emerald-500" />
        <span className="text-xs font-semibold text-text-primary">Live Event Feed</span>
        {events.length > 0 && (
          <span className="ml-auto text-[10px] px-1.5 py-px rounded-full
                           bg-surface-hover text-text-muted font-mono">
            {events.length}
          </span>
        )}
      </div>
      <div ref={listRef} className="flex-1 overflow-y-auto px-2 py-1 space-y-px">
        {events.length === 0 ? (
          <div className="flex flex-col items-center gap-3 py-10 text-center">
            <Bell size={18} className="text-text-muted/30" />
            <p className="text-xs text-text-muted">Listening for events…</p>
            <span className="w-2 h-2 rounded-full bg-emerald-500 animate-pulse" />
          </div>
        ) : (
          events.map(e => <EventItem key={e.id} ev={e} />)
        )}
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Conference Table
// ─────────────────────────────────────────────────────────────────────────────

const ConferenceRow = memo(function ConferenceRow({ conf, selected, onSelect, now }) {
  const secs   = elapsedSec(conf.createdAt, now);
  const dur    = fmtElapsed(secs);
  const mCount = conf.members?.length ?? 0;
  const mods   = conf.members?.filter(m => m.moderator).length ?? 0;
  const live   = conf.members?.filter(m => m.talking).length ?? 0;

  return (
    <tr
      onClick={() => onSelect(conf.name)}
      className={`cursor-pointer border-b border-surface-border/40 transition-colors
        ${selected ? 'bg-primary/8' : 'hover:bg-surface-hover'}`}
    >
      {/* Room */}
      <td className="px-3 py-2.5">
        <div className="flex items-center gap-2 min-w-0">
          <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${
            live > 0 ? 'bg-green-500 animate-pulse' : 'bg-emerald-400'
          }`} />
          <div className="min-w-0">
            <p className="text-xs font-mono font-bold text-text-primary truncate">{conf.name}</p>
            {conf.incident?.organization_name && (
              <p className="text-[10px] text-text-muted truncate">{conf.incident.organization_name}</p>
            )}
          </div>
        </div>
      </td>
      {/* Incident */}
      <td className="px-3 py-2.5">
        {conf.incident ? (
          <div className="min-w-0">
            <p className="text-xs font-medium text-text-primary truncate max-w-[130px]">
              {conf.incident.ers_name || '—'}
            </p>
            <p className="text-[10px] font-mono text-text-muted">{conf.incident.caller_number}</p>
          </div>
        ) : (
          <span className="text-[10px] text-text-muted">—</span>
        )}
      </td>
      {/* Duration */}
      <td className="px-3 py-2.5">
        <span className="text-xs tabular-nums text-text-secondary font-mono">{dur}</span>
      </td>
      {/* Members */}
      <td className="px-3 py-2.5">
        <div className="flex items-center gap-1.5">
          <span className="text-sm font-bold tabular-nums text-text-primary">{mCount}</span>
          {live > 0 && (
            <span className="text-[10px] text-green-500 font-semibold">{live} live</span>
          )}
          {mods > 0 && (
            <span className="text-[10px] text-amber-500">{mods} mod</span>
          )}
        </div>
      </td>
      {/* Flags */}
      <td className="px-3 py-2.5">
        <div className="flex items-center gap-1 flex-wrap">
          {conf.recording && (
            <span className="inline-flex items-center gap-0.5 text-[9px] px-1.5 py-0.5 rounded-full
                             bg-red-500/15 text-red-500 font-bold animate-pulse">
              <Radio size={7} /> REC
            </span>
          )}
          {conf.locked && (
            <span className="inline-flex items-center gap-0.5 text-[9px] px-1.5 py-0.5 rounded-full
                             bg-amber-500/15 text-amber-500 font-bold">
              <Lock size={7} /> LOCKED
            </span>
          )}
          {!conf.recording && !conf.locked && <span className="text-[10px] text-text-muted">—</span>}
        </div>
      </td>
      {/* Type */}
      <td className="px-3 py-2.5">
        {conf.incident?.group_type ? (
          <span className={`text-[9px] px-1.5 py-0.5 rounded-full font-bold
            ${conf.incident.group_type === 'PRIMARY'
              ? 'bg-blue-500/15 text-blue-400'
              : 'bg-purple-500/15 text-purple-400'}`}>
            {conf.incident.group_type}
          </span>
        ) : (
          <span className="text-[9px] px-1.5 py-0.5 rounded-full bg-emerald-500/15 text-emerald-500 font-bold">
            ACTIVE
          </span>
        )}
      </td>
      {/* Expand */}
      <td className="px-3 py-2.5 w-8">
        <span className={`text-text-muted transition-transform inline-block ${selected ? 'rotate-90' : ''}`}>
          <ChevronRight size={12} />
        </span>
      </td>
    </tr>
  );
});

function ConferenceTable({ conferences, selectedConf, onSelect, now }) {
  return (
    <div className="card !p-0 overflow-hidden">
      <div className="flex items-center gap-2 px-4 py-2.5 border-b border-surface-border bg-surface-hover/30">
        <PhoneCall size={12} className="text-emerald-500" />
        <span className="text-xs font-bold text-text-primary">Active Conferences</span>
        <span className="text-[10px] px-1.5 py-px rounded-full bg-emerald-500/15 text-emerald-500 font-bold ml-1">
          {conferences.length}
        </span>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-left border-collapse">
          <thead>
            <tr className="border-b border-surface-border">
              {['Room / Org', 'Incident', 'Duration', 'Members', 'Status', 'Type', ''].map(h => (
                <th key={h}
                    className="px-3 py-2 text-[9px] font-bold uppercase tracking-widest text-text-muted
                               bg-surface-hover/20 whitespace-nowrap">
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {conferences.map(c => (
              <ConferenceRow
                key={c.name} conf={c}
                selected={selectedConf === c.name}
                onSelect={onSelect} now={now}
              />
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Participant Panel
// ─────────────────────────────────────────────────────────────────────────────

const MemberCard = memo(function MemberCard({ member, room }) {
  const name = member.callerName || member.caller_name || '';
  const num  = member.callerNum  || member.caller_num  || '';
  const display = name || num || `#${member.id}`;
  const joinedAt = member.joinedAt || member.joined_at;

  async function act(fn, ...args) {
    try { await fn(room, member.id, ...args); } catch (e) { console.error(e); }
  }

  return (
    <div className={[
      'rounded-xl border flex flex-col gap-1.5 p-2.5 transition-all duration-200',
      member.talking
        ? 'border-green-500/40 bg-green-500/5 shadow-sm'
        : 'border-surface-border bg-surface-card hover:border-surface-border/70',
    ].join(' ')}>
      {/* Top row */}
      <div className="flex items-start gap-2">
        <div className={[
          'w-7 h-7 rounded-full flex items-center justify-center text-xs font-bold shrink-0',
          member.moderator ? 'bg-amber-500/20 text-amber-500' : 'bg-surface-hover text-text-muted',
        ].join(' ')}>
          {initials(name, num)}
        </div>
        <div className="flex-1 min-w-0">
          <p className="text-[11px] font-semibold text-text-primary truncate leading-tight">{display}</p>
          {name && num && <p className="text-[9px] font-mono text-text-muted leading-none">{num}</p>}
        </div>
        {/* Speaking bars */}
        {member.talking && (
          <div className="flex items-end gap-px shrink-0 h-4 self-center">
            {[2, 4, 3, 5, 2].map((h, i) => (
              <div key={i} className="w-0.5 rounded-full bg-green-500"
                   style={{ height: `${h * 2}px`, animation: `pulse 0.8s ease-in-out ${i * 0.1}s infinite alternate` }} />
            ))}
          </div>
        )}
      </div>
      {/* Badges */}
      <div className="flex items-center gap-1 flex-wrap">
        {member.moderator && (
          <span className="text-[8px] px-1 py-px rounded bg-amber-500/15 text-amber-500 font-bold flex items-center gap-0.5">
            <Shield size={6} /> MOD
          </span>
        )}
        {member.muted && (
          <span className="text-[8px] px-1 py-px rounded bg-red-500/15 text-red-500 font-bold">MUTED</span>
        )}
        {member.deaf && (
          <span className="text-[8px] px-1 py-px rounded bg-orange-500/15 text-orange-500 font-bold">DEAF</span>
        )}
        {member.floor && (
          <span className="text-[8px] px-1 py-px rounded bg-purple-500/15 text-purple-400 font-bold">FLOOR</span>
        )}
        {joinedAt && (
          <span className="text-[8px] text-text-muted ml-auto shrink-0">
            {fmtElapsed(elapsedSec(joinedAt))} ago
          </span>
        )}
      </div>
      {/* Actions */}
      <div className="flex items-center gap-px border-t border-surface-border/40 pt-1.5">
        {[
          {
            icon: member.muted ? Mic : MicOff,
            label: member.muted ? 'Unmute' : 'Mute',
            fn: () => act(member.muted ? api.monitoring.unmute : api.monitoring.mute),
            active: member.muted,
          },
          {
            icon: EarOff,
            label: member.deaf ? 'Undeaf' : 'Deaf',
            fn: () => act(member.deaf ? api.monitoring.undeaf : api.monitoring.deaf),
          },
          { icon: ArrowRight, label: 'Floor', fn: () => act(api.monitoring.floor) },
          {
            icon: PhoneOff, label: 'Kick', danger: true,
            fn: () => { if (window.confirm(`Kick ${display}?`)) act(api.monitoring.kick); },
          },
        ].map(({ icon: Icon, label, fn, active, danger }) => (
          <button key={label} onClick={fn} title={label}
                  className={[
                    'flex-1 flex flex-col items-center gap-px py-1 rounded text-[8px] font-medium transition-colors',
                    danger  ? 'text-red-500/70 hover:bg-red-500/10 hover:text-red-500' :
                    active  ? 'text-primary bg-primary/8' :
                              'text-text-muted hover:bg-surface-hover hover:text-text-primary',
                  ].join(' ')}>
            <Icon size={9} />
            {label}
          </button>
        ))}
      </div>
    </div>
  );
});

function ParticipantPanel({ conf }) {
  const members = conf?.members || [];
  const sorted = useMemo(() => [...members].sort((a, b) => {
    if (a.moderator !== b.moderator) return a.moderator ? -1 : 1;
    if (a.talking   !== b.talking)   return a.talking   ? -1 : 1;
    return 0;
  }), [members]);

  return (
    <div className="card !p-0 overflow-hidden">
      <div className="flex items-center gap-2 px-4 py-2.5 border-b border-surface-border bg-surface-hover/30">
        <Users size={12} className="text-blue-500" />
        <span className="text-xs font-bold text-text-primary">
          Participants
        </span>
        <span className="font-mono text-xs text-text-muted">— {conf.name}</span>
        <span className="text-[10px] px-1.5 py-px rounded-full bg-blue-500/15 text-blue-400 font-bold ml-1">
          {members.length}
        </span>
      </div>
      <div className="p-3">
        {members.length === 0 ? (
          <p className="text-xs text-text-muted text-center py-6">No participants yet.</p>
        ) : (
          <div className="grid grid-cols-2 sm:grid-cols-3 xl:grid-cols-4 2xl:grid-cols-5 gap-2">
            {sorted.map(m => (
              <MemberCard key={m.id} member={m} room={conf.name} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Conference Controls
// ─────────────────────────────────────────────────────────────────────────────

function CtrlBtn({ icon: Icon, label, onClick, variant = 'default', active = false, disabled = false, wide = false }) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      title={label}
      className={[
        'flex items-center gap-1.5 rounded-lg border text-xs font-medium transition-all select-none',
        wide ? 'w-full px-3 py-2' : 'px-2.5 py-1.5',
        disabled ? 'opacity-40 cursor-not-allowed border-surface-border text-text-muted' :
        variant === 'danger'
          ? 'border-red-500/30 text-red-500 hover:bg-red-500/15 hover:border-red-500/60'
          : active
            ? 'border-primary/40 bg-primary/10 text-primary'
            : 'border-surface-border text-text-secondary hover:bg-surface-hover hover:text-text-primary',
      ].join(' ')}
    >
      <Icon size={13} className="shrink-0" />
      {label}
    </button>
  );
}

function ConferenceControls({ conf }) {
  const [sayText,     setSayText]     = useState('');
  const [dialStr,     setDialStr]     = useState('');
  const [showSay,     setShowSay]     = useState(false);
  const [showInvite,  setShowInvite]  = useState(false);
  const { name } = conf;

  async function act(fn, ...args) {
    try { await fn(name, ...args); }
    catch (e) { alert('Command failed: ' + (e.message || 'Unknown error')); }
  }

  function recPath() {
    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    return `/var/lib/freeswitch/recordings/conf_${name}_${ts}.wav`;
  }

  return (
    <div className="card !p-0 overflow-hidden">
      <div className="flex items-center gap-2 px-4 py-2.5 border-b border-surface-border bg-surface-hover/30">
        <Zap size={12} className="text-amber-500" />
        <span className="text-xs font-bold text-text-primary">Conference Controls</span>
        {conf.recording && (
          <span className="ml-auto inline-flex items-center gap-1 text-[9px] px-1.5 py-px rounded-full
                           bg-red-500/15 text-red-500 font-bold animate-pulse">
            <Radio size={7} /> REC
          </span>
        )}
      </div>

      <div className="p-3 space-y-4 overflow-y-auto" style={{ maxHeight: '380px' }}>

        {/* Conference state */}
        <div>
          <p className="text-[9px] uppercase tracking-widest text-text-muted font-bold mb-2">Conference</p>
          <div className="flex flex-wrap gap-1.5">
            <CtrlBtn icon={conf.locked ? Unlock : Lock}
              label={conf.locked ? 'Unlock' : 'Lock'}
              active={conf.locked}
              onClick={() => act(conf.locked ? api.monitoring.unlock : api.monitoring.lock)} />
            <CtrlBtn icon={MicOff} label="Mute All"
              onClick={() => conf.members?.forEach(m => api.monitoring.mute(name, m.id))} />
            <CtrlBtn icon={Mic} label="Unmute All"
              onClick={() => conf.members?.forEach(m => api.monitoring.unmute(name, m.id))} />
          </div>
        </div>

        {/* Recording */}
        <div>
          <p className="text-[9px] uppercase tracking-widest text-text-muted font-bold mb-2">Recording</p>
          <div className="flex flex-wrap gap-1.5">
            {!conf.recording ? (
              <CtrlBtn icon={Radio} label="Start Recording"
                onClick={() => act(api.monitoring.recordStart, recPath())} />
            ) : (
              <>
                <CtrlBtn icon={Pause} label="Pause" active
                  onClick={() => act(api.monitoring.recordPause, conf.recording)} />
                <CtrlBtn icon={Square} label="Stop" variant="danger"
                  onClick={() => act(api.monitoring.recordStop, conf.recording)} />
              </>
            )}
          </div>
        </div>

        {/* Broadcast */}
        <div>
          <p className="text-[9px] uppercase tracking-widest text-text-muted font-bold mb-2">Broadcast</p>
          <div className="space-y-1.5">
            <button
              onClick={() => { setShowSay(s => !s); setShowInvite(false); }}
              className={`w-full flex items-center gap-2 px-3 py-2 rounded-lg border text-xs font-medium transition-colors
                ${showSay ? 'border-primary/40 bg-primary/8 text-primary' : 'border-surface-border text-text-secondary hover:bg-surface-hover'}`}
            >
              <Radio size={12} /> Broadcast TTS
              <ChevronDown size={10} className={`ml-auto transition-transform ${showSay ? 'rotate-180' : ''}`} />
            </button>
            {showSay && (
              <form onSubmit={async e => {
                e.preventDefault();
                if (!sayText.trim()) return;
                await act(api.monitoring.say, sayText.trim());
                setSayText(''); setShowSay(false);
              }} className="flex gap-1.5 mt-1">
                <input autoFocus value={sayText} onChange={e => setSayText(e.target.value)}
                       placeholder="Announcement text…"
                       className="flex-1 input text-xs py-1.5 px-2.5" />
                <button type="submit" className="btn-primary text-xs px-3">Say</button>
              </form>
            )}
            <button
              onClick={() => { setShowInvite(s => !s); setShowSay(false); }}
              className={`w-full flex items-center gap-2 px-3 py-2 rounded-lg border text-xs font-medium transition-colors
                ${showInvite ? 'border-primary/40 bg-primary/8 text-primary' : 'border-surface-border text-text-secondary hover:bg-surface-hover'}`}
            >
              <PhoneIncoming size={12} /> Invite Participant
              <ChevronDown size={10} className={`ml-auto transition-transform ${showInvite ? 'rotate-180' : ''}`} />
            </button>
            {showInvite && (
              <form onSubmit={async e => {
                e.preventDefault();
                if (!dialStr.trim()) return;
                await act(api.monitoring.invite, dialStr.trim());
                setDialStr(''); setShowInvite(false);
              }} className="flex gap-1.5 mt-1">
                <input autoFocus value={dialStr} onChange={e => setDialStr(e.target.value)}
                       placeholder="sip:user@domain or extension"
                       className="flex-1 input text-xs py-1.5 px-2.5" />
                <button type="submit" className="btn-primary text-xs px-3">Dial</button>
              </form>
            )}
          </div>
        </div>

        {/* Danger zone */}
        <div className="pt-1 border-t border-surface-border">
          <CtrlBtn icon={Trash2} label="Terminate Conference" variant="danger" wide
            onClick={() => {
              if (window.confirm(`Terminate "${name}"?\n\nAll participants will be immediately disconnected.`)) {
                act(api.monitoring.terminate);
              }
            }} />
        </div>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Empty State
// ─────────────────────────────────────────────────────────────────────────────

function EmptyState({ esl }) {
  return (
    <div className="card flex flex-col items-center gap-5 py-16 text-center relative overflow-hidden">
      {/* Concentric pulse rings */}
      {[64, 48, 32].map((size, i) => (
        <div key={size} className="absolute rounded-full border border-emerald-500/10 animate-ping"
             style={{ width: size * 4, height: size * 4, animationDuration: `${2 + i * 0.7}s`, animationDelay: `${i * 0.4}s` }} />
      ))}
      {/* Icon */}
      <div className="relative z-10 w-16 h-16 rounded-2xl bg-emerald-500/10 flex items-center justify-center">
        <Headphones size={28} className="text-emerald-500" />
        <span className="absolute -top-1 -right-1 w-4 h-4 rounded-full bg-emerald-500
                         flex items-center justify-center">
          <span className="w-2 h-2 rounded-full bg-white dark:bg-gray-900 animate-pulse" />
        </span>
      </div>
      {/* Copy */}
      <div className="relative z-10">
        <h3 className="text-sm font-bold text-text-primary">No Active Emergency Conferences</h3>
        <p className="text-xs text-text-muted mt-1.5 max-w-xs leading-relaxed">
          The system is live. Conferences appear automatically when FreeSWITCH bridges an emergency call.
        </p>
      </div>
      {/* Status pills */}
      <div className="relative z-10 flex flex-col items-center gap-1.5">
        <span className={`flex items-center gap-1.5 text-[11px] font-medium px-2.5 py-1 rounded-full
          ${esl?.connected
            ? 'bg-emerald-500/10 text-emerald-500'
            : 'bg-red-500/10 text-red-500'}`}>
          <span className={`w-1.5 h-1.5 rounded-full animate-pulse
            ${esl?.connected ? 'bg-emerald-500' : 'bg-red-500'}`} />
          {esl?.connected ? 'Connected to FreeSWITCH ESL' : 'Reconnecting to FreeSWITCH…'}
        </span>
        <span className="flex items-center gap-1.5 text-[11px] text-text-muted">
          <Activity size={10} /> Subscribed to conference::maintenance events
        </span>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Recent Conferences
// ─────────────────────────────────────────────────────────────────────────────

function RecentConferences({ incidents }) {
  if (!incidents.length) return null;
  return (
    <div className="card !p-0 overflow-hidden">
      <div className="flex items-center gap-2 px-4 py-2.5 border-b border-surface-border bg-surface-hover/30">
        <Database size={12} className="text-text-muted" />
        <span className="text-xs font-bold text-text-primary">Recent Conferences</span>
        <span className="ml-auto text-[10px] text-text-muted">Last {incidents.length} completed</span>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-left border-collapse">
          <thead>
            <tr className="border-b border-surface-border">
              {['Room', 'ERS / Organization', 'Caller', 'Recording', 'Ended'].map(h => (
                <th key={h} className="px-3 py-2 text-[9px] font-bold uppercase tracking-widest
                                       text-text-muted bg-surface-hover/20 whitespace-nowrap">
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {incidents.map((inc, i) => (
              <tr key={inc.incident_uuid || i}
                  className="border-b border-surface-border/30 hover:bg-surface-hover transition-colors">
                <td className="px-3 py-2">
                  <p className="text-xs font-mono font-semibold text-text-primary">{inc.conference_room || '—'}</p>
                </td>
                <td className="px-3 py-2">
                  <p className="text-xs text-text-primary">{inc.ers_name || '—'}</p>
                  <p className="text-[10px] text-text-muted">{inc.organization_name || ''}</p>
                </td>
                <td className="px-3 py-2 font-mono text-[10px] text-text-muted">{inc.caller_number || '—'}</td>
                <td className="px-3 py-2">
                  {inc.recording_path ? (
                    <span className="text-[10px] px-1.5 py-px rounded-full bg-blue-500/15 text-blue-400 font-medium">
                      Available
                    </span>
                  ) : (
                    <span className="text-[10px] text-text-muted">None</span>
                  )}
                </td>
                <td className="px-3 py-2 text-[10px] text-text-muted whitespace-nowrap">
                  {fmtDateTime(inc.ended_at || inc.started_at)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Main — Conference Operations Center
// ─────────────────────────────────────────────────────────────────────────────

export default function Monitoring() {
  const [conferences,   setConferences]   = useState([]);
  const [esl,           setEsl]           = useState(null);
  const [events,        setEvents]        = useState([]);
  const [selectedConf,  setSelectedConf]  = useState(null);
  const [loading,       setLoading]       = useState(true);
  const [recentHistory, setRecentHistory] = useState([]);
  const [eslLatency,    setEslLatency]    = useState(null);
  const [now,           setNow]           = useState(() => Date.now());

  // Chart history — refs so interval doesn't recreate
  const confsRef           = useRef([]);
  const eventCountRef      = useRef(0);
  const [partHist,  setPartHist]  = useState([0]);
  const [confHist,  setConfHist]  = useState([0]);
  const [eventsHist, setEventsHist] = useState([0]);
  const eventIdRef = useRef(0);

  // Keep confsRef in sync
  useEffect(() => { confsRef.current = conferences; }, [conferences]);

  // Clock — 1 s
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);

  // Chart sampling — every 10 s
  useEffect(() => {
    const t = setInterval(() => {
      const cs = confsRef.current;
      const total = cs.reduce((s, c) => s + (c.members?.length ?? 0), 0);
      const addPt = (setter, v) => setter(prev => {
        const n = [...prev, v];
        return n.length > MAX_CHART_POINTS ? n.slice(-MAX_CHART_POINTS) : n;
      });
      addPt(setPartHist,  total);
      addPt(setConfHist,  cs.length);
      addPt(setEventsHist, eventCountRef.current);
      eventCountRef.current = 0;
    }, CHART_INTERVAL_MS);
    return () => clearInterval(t);
  }, []);

  // ESL latency ping — every 30 s
  useEffect(() => {
    async function ping() {
      const t0 = Date.now();
      try { await api.monitoring.status(); setEslLatency(Date.now() - t0); }
      catch  { setEslLatency(null); }
    }
    ping();
    const t = setInterval(ping, 30_000);
    return () => clearInterval(t);
  }, []);

  // ── Initial load ──────────────────────────────────────────────────────────
  const load = useCallback(async () => {
    try {
      const [main, hist] = await Promise.all([
        api.monitoring.conferences(),
        api.ers.incidents({ status: 'COMPLETED', limit: 20 }).catch(() => null),
      ]);
      setConferences(main.conferences || []);
      setEsl(main.esl);
      const rows = hist?.incidents || hist?.rows || hist?.data || [];
      setRecentHistory(rows);
    } catch (e) {
      console.error('COC load failed', e);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  // ── Event push ───────────────────────────────────────────────────────────
  const pushEvent = useCallback((type, detail) => {
    eventCountRef.current++;
    setEvents(prev => {
      const next = [{ id: eventIdRef.current++, type, detail, ts: new Date().toISOString() }, ...prev];
      return next.length > MAX_EVENTS ? next.slice(0, MAX_EVENTS) : next;
    });
  }, []);

  // ── Socket subscriptions ─────────────────────────────────────────────────
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
      upConf(confName, c => ({ ...c, members: c.members.map(m => m.id === id ? fn(m) : m) }));
    }

    const handlers = {
      'conference.created': ({ confName }) => {
        setConferences(prev => {
          if (prev.find(c => c.name === confName)) return prev;
          return [...prev, { name: confName, members: [], locked: false, recording: false, createdAt: new Date().toISOString() }];
        });
        pushEvent('conference.created', `New conference: ${confName}`);
      },
      'conference.ended': ({ confName }) => {
        setConferences(prev => prev.filter(c => c.name !== confName));
        setSelectedConf(s => s === confName ? null : s);
        pushEvent('conference.ended', `Conference ended: ${confName}`);
        setTimeout(load, 1000); // refresh recent history
      },
      'conference.member.joined': ({ confName, memberData, callerNum, callerName }) => {
        const data = memberData || { id: callerNum || Date.now(), callerNum, callerName, muted: false, deaf: false, moderator: false, talking: false, joinedAt: new Date().toISOString() };
        upConf(confName, c => {
          if (c.members.find(m => m.id === data.id)) return c;
          return { ...c, members: [...c.members, data] };
        });
        pushEvent('conference.member.joined', `${callerName || callerNum || 'Member'} joined ${confName}`);
      },
      'conference.member.left': ({ confName, member: id, callerNum }) => {
        upConf(confName, c => ({ ...c, members: c.members.filter(m => m.id !== id) }));
        pushEvent('conference.member.left', `${callerNum || id} left ${confName}`);
      },
      'conference.member.muted': ({ confName, member: id, muted, callerNum }) => {
        upMember(confName, id, m => ({ ...m, muted }));
        pushEvent('conference.member.muted', `${callerNum || id} ${muted ? 'muted' : 'unmuted'} in ${confName}`);
      },
      'conference.member.deaf': ({ confName, member: id, deaf, callerNum }) => {
        upMember(confName, id, m => ({ ...m, deaf }));
        pushEvent('conference.member.deaf', `${callerNum || id} ${deaf ? 'deafened' : 'undeafened'}`);
      },
      'conference.member.talking': ({ confName, member: id, talking, callerNum }) => {
        upMember(confName, id, m => ({ ...m, talking }));
        if (talking) pushEvent('conference.member.talking', `${callerNum || id} speaking in ${confName}`);
      },
      'conference.floor.changed': ({ confName, member: id }) => {
        upConf(confName, c => ({
          ...c, floorHolder: id,
          members: c.members.map(m => ({ ...m, floor: m.id === id })),
        }));
        pushEvent('conference.floor.changed', `Floor → ${id} in ${confName}`);
      },
      'conference.locked': ({ confName, locked }) => {
        upConf(confName, c => ({ ...c, locked }));
        pushEvent('conference.locked', `${confName} ${locked ? 'locked' : 'unlocked'}`);
      },
      'conference.recording': ({ confName, recording }) => {
        upConf(confName, c => ({ ...c, recording }));
        pushEvent('conference.recording', `${confName}: recording ${recording ? 'started' : 'stopped'}`);
      },
    };

    for (const [ev, fn] of Object.entries(handlers)) socket.on(ev, fn);
    return () => { for (const [ev, fn] of Object.entries(handlers)) socket.off(ev, fn); };
  }, [pushEvent, load]);

  // ── Derived ───────────────────────────────────────────────────────────────
  const totalMembers    = useMemo(() => conferences.reduce((s, c) => s + (c.members?.length ?? 0), 0), [conferences]);
  const totalModerators = useMemo(() => conferences.reduce((s, c) => s + (c.members?.filter(m => m.moderator).length ?? 0), 0), [conferences]);
  const recordingCount  = useMemo(() => conferences.filter(c => c.recording).length, [conferences]);
  const selectedConference = useMemo(() => conferences.find(c => c.name === selectedConf) ?? null, [conferences, selectedConf]);
  const clockStr = useMemo(() => new Date(now).toLocaleTimeString(), [now]);

  function toggleSelect(name) {
    setSelectedConf(s => s === name ? null : name);
  }

  return (
    <div className="space-y-3 pb-10">

      {/* ── Header ── */}
      <div className="flex items-center gap-3 flex-wrap pb-1">
        <div className="flex items-center gap-2.5 min-w-0">
          <div className="w-9 h-9 rounded-xl bg-emerald-500/15 flex items-center justify-center shrink-0">
            <Monitor size={17} className="text-emerald-500" />
          </div>
          <div>
            <h1 className="text-base font-bold text-text-primary leading-tight">
              Conference Operations Center
            </h1>
            <p className="text-[10px] text-text-muted">
              Real-time FreeSWITCH monitoring &amp; moderator control
            </p>
          </div>
        </div>

        <div className="ml-auto flex items-center gap-2.5 flex-wrap">
          {/* ESL status pill */}
          <div className={`flex items-center gap-1.5 text-[11px] px-2.5 py-1 rounded-full border font-semibold
            ${esl?.connected
              ? 'border-emerald-500/30 bg-emerald-500/8 text-emerald-500'
              : 'border-red-500/30 bg-red-500/8 text-red-500'}`}>
            {esl?.connected ? <Wifi size={10} /> : <WifiOff size={10} />}
            {esl?.connected
              ? `ESL · ${esl.host || 'localhost'}:${esl.port || 8021}`
              : 'ESL Offline'}
            <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${esl?.connected ? 'bg-emerald-500 animate-pulse' : 'bg-red-500'}`} />
          </div>
          {/* Latency */}
          {eslLatency != null && (
            <span className="text-[11px] text-text-muted flex items-center gap-1">
              <Signal size={10} className={eslLatency < 80 ? 'text-emerald-500' : 'text-amber-500'} />
              <span className="tabular-nums">{eslLatency}ms</span>
            </span>
          )}
          {/* Clock */}
          <span className="text-[11px] font-mono tabular-nums text-text-muted">{clockStr}</span>
          {/* Refresh */}
          <button onClick={load}
                  className="flex items-center gap-1 text-[11px] btn-ghost py-1 px-2 text-text-muted hover:text-text-primary">
            <RefreshCw size={10} /> Refresh
          </button>
        </div>
      </div>

      {/* ── KPI row ── */}
      <div className="grid grid-cols-3 sm:grid-cols-6 gap-2">
        <KpiCard icon={PhoneCall}  label="Conferences" value={conferences.length}
          sub="Live right now" valueClass="text-emerald-500"
          sparkData={confHist} sparkColor="#10b981" pulse={conferences.length > 0} />
        <KpiCard icon={Users}      label="Participants" value={totalMembers}
          sub="Across all rooms" valueClass="text-blue-400"
          sparkData={partHist} sparkColor="#60a5fa" />
        <KpiCard icon={Shield}     label="Responders"   value={totalModerators}
          sub="Moderator members" valueClass="text-amber-400" />
        <KpiCard icon={Radio}      label="Recording"    value={recordingCount}
          sub="Active sessions" danger={true} pulse={recordingCount > 0} />
        <KpiCard icon={Activity}   label="Event Rate"   value={eventsHist.at(-1) ?? 0}
          sub={`Per ${CHART_INTERVAL_MS / 1000}s interval`} valueClass="text-purple-400"
          sparkData={eventsHist} sparkColor="#c084fc" />
        <KpiCard icon={Signal}     label="ESL Latency"  value={eslLatency != null ? `${eslLatency}ms` : '—'}
          sub="Backend round-trip"
          valueClass={eslLatency != null && eslLatency < 80 ? 'text-emerald-500' : 'text-amber-400'} />
      </div>

      {/* ── Main grid: table + feed ── */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-3">
        <div className="lg:col-span-2">
          {loading ? (
            <div className="card animate-pulse" style={{ height: '240px' }} />
          ) : conferences.length === 0 ? (
            <EmptyState esl={esl} />
          ) : (
            <ConferenceTable
              conferences={conferences}
              selectedConf={selectedConf}
              onSelect={toggleSelect}
              now={now}
            />
          )}
        </div>
        <div className="lg:col-span-1">
          <EventFeed events={events} />
        </div>
      </div>

      {/* ── Selected conference detail ── */}
      {selectedConference && (
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-3">
          <div className="lg:col-span-2">
            <ParticipantPanel conf={selectedConference} />
          </div>
          <div className="lg:col-span-1">
            <ConferenceControls conf={selectedConference} />
          </div>
        </div>
      )}

      {/* ── Sparklines ── */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
        {[
          { label: 'Participants Over Time', data: partHist,   color: '#60a5fa', current: totalMembers },
          { label: 'Active Conferences',     data: confHist,   color: '#10b981', current: conferences.length },
          { label: 'Events / Interval',      data: eventsHist, color: '#c084fc', current: eventsHist.at(-1) ?? 0 },
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

      {/* ── Recent history ── */}
      <RecentConferences incidents={recentHistory} />
    </div>
  );
}
