/**
 * Conference Operations Center — Enterprise NOC Dashboard
 *
 * Layout:
 *   Header + KPI strip (full width)
 *   ┌── Left 25% ──┬──── Center 50% ────┬── Right 25% ──┐
 *   │ Conference   │ Conference Details  │ Controls       │
 *   │ Cards        │ Participant Table   │                │
 *   └──────────────┴────────────────────┴────────────────┘
 *   Live Event Timeline (full width)
 *   Sparkline charts (full width)
 */
import {
  useEffect, useState, useCallback, useRef, useMemo, memo,
} from 'react';
import {
  Activity, Wifi, WifiOff, Users, Lock, Unlock,
  Mic, MicOff, PhoneOff, Radio, Pause, Square,
  PhoneIncoming, Trash2, ChevronDown,
  Headphones, EarOff, Shield, RefreshCw, Zap,
  PhoneCall, Bell, Signal, ArrowRight,
  Monitor, BarChart2, Hash,
} from 'lucide-react';
import { api } from '../api/client.js';
import { socket } from '../api/socket.js';

// ─────────────────────────────────────────────────────────────────────────────
// Constants
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
// Utilities
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
// Sparkline — pure SVG, no library dependency
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
// KPI Card
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
// LEFT PANEL — Conference Card List
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
      {/* Header row */}
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
        {/* Status badges */}
        <div className="flex flex-col items-end gap-1 shrink-0">
          {conf.recording && (
            <span className="text-[8px] px-1.5 py-px rounded-full bg-red-500/15 text-red-500
                             font-bold flex items-center gap-0.5 animate-pulse">
              <Radio size={6} /> REC
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

      {/* Stats row */}
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

      <div className="flex-1 overflow-y-auto space-y-2">
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
              <p className="text-[10px] text-text-muted mt-0.5">
                Waiting for FreeSWITCH activity…
              </p>
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
function MetaItem({ label, children }) {
  return (
    <div className="flex items-start gap-2 py-1.5 border-b border-surface-border/30 last:border-0">
      <span className="text-[10px] text-text-muted w-24 shrink-0 pt-px">{label}</span>
      <div className="text-[11px] font-medium text-text-primary flex-1">{children}</div>
    </div>
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

  async function act(fn, ...args) {
    try { await fn(room, ...args); }
    catch (e) { console.error('[monitoring] action failed:', e.message); }
  }

  return (
    <div className="overflow-x-auto">
      <table className="w-full text-left border-collapse">
        <thead>
          <tr>
            {['ID', 'Name', 'Number', 'Role', 'Audio', 'Speaking', 'Energy', 'Joined', 'UUID', 'Actions'].map(h => (
              <th key={h}
                  className="px-2.5 py-2 text-[9px] font-bold uppercase tracking-wider
                             text-text-muted bg-surface-hover/40 whitespace-nowrap
                             border-b border-surface-border first:rounded-tl last:rounded-tr">
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {sorted.map(m => {
            const name       = m.callerName || '';
            const num        = m.callerNum  || '';
            const display    = name || num || `#${m.id}`;
            const joinSecs   = m.joinedAt ? elapsedSec(m.joinedAt, now) : null;
            const shortUuid  = m.uuid ? m.uuid.split('-')[0] : '—';

            return (
              <tr key={m.id}
                  className={[
                    'border-b border-surface-border/25 transition-colors',
                    m.talking ? 'bg-green-500/5' : 'hover:bg-surface-hover/60',
                  ].join(' ')}>

                {/* ID */}
                <td className="px-2.5 py-2">
                  <span className="text-[10px] font-mono font-semibold text-text-muted">
                    #{m.id}
                  </span>
                </td>

                {/* Name */}
                <td className="px-2.5 py-2 max-w-[120px]">
                  <div className="flex items-center gap-1.5">
                    {m.talking && (
                      <div className="flex items-end gap-px h-3 shrink-0">
                        {[1, 2, 3].map((_, i) => (
                          <div key={i}
                               className="w-px rounded-full bg-green-500"
                               style={{
                                 height: `${(i + 1) * 3}px`,
                                 animation: `pulse 0.6s ease-in-out ${i * 0.15}s infinite alternate`,
                               }} />
                        ))}
                      </div>
                    )}
                    <span className="text-xs font-medium text-text-primary truncate">
                      {name || <span className="text-text-muted italic text-[10px]">—</span>}
                    </span>
                  </div>
                </td>

                {/* Number */}
                <td className="px-2.5 py-2">
                  <span className="text-[10px] font-mono text-text-secondary">{num || '—'}</span>
                </td>

                {/* Role */}
                <td className="px-2.5 py-2 whitespace-nowrap">
                  <div className="flex items-center gap-1">
                    {m.moderator ? (
                      <span className="text-[9px] px-1.5 py-px rounded-full
                                       bg-amber-500/15 text-amber-500 font-bold
                                       flex items-center gap-0.5">
                        <Shield size={7} /> MOD
                      </span>
                    ) : (
                      <span className="text-[9px] px-1.5 py-px rounded-full
                                       bg-surface-hover text-text-muted">
                        PART
                      </span>
                    )}
                    {m.floor && (
                      <span className="text-[9px] px-1 py-px rounded
                                       bg-purple-500/15 text-purple-400 font-bold">
                        FL
                      </span>
                    )}
                  </div>
                </td>

                {/* Audio (mute + deaf) */}
                <td className="px-2.5 py-2 whitespace-nowrap">
                  <div className="flex items-center gap-1">
                    {m.muted ? (
                      <span className="text-[9px] px-1.5 py-px rounded-full
                                       bg-red-500/15 text-red-500 font-bold">
                        MUTED
                      </span>
                    ) : (
                      <span className="text-[9px] text-emerald-500 font-medium">MIC</span>
                    )}
                    {m.deaf && (
                      <span className="text-[9px] px-1 py-px rounded
                                       bg-orange-500/15 text-orange-500 font-bold">
                        DEAF
                      </span>
                    )}
                  </div>
                </td>

                {/* Speaking */}
                <td className="px-2.5 py-2 text-center">
                  {m.talking
                    ? <span className="text-[9px] text-green-500 font-bold">● LIVE</span>
                    : <span className="text-[9px] text-text-muted/40">–</span>
                  }
                </td>

                {/* Energy */}
                <td className="px-2.5 py-2 text-right">
                  <span className="text-[10px] font-mono tabular-nums text-text-muted">
                    {m.energy ?? 0}
                  </span>
                </td>

                {/* Joined */}
                <td className="px-2.5 py-2 whitespace-nowrap">
                  <span className="text-[9px] font-mono text-text-muted tabular-nums">
                    {joinSecs != null ? fmtDur(joinSecs) : '—'}
                  </span>
                </td>

                {/* UUID (truncated) */}
                <td className="px-2.5 py-2">
                  <span className="text-[9px] font-mono text-text-muted/60" title={m.uuid}>
                    {shortUuid}
                  </span>
                </td>

                {/* Actions */}
                <td className="px-2.5 py-2">
                  <div className="flex items-center gap-0.5">
                    <button
                      title={m.muted ? 'Unmute' : 'Mute'}
                      onClick={() => act(m.muted ? api.monitoring.unmute : api.monitoring.mute, m.id)}
                      className="p-1 rounded hover:bg-surface-hover text-text-muted
                                 hover:text-text-primary transition-colors">
                      {m.muted ? <Mic size={11} /> : <MicOff size={11} />}
                    </button>
                    <button
                      title="Give Floor"
                      onClick={() => act(api.monitoring.floor, m.id)}
                      className="p-1 rounded hover:bg-surface-hover text-text-muted
                                 hover:text-purple-400 transition-colors">
                      <ArrowRight size={11} />
                    </button>
                    <button
                      title="Kick participant"
                      onClick={() => {
                        if (window.confirm(`Kick ${display} from ${room}?`)) {
                          act(api.monitoring.kick, m.id);
                        }
                      }}
                      className="p-1 rounded hover:bg-red-500/10 text-text-muted
                                 hover:text-red-500 transition-colors">
                      <PhoneOff size={11} />
                    </button>
                  </div>
                </td>
              </tr>
            );
          })}
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
          <p className="text-sm font-semibold text-text-secondary">
            Select a Conference
          </p>
          <p className="text-xs text-text-muted mt-1.5 leading-relaxed">
            Click a conference card in the left panel to view participants and details
          </p>
        </div>
      </div>
    );
  }

  const secs  = elapsedSec(conf.createdAt, now);
  const count = conf.members?.length ?? 0;
  const mods  = conf.members?.filter(m => m.moderator).length ?? 0;

  return (
    <div className="h-full flex flex-col gap-4 overflow-y-auto">

      {/* Conference metadata grid */}
      <div>
        <div className="flex items-center gap-2 mb-2 shrink-0">
          <Hash size={11} className="text-primary" />
          <span className="text-xs font-bold text-text-primary">Conference Details</span>
          <span className="text-xs font-mono text-text-muted">— {conf.name}</span>
        </div>
        <div className="card !p-3 grid grid-cols-2 gap-x-8">
          <div>
            <MetaItem label="Conference ID">
              <span className="font-mono">{conf.name}</span>
            </MetaItem>
            <MetaItem label="Duration">
              <span className="font-mono tabular-nums">{fmtDur(secs)}</span>
            </MetaItem>
            <MetaItem label="Sample Rate">
              {conf.rate ? `${conf.rate} Hz` : '8000 Hz'}
            </MetaItem>
            <MetaItem label="Participants">
              {count} ({mods} moderator{mods !== 1 ? 's' : ''})
            </MetaItem>
          </div>
          <div>
            <MetaItem label="Recording">
              {conf.recording ? (
                <span className="flex items-center gap-1 text-[10px] px-1.5 py-px rounded-full
                                 bg-red-500/15 text-red-500 font-bold animate-pulse w-fit">
                  <Radio size={8} /> ACTIVE
                </span>
              ) : (
                <span className="text-text-muted text-[10px]">None</span>
              )}
            </MetaItem>
            <MetaItem label="Lock State">
              {conf.locked ? (
                <span className="flex items-center gap-1 text-[10px] px-1.5 py-px rounded-full
                                 bg-amber-500/15 text-amber-500 font-bold w-fit">
                  <Lock size={8} /> LOCKED
                </span>
              ) : (
                <span className="text-emerald-500 text-[10px] font-medium">Open</span>
              )}
            </MetaItem>
            <MetaItem label="Type">
              <span className="font-mono text-[10px]">{conf.flags || 'dynamic'}</span>
            </MetaItem>
            {conf.incident?.organization_name && (
              <MetaItem label="Organization">
                {conf.incident.organization_name}
              </MetaItem>
            )}
            {conf.incident?.ers_name && (
              <MetaItem label="ERS Config">
                {conf.incident.ers_name}
              </MetaItem>
            )}
          </div>
        </div>
      </div>

      {/* Participant table */}
      <div className="flex-1 min-h-0">
        <div className="flex items-center gap-2 mb-2 shrink-0">
          <Users size={11} className="text-blue-500" />
          <span className="text-xs font-bold text-text-primary">Participants</span>
          <span className="text-[10px] px-1.5 py-px rounded-full bg-blue-500/15
                           text-blue-400 font-bold ml-1">
            {count}
          </span>
        </div>
        <div className="card !p-0 overflow-hidden">
          <ParticipantTable members={conf.members || []} room={conf.name} now={now} />
        </div>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// RIGHT PANEL — Conference Controls
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
        disabled
          ? 'opacity-35 cursor-not-allowed border-surface-border text-text-muted'
          : variant === 'danger'
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

function RightPanel({ conf }) {
  const [sayText,    setSayText]    = useState('');
  const [dialStr,    setDialStr]    = useState('');
  const [showSay,    setShowSay]    = useState(false);
  const [showInvite, setShowInvite] = useState(false);

  const disabled = !conf;
  const name     = conf?.name;

  async function act(fn, ...args) {
    if (!name) return;
    try { await fn(name, ...args); }
    catch (e) { alert('Command failed: ' + (e.message || 'Unknown error')); }
  }

  function recPath() {
    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    return `/var/lib/freeswitch/recordings/conf_${name}_${ts}.wav`;
  }

  return (
    <div className="h-full flex flex-col">
      <div className="flex items-center gap-2 mb-3 shrink-0">
        <Zap size={12} className="text-amber-500" />
        <span className="text-xs font-bold text-text-primary">Controls</span>
        {conf?.recording && (
          <span className="ml-auto text-[9px] px-1.5 py-px rounded-full
                           bg-red-500/15 text-red-500 font-bold animate-pulse flex items-center gap-0.5">
            <Radio size={7} /> REC
          </span>
        )}
        {!conf && (
          <span className="ml-auto text-[9px] text-text-muted">No selection</span>
        )}
      </div>

      <div className="flex-1 overflow-y-auto space-y-4">

        {/* Conference controls */}
        <div>
          <p className="text-[9px] uppercase tracking-widest text-text-muted font-bold mb-2">
            Conference
          </p>
          <div className="space-y-1.5">
            <CtrlBtn
              icon={conf?.locked ? Unlock : Lock}
              label={conf?.locked ? 'Unlock Conference' : 'Lock Conference'}
              active={conf?.locked}
              disabled={disabled}
              wide
              onClick={() => act(conf?.locked ? api.monitoring.unlock : api.monitoring.lock)}
            />
            <div className="flex gap-1.5">
              <CtrlBtn icon={MicOff} label="Mute All" disabled={disabled}
                onClick={() => conf?.members?.forEach(m => api.monitoring.mute(name, m.id))} />
              <CtrlBtn icon={Mic} label="Unmute All" disabled={disabled}
                onClick={() => conf?.members?.forEach(m => api.monitoring.unmute(name, m.id))} />
            </div>
          </div>
        </div>

        {/* Recording */}
        <div>
          <p className="text-[9px] uppercase tracking-widest text-text-muted font-bold mb-2">
            Recording
          </p>
          <div className="space-y-1.5">
            {!conf?.recording ? (
              <CtrlBtn icon={Radio} label="Start Recording" disabled={disabled} wide
                onClick={() => act(api.monitoring.recordStart, recPath())} />
            ) : (
              <>
                <CtrlBtn icon={Pause} label="Pause Recording" active wide
                  onClick={() => act(api.monitoring.recordPause, conf.recording)} />
                <CtrlBtn icon={Square} label="Stop Recording" variant="danger" wide
                  onClick={() => act(api.monitoring.recordStop, conf.recording)} />
              </>
            )}
          </div>
        </div>

        {/* Broadcast */}
        <div>
          <p className="text-[9px] uppercase tracking-widest text-text-muted font-bold mb-2">
            Broadcast
          </p>
          <div className="space-y-1.5">
            {/* TTS */}
            <button
              disabled={disabled}
              onClick={() => { if (!disabled) { setShowSay(s => !s); setShowInvite(false); } }}
              className={[
                'w-full flex items-center gap-2 px-3 py-2 rounded-lg border text-xs font-medium transition-colors',
                disabled
                  ? 'opacity-35 cursor-not-allowed border-surface-border text-text-muted'
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
                  await act(api.monitoring.say, sayText.trim());
                  setSayText(''); setShowSay(false);
                }}
                className="flex gap-1.5"
              >
                <input
                  autoFocus
                  value={sayText}
                  onChange={e => setSayText(e.target.value)}
                  placeholder="Announcement text…"
                  className="flex-1 input text-xs py-1.5 px-2.5"
                />
                <button type="submit" className="btn-primary text-xs px-3">Say</button>
              </form>
            )}

            {/* Invite */}
            <button
              disabled={disabled}
              onClick={() => { if (!disabled) { setShowInvite(s => !s); setShowSay(false); } }}
              className={[
                'w-full flex items-center gap-2 px-3 py-2 rounded-lg border text-xs font-medium transition-colors',
                disabled
                  ? 'opacity-35 cursor-not-allowed border-surface-border text-text-muted'
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
                  await act(api.monitoring.invite, dialStr.trim());
                  setDialStr(''); setShowInvite(false);
                }}
                className="flex gap-1.5"
              >
                <input
                  autoFocus
                  value={dialStr}
                  onChange={e => setDialStr(e.target.value)}
                  placeholder="Extension or sip:user@domain"
                  className="flex-1 input text-xs py-1.5 px-2.5"
                />
                <button type="submit" className="btn-primary text-xs px-3">Dial</button>
              </form>
            )}
          </div>
        </div>

        {/* Danger zone */}
        <div className="pt-2 border-t border-surface-border">
          <p className="text-[9px] uppercase tracking-widest text-red-500/50 font-bold mb-2">
            Danger Zone
          </p>
          <CtrlBtn
            icon={Trash2}
            label="Terminate Conference"
            variant="danger"
            wide
            disabled={disabled}
            onClick={() => {
              if (window.confirm(
                `Terminate conference "${name}"?\n\n` +
                `All ${conf?.members?.length ?? 0} participant(s) will be immediately disconnected.`
              )) {
                act(api.monitoring.terminate);
              }
            }}
          />
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
      <span className={`text-[10px] font-semibold shrink-0 w-32 ${cfg.color}`}>
        {cfg.label}
      </span>
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
          <span className="ml-2 text-[10px] px-1.5 py-px rounded-full
                           bg-surface-hover text-text-muted font-mono">
            {events.length}
          </span>
        )}
        <span className="ml-auto w-1.5 h-1.5 rounded-full bg-emerald-500 animate-pulse" />
      </div>
      <div ref={listRef} className="overflow-y-auto px-4 py-1" style={{ maxHeight: '180px' }}>
        {events.length === 0 ? (
          <div className="flex items-center justify-center gap-2 py-5">
            <Bell size={12} className="text-text-muted/25" />
            <p className="text-xs text-text-muted">Subscribed to conference events — waiting…</p>
          </div>
        ) : (
          events.map(e => <TimelineRow key={e.id} ev={e} />)
        )}
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
  const [eslLatency,    setEslLatency]    = useState(null);
  const [now,           setNow]           = useState(() => Date.now());
  const [lastSync,      setLastSync]      = useState(null);

  // Chart history — refs so interval closure doesn't stale
  const confsRef      = useRef([]);
  const eventCountRef = useRef(0);
  const eventIdRef    = useRef(0);
  const [partHist,  setPartHist]  = useState([0]);
  const [confHist,  setConfHist]  = useState([0]);
  const [evHist,    setEvHist]    = useState([0]);

  useEffect(() => { confsRef.current = conferences; }, [conferences]);

  // 1-second clock for duration counters
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);

  // Chart sampling every 10 s
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

  // ESL latency probe every 30 s
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

  // ── Data load ──────────────────────────────────────────────────────────────
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

  // ── Event push helper ──────────────────────────────────────────────────────
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

  // ── Socket subscriptions ───────────────────────────────────────────────────
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
        if (status.connected) {
          // Re-load on reconnect so the registry is fresh
          setTimeout(load, 1000);
        }
      },
      'conference.created': ({ confName }) => {
        setConferences(prev => {
          if (prev.find(c => c.name === confName)) return prev;
          return [...prev, {
            name: confName, members: [], locked: false,
            recording: false, rate: null, flags: null,
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
      'conference.member.joined': ({ confName, memberData, callerNum, callerName }) => {
        const data = memberData || {
          id: callerNum || String(Date.now()),
          callerNum, callerName,
          muted: false, deaf: false, moderator: false,
          talking: false, floor: false, energy: 0,
          joinedAt: new Date().toISOString(),
        };
        upConf(confName, c => {
          if (c.members.find(m => m.id === data.id)) return c;
          return { ...c, members: [...c.members, data] };
        });
        pushEvent('conference.member.joined',
          `${callerName || callerNum || 'Member'} joined ${confName}`);
      },
      'conference.member.left': ({ confName, member: id, callerNum }) => {
        upConf(confName, c => ({
          ...c, members: c.members.filter(m => m.id !== id),
        }));
        pushEvent('conference.member.left', `${callerNum || id} left ${confName}`);
      },
      'conference.member.muted': ({ confName, member: id, muted, callerNum }) => {
        upMember(confName, id, m => ({ ...m, muted }));
        pushEvent('conference.member.muted',
          `${callerNum || id} ${muted ? 'muted' : 'unmuted'} in ${confName}`);
      },
      'conference.member.deaf': ({ confName, member: id, deaf }) => {
        upMember(confName, id, m => ({ ...m, deaf }));
        pushEvent('conference.member.deaf', `Deaf state changed in ${confName}`);
      },
      'conference.member.talking': ({ confName, member: id, talking, callerNum }) => {
        upMember(confName, id, m => ({ ...m, talking }));
        if (talking) {
          pushEvent('conference.member.talking',
            `${callerNum || id} speaking in ${confName}`);
        }
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
      'conference.recording': ({ confName, recording }) => {
        upConf(confName, c => ({ ...c, recording }));
        pushEvent('conference.recording',
          `${confName}: recording ${recording ? 'started' : 'stopped'}`);
      },
    };

    for (const [ev, fn] of Object.entries(handlers)) socket.on(ev, fn);
    return () => {
      for (const [ev, fn] of Object.entries(handlers)) socket.off(ev, fn);
    };
  }, [pushEvent, load]);

  // ── Derived ────────────────────────────────────────────────────────────────
  const totalMembers    = useMemo(
    () => conferences.reduce((s, c) => s + (c.members?.length ?? 0), 0),
    [conferences]
  );
  const totalModerators = useMemo(
    () => conferences.reduce((s, c) => s + (c.members?.filter(m => m.moderator).length ?? 0), 0),
    [conferences]
  );
  const recordingCount  = useMemo(
    () => conferences.filter(c => c.recording).length,
    [conferences]
  );
  const selectedConference = useMemo(
    () => conferences.find(c => c.name === selectedConf) ?? null,
    [conferences, selectedConf]
  );
  const clockStr = useMemo(() => new Date(now).toLocaleTimeString(), [now]);

  function toggleSelect(name) {
    setSelectedConf(s => s === name ? null : name);
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Render
  // ─────────────────────────────────────────────────────────────────────────
  return (
    <div className="space-y-3 pb-10">

      {/* ── Header ── */}
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
              {lastSync && ` · Last sync ${fmtTime(lastSync)}`}
            </p>
          </div>
        </div>

        <div className="ml-auto flex items-center gap-2.5 flex-wrap">
          {/* ESL status */}
          <div className={`flex items-center gap-1.5 text-[11px] px-2.5 py-1 rounded-full
              border font-semibold
              ${esl?.connected
                ? 'border-emerald-500/30 bg-emerald-500/8 text-emerald-500'
                : 'border-red-500/30 bg-red-500/8 text-red-500'}`}>
            {esl?.connected ? <Wifi size={10} /> : <WifiOff size={10} />}
            {esl?.connected
              ? `ESL · ${esl.host}:${esl.port}`
              : 'ESL Offline'}
            <span className={`w-1.5 h-1.5 rounded-full shrink-0
              ${esl?.connected ? 'bg-emerald-500 animate-pulse' : 'bg-red-500'}`} />
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
                  className="flex items-center gap-1 text-[11px] btn-ghost py-1 px-2
                             text-text-muted hover:text-text-primary">
            <RefreshCw size={10} /> Refresh
          </button>
        </div>
      </div>

      {/* ── KPI strip ── */}
      <div className="grid grid-cols-3 sm:grid-cols-6 gap-2">
        <KpiCard icon={PhoneCall}  label="Conferences"  value={conferences.length}
          sub="Live right now"    valueClass="text-emerald-500"
          sparkData={confHist}   sparkColor="#10b981"  pulse={conferences.length > 0} />
        <KpiCard icon={Users}      label="Participants"  value={totalMembers}
          sub="Across all rooms"  valueClass="text-blue-400"
          sparkData={partHist}   sparkColor="#60a5fa" />
        <KpiCard icon={Shield}     label="Moderators"   value={totalModerators}
          sub="Active moderators" valueClass="text-amber-400" />
        <KpiCard icon={Radio}      label="Recording"    value={recordingCount}
          sub="Active sessions"   danger               pulse={recordingCount > 0} />
        <KpiCard icon={Activity}   label="Event Rate"   value={evHist.at(-1) ?? 0}
          sub={`Per ${CHART_INTERVAL_MS / 1000}s`}    valueClass="text-purple-400"
          sparkData={evHist}     sparkColor="#c084fc" />
        <KpiCard icon={Signal}     label="ESL Latency"  value={eslLatency != null ? `${eslLatency}ms` : '—'}
          sub="Backend round-trip"
          valueClass={eslLatency != null && eslLatency < 80 ? 'text-emerald-500' : 'text-amber-400'} />
      </div>

      {/* ── 3-panel grid ── */}
      <div className="grid grid-cols-12 gap-3" style={{ minHeight: '520px', maxHeight: '640px' }}>

        {/* Left: conference list */}
        <div className="col-span-3 card !p-4 overflow-hidden flex flex-col">
          <LeftPanel
            conferences={conferences}
            selectedConf={selectedConf}
            onSelect={toggleSelect}
            now={now}
            loading={loading}
          />
        </div>

        {/* Center: details + participant table */}
        <div className="col-span-6 card !p-4 overflow-hidden">
          <CenterPanel conf={selectedConference} now={now} />
        </div>

        {/* Right: controls */}
        <div className="col-span-3 card !p-4 overflow-hidden">
          <RightPanel conf={selectedConference} />
        </div>
      </div>

      {/* ── Live Event Timeline ── */}
      <BottomTimeline events={events} />

      {/* ── Sparkline charts ── */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
        {[
          { label: 'Participants Over Time', data: partHist, color: '#60a5fa', current: totalMembers },
          { label: 'Active Conferences',     data: confHist, color: '#10b981', current: conferences.length },
          { label: 'Events / Interval',      data: evHist,   color: '#c084fc', current: evHist.at(-1) ?? 0 },
        ].map(({ label, data, color, current }) => (
          <div key={label} className="card !pb-2">
            <div className="flex items-center justify-between mb-1.5">
              <span className="text-[10px] font-bold uppercase tracking-widest text-text-muted
                               flex items-center gap-1">
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
