/**
 * Conference Operations Center
 *
 * Conference-centric view of all active FreeSWITCH conferences.
 * State is seeded from GET /monitoring/conferences (ESL registry + DB enrichment)
 * and kept live via Socket.IO conference::maintenance events only — no polling.
 */

import {
  useEffect, useState, useCallback, useRef, useMemo, memo,
} from 'react';
import {
  Activity, Wifi, WifiOff, Users, Clock, Lock, Unlock,
  Mic, MicOff, PhoneOff, Volume2, VolumeX, Radio, Send,
  Play, Pause, Square, PhoneIncoming, Trash2, ChevronDown,
  ChevronUp, Headphones, HeadphoneOff, MoreHorizontal,
  Shield, AlertTriangle, RefreshCw, Search, ArrowRight,
  Layers,
} from 'lucide-react';
import { api } from '../api/client.js';
import { socket } from '../api/socket.js';
import { useLiveDuration } from '../hooks/useLiveDuration.js';
import Badge from '../components/ui/Badge.jsx';
import PulsingDot from '../components/ui/PulsingDot.jsx';

// ── helpers ──────────────────────────────────────────────────────────────────

function elapsed(isoStart) {
  if (!isoStart) return '—';
  const s = Math.floor((Date.now() - new Date(isoStart)) / 1000);
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m ${s % 60}s`;
  return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
}

function useNow(intervalMs = 1000) {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(t);
  }, [intervalMs]);
  return now;
}

// ── Skeleton ─────────────────────────────────────────────────────────────────

function Skeleton({ className = '' }) {
  return (
    <div className={`animate-pulse bg-surface-hover rounded ${className}`} />
  );
}

function SkeletonCard() {
  return (
    <div className="card space-y-3 p-4">
      <div className="flex items-center gap-3">
        <Skeleton className="w-10 h-10 rounded-xl" />
        <div className="flex-1 space-y-1.5">
          <Skeleton className="h-3 w-40" />
          <Skeleton className="h-2 w-28" />
        </div>
        <Skeleton className="h-6 w-14 rounded-full" />
      </div>
    </div>
  );
}

// ── ControlButton ─────────────────────────────────────────────────────────────

const ControlButton = memo(function ControlButton({
  icon: Icon, label, onClick, danger = false, disabled = false, active = false,
}) {
  return (
    <button
      title={label}
      disabled={disabled}
      onClick={onClick}
      className={[
        'flex flex-col items-center gap-0.5 px-2 py-1.5 rounded-lg text-[10px] font-medium',
        'transition-colors select-none min-w-[44px]',
        disabled ? 'opacity-40 cursor-not-allowed' :
          danger   ? 'hover:bg-red-500/15 text-red-500' :
          active   ? 'bg-primary/15 text-primary' :
                     'hover:bg-surface-hover text-text-secondary hover:text-text-primary',
      ].join(' ')}
    >
      <Icon size={14} />
      {label}
    </button>
  );
});

// ── ParticipantRow ────────────────────────────────────────────────────────────

const ParticipantRow = memo(function ParticipantRow({ member, room, onAction }) {
  const {
    id,
    caller_name: _cn, callerName,
    caller_num: _num, callerNum,
    muted, deaf, talking, moderator,
    joined_at: _jat, joinedAt,
  } = member;
  const caller_name = _cn || callerName || '';
  const caller_num  = _num || callerNum  || '';
  const joined_at   = _jat || joinedAt   || null;

  const joinDuration = joined_at ? elapsed(joined_at) : '—';

  async function act(fn, ...args) {
    try { await fn(room, id, ...args); } catch (e) { console.error(e); }
  }

  return (
    <div className={[
      'flex items-center gap-3 px-3 py-2 rounded-lg',
      talking ? 'bg-green-500/8 border border-green-500/20' : 'hover:bg-surface-hover',
    ].join(' ')}>
      {/* Speaking indicator */}
      <div className={[
        'w-2 h-2 rounded-full shrink-0',
        talking ? 'bg-green-500 animate-pulse' : 'bg-surface-border',
      ].join(' ')} />

      {/* Caller info */}
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-1.5">
          <span className="text-xs font-medium text-text-primary truncate">
            {caller_name || caller_num || `Member #${id}`}
          </span>
          {moderator && (
            <span className="shrink-0 inline-flex items-center gap-0.5 px-1 py-px
                             rounded text-[9px] font-semibold bg-amber-500/15 text-amber-600
                             dark:text-amber-400">
              <Shield size={8} /> MOD
            </span>
          )}
          {muted && (
            <span className="shrink-0 inline-flex items-center gap-0.5 px-1 py-px
                             rounded text-[9px] font-semibold bg-red-500/15 text-red-500">
              <MicOff size={8} /> MUTED
            </span>
          )}
          {deaf && (
            <span className="shrink-0 inline-flex items-center gap-0.5 px-1 py-px
                             rounded text-[9px] font-semibold bg-orange-500/15 text-orange-500">
              <HeadphoneOff size={8} /> DEAF
            </span>
          )}
        </div>
        <p className="text-[10px] text-text-muted">
          {caller_num && caller_name ? caller_num : ''} · Joined {joinDuration} ago · ID #{id}
        </p>
      </div>

      {/* Controls */}
      <div className="flex items-center gap-0.5 shrink-0">
        <ControlButton
          icon={muted ? Mic : MicOff}
          label={muted ? 'Unmute' : 'Mute'}
          onClick={() => act(muted ? api.monitoring.unmute : api.monitoring.mute)}
          active={muted}
        />
        <ControlButton
          icon={deaf ? Headphones : HeadphoneOff}
          label={deaf ? 'Undeaf' : 'Deaf'}
          onClick={() => act(deaf ? api.monitoring.undeaf : api.monitoring.deaf)}
          active={deaf}
        />
        <ControlButton
          icon={ArrowRight}
          label="Floor"
          onClick={() => act(api.monitoring.floor)}
        />
        <ControlButton
          icon={Volume2}
          label="Vol ▲"
          onClick={() => act(api.monitoring.volume, 'in', 2)}
        />
        <ControlButton
          icon={VolumeX}
          label="Vol ▼"
          onClick={() => act(api.monitoring.volume, 'in', -2)}
        />
        <ControlButton
          icon={Activity}
          label="Enrg ▲"
          onClick={() => act(api.monitoring.energy, 2)}
        />
        <TransferControl room={room} memberId={id} />
        <ControlButton
          icon={PhoneOff}
          label="Kick"
          danger
          onClick={() => {
            if (window.confirm(`Kick member #${id} (${caller_name || caller_num})?`)) {
              act(api.monitoring.kick);
            }
          }}
        />
      </div>
    </div>
  );
});

function TransferControl({ room, memberId }) {
  const [open, setOpen] = useState(false);
  const [ext, setExt] = useState('');
  const ref = useRef();

  useEffect(() => {
    if (!open) return;
    const handler = e => { if (!ref.current?.contains(e.target)) setOpen(false); };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [open]);

  async function submit(e) {
    e.preventDefault();
    if (!ext.trim()) return;
    try { await api.monitoring.transfer(room, memberId, ext.trim()); } catch {}
    setOpen(false);
    setExt('');
  }

  return (
    <div className="relative" ref={ref}>
      <ControlButton icon={Send} label="Transfer" onClick={() => setOpen(o => !o)} active={open} />
      {open && (
        <div className="absolute right-0 bottom-full mb-1 z-50 bg-surface-card border border-surface-border
                        rounded-lg shadow-xl p-2 w-44">
          <form onSubmit={submit} className="flex gap-1">
            <input
              autoFocus
              value={ext}
              onChange={e => setExt(e.target.value)}
              placeholder="Extension…"
              className="flex-1 text-xs input-sm py-1 px-2"
            />
            <button type="submit" className="btn-primary text-xs px-2 py-1">Go</button>
          </form>
        </div>
      )}
    </div>
  );
}

// ── Conference Controls bar ───────────────────────────────────────────────────

function ConferenceControls({ conf, onTerminate }) {
  const { name, locked, recording } = conf;
  const [sayOpen, setSayOpen] = useState(false);
  const [inviteOpen, setInviteOpen] = useState(false);
  const [sayText, setSayText] = useState('');
  const [dialStr, setDialStr] = useState('');

  async function act(fn, ...args) {
    try { await fn(name, ...args); } catch (e) {
      console.error(e);
      alert('Action failed: ' + (e.message || 'Unknown error'));
    }
  }

  async function handleSay(e) {
    e.preventDefault();
    if (!sayText.trim()) return;
    await act(api.monitoring.say, sayText.trim());
    setSayText('');
    setSayOpen(false);
  }

  async function handleInvite(e) {
    e.preventDefault();
    if (!dialStr.trim()) return;
    await act(api.monitoring.invite, dialStr.trim());
    setDialStr('');
    setInviteOpen(false);
  }

  // Generate a timestamped recording path
  function recordPath() {
    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    return `/var/lib/freeswitch/recordings/conf_${name}_${ts}.wav`;
  }

  return (
    <div className="flex flex-wrap items-center gap-1 px-3 py-2 border-t border-surface-border
                    bg-surface-hover/50 rounded-b-xl">
      {/* Lock */}
      <ControlButton
        icon={locked ? Unlock : Lock}
        label={locked ? 'Unlock' : 'Lock'}
        onClick={() => act(locked ? api.monitoring.unlock : api.monitoring.lock)}
        active={locked}
      />

      {/* Recording */}
      {!recording ? (
        <ControlButton
          icon={Radio}
          label="Record"
          onClick={() => act(api.monitoring.recordStart, recordPath())}
        />
      ) : (
        <>
          <ControlButton
            icon={Pause}
            label="Pause Rec"
            onClick={() => act(api.monitoring.recordPause, recording)}
            active
          />
          <ControlButton
            icon={Square}
            label="Stop Rec"
            danger
            onClick={() => act(api.monitoring.recordStop, recording)}
          />
        </>
      )}

      {/* Broadcast TTS */}
      <div className="relative">
        <ControlButton icon={Radio} label="Say TTS" onClick={() => setSayOpen(o => !o)} active={sayOpen} />
        {sayOpen && (
          <div className="absolute left-0 bottom-full mb-1 z-50 bg-surface-card border border-surface-border
                          rounded-lg shadow-xl p-2 w-64">
            <form onSubmit={handleSay} className="flex gap-1">
              <input autoFocus value={sayText} onChange={e => setSayText(e.target.value)}
                     placeholder="Text to announce…"
                     className="flex-1 text-xs input-sm py-1 px-2" />
              <button type="submit" className="btn-primary text-xs px-2 py-1">Say</button>
            </form>
          </div>
        )}
      </div>

      {/* Invite participant */}
      <div className="relative">
        <ControlButton icon={PhoneIncoming} label="Invite" onClick={() => setInviteOpen(o => !o)} active={inviteOpen} />
        {inviteOpen && (
          <div className="absolute left-0 bottom-full mb-1 z-50 bg-surface-card border border-surface-border
                          rounded-lg shadow-xl p-2 w-56">
            <form onSubmit={handleInvite} className="flex gap-1">
              <input autoFocus value={dialStr} onChange={e => setDialStr(e.target.value)}
                     placeholder="sip:user@domain or extn"
                     className="flex-1 text-xs input-sm py-1 px-2" />
              <button type="submit" className="btn-primary text-xs px-2 py-1">Dial</button>
            </form>
          </div>
        )}
      </div>

      {/* Terminate */}
      <div className="ml-auto">
        <ControlButton
          icon={Trash2}
          label="Terminate"
          danger
          onClick={() => {
            if (window.confirm(`Terminate conference "${name}"?\n\nThis will disconnect all participants.`)) {
              onTerminate();
            }
          }}
        />
      </div>
    </div>
  );
}

// ── ConferenceCard ────────────────────────────────────────────────────────────

const ConferenceCard = memo(function ConferenceCard({ conf, now }) {
  const [expanded, setExpanded] = useState(false);
  const {
    name, members = [], locked, recording,
    incident, createdAt,
  } = conf;

  const memberCount = members.length;
  const speakerCount = members.filter(m => m.talking).length;

  const durationSec = createdAt
    ? Math.floor((now - new Date(createdAt)) / 1000)
    : 0;
  const durationLabel = durationSec < 60
    ? `${durationSec}s`
    : durationSec < 3600
      ? `${Math.floor(durationSec / 60)}m ${durationSec % 60}s`
      : `${Math.floor(durationSec / 3600)}h ${Math.floor((durationSec % 3600) / 60)}m`;

  const groupBadge = incident?.group_type === 'PRIMARY' ? 'primary'
                   : incident?.group_type === 'SECONDARY' ? 'secondary'
                   : null;

  async function handleTerminate() {
    try { await api.monitoring.terminate(name); } catch (e) { console.error(e); }
  }

  return (
    <div className="card !p-0 overflow-hidden transition-shadow hover:shadow-md">
      {/* Header */}
      <button
        onClick={() => setExpanded(e => !e)}
        className="w-full text-left flex items-start gap-3 p-4 hover:bg-surface-hover/50
                   transition-colors"
      >
        {/* Status dot */}
        <div className="mt-0.5 shrink-0">
          <PulsingDot active size="md" />
        </div>

        {/* Main info */}
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="font-mono font-semibold text-sm text-text-primary">{name}</span>
            {locked && (
              <span className="inline-flex items-center gap-0.5 text-[10px] px-1.5 py-px
                               rounded bg-amber-500/15 text-amber-600 dark:text-amber-400 font-medium">
                <Lock size={8} /> LOCKED
              </span>
            )}
            {recording && (
              <span className="inline-flex items-center gap-0.5 text-[10px] px-1.5 py-px
                               rounded bg-red-500/15 text-red-500 font-medium animate-pulse">
                <Radio size={8} /> REC
              </span>
            )}
            {groupBadge && (
              <span className={`inline-flex items-center text-[10px] px-1.5 py-px rounded font-medium
                ${groupBadge === 'primary'
                  ? 'bg-blue-500/15 text-blue-600 dark:text-blue-400'
                  : 'bg-purple-500/15 text-purple-600 dark:text-purple-400'}`}>
                {groupBadge === 'primary' ? 'PRIMARY' : 'SECONDARY'}
              </span>
            )}
          </div>

          <div className="flex items-center gap-3 mt-1 text-[11px] text-text-muted flex-wrap">
            {incident?.ers_name && (
              <span className="font-medium text-text-secondary">{incident.ers_name}</span>
            )}
            {incident?.organization_name && (
              <span>{incident.organization_name}</span>
            )}
            {incident?.caller_number && (
              <span className="font-mono">{incident.caller_number}</span>
            )}
            <span className="flex items-center gap-0.5">
              <Clock size={10} /> {durationLabel}
            </span>
          </div>
        </div>

        {/* Right stats */}
        <div className="flex items-center gap-4 shrink-0">
          <div className="text-center">
            <p className="text-base font-bold text-text-primary">{memberCount}</p>
            <p className="text-[10px] text-text-muted">Members</p>
          </div>
          {speakerCount > 0 && (
            <div className="text-center">
              <p className="text-base font-bold text-green-500">{speakerCount}</p>
              <p className="text-[10px] text-text-muted">Speaking</p>
            </div>
          )}
          {expanded ? <ChevronUp size={16} className="text-text-muted" /> : <ChevronDown size={16} className="text-text-muted" />}
        </div>
      </button>

      {/* Expanded participant panel */}
      {expanded && (
        <>
          <div className="px-3 pb-2 border-t border-surface-border">
            {memberCount === 0 ? (
              <p className="text-xs text-text-muted py-4 text-center">No members in this conference.</p>
            ) : (
              <div className="divide-y divide-surface-border/50">
                {members.map(member => (
                  <ParticipantRow
                    key={member.id}
                    member={member}
                    room={name}
                    onAction={() => {}}
                  />
                ))}
              </div>
            )}
          </div>
          <ConferenceControls conf={conf} onTerminate={handleTerminate} />
        </>
      )}
    </div>
  );
});

// ── ESL Status Bar ────────────────────────────────────────────────────────────

function EslStatusBar({ esl }) {
  return (
    <div className="card flex items-center gap-4 py-3">
      <div className={`w-9 h-9 rounded-xl flex items-center justify-center shrink-0
        ${esl?.connected ? 'bg-green-500/15 text-green-500' : 'bg-red-500/15 text-red-500'}`}>
        {esl?.connected ? <Wifi size={16} /> : <WifiOff size={16} />}
      </div>
      <div className="flex-1 min-w-0">
        <p className="text-sm font-semibold text-text-primary flex items-center gap-2">
          FreeSWITCH ESL
          <PulsingDot active={!!esl?.connected} size="sm" />
        </p>
        <p className="text-xs text-text-muted truncate">
          {esl?.connected
            ? `Connected — ${esl.host || 'localhost'}:${esl.port || 8021}`
            : 'Disconnected — attempting reconnect…'}
        </p>
      </div>
      <Badge variant={esl?.connected ? 'success' : 'danger'}>
        {esl?.connected ? 'Online' : 'Offline'}
      </Badge>
    </div>
  );
}

// ── Main page ─────────────────────────────────────────────────────────────────

export default function Monitoring() {
  const [conferences, setConferences] = useState([]);
  const [esl, setEsl] = useState(null);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const now = useNow();

  // ── Initial load ────────────────────────────────────────────────────────────
  const load = useCallback(async () => {
    try {
      const { conferences: list, esl: status } = await api.monitoring.conferences();
      setConferences(list || []);
      setEsl(status);
    } catch (e) {
      console.error('Monitoring load failed', e);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  // ── Socket.IO live state updates ────────────────────────────────────────────
  useEffect(() => {
    // Helper: update a conference by name
    function updateConf(confName, updater) {
      setConferences(prev => {
        const idx = prev.findIndex(c => c.name === confName);
        if (idx === -1) return prev;
        const clone = [...prev];
        clone[idx] = updater(clone[idx]);
        return clone;
      });
    }

    // Helper: update a member inside a conference
    function updateMember(confName, memberId, updater) {
      updateConf(confName, conf => ({
        ...conf,
        members: conf.members.map(m => m.id === memberId ? updater(m) : m),
      }));
    }

    const handlers = {
      'conference.created': ({ confName }) => {
        setConferences(prev => {
          if (prev.find(c => c.name === confName)) return prev;
          return [...prev, { name: confName, members: [], locked: false, recording: false, createdAt: new Date().toISOString() }];
        });
      },
      'conference.ended': ({ confName }) => {
        setConferences(prev => prev.filter(c => c.name !== confName));
      },
      'conference.member.joined': ({ confName, memberData }) => {
        if (!memberData) return;
        updateConf(confName, conf => {
          if (conf.members.find(m => m.id === memberData.id)) return conf;
          return { ...conf, members: [...conf.members, { ...memberData, talking: false }] };
        });
      },
      'conference.member.left': ({ confName, member: memberId }) => {
        updateConf(confName, conf => ({
          ...conf,
          members: conf.members.filter(m => m.id !== memberId),
        }));
      },
      'conference.member.muted': ({ confName, member: memberId, muted }) => {
        updateMember(confName, memberId, m => ({ ...m, muted }));
      },
      'conference.member.deaf': ({ confName, member: memberId, deaf }) => {
        updateMember(confName, memberId, m => ({ ...m, deaf }));
      },
      'conference.member.talking': ({ confName, member: memberId, talking }) => {
        updateMember(confName, memberId, m => ({ ...m, talking }));
      },
      'conference.floor.changed': ({ confName, member: newFloorId }) => {
        updateConf(confName, conf => ({
          ...conf,
          floorHolder: newFloorId,
          members: conf.members.map(m => ({ ...m, hasFloor: m.id === newFloorId })),
        }));
      },
      'conference.locked': ({ confName, locked }) => {
        updateConf(confName, conf => ({ ...conf, locked }));
      },
      'conference.recording': ({ confName, recording }) => {
        updateConf(confName, conf => ({ ...conf, recording }));
      },
    };

    for (const [event, handler] of Object.entries(handlers)) {
      socket.on(event, handler);
    }
    return () => {
      for (const [event, handler] of Object.entries(handlers)) {
        socket.off(event, handler);
      }
    };
  }, []);

  // ── Stats ───────────────────────────────────────────────────────────────────
  const totalMembers = useMemo(
    () => conferences.reduce((s, c) => s + (c.members?.length ?? 0), 0),
    [conferences]
  );
  const recordingCount = useMemo(
    () => conferences.filter(c => c.recording).length,
    [conferences]
  );

  // ── Filtered list ───────────────────────────────────────────────────────────
  const filtered = useMemo(() => {
    if (!search.trim()) return conferences;
    const q = search.toLowerCase();
    return conferences.filter(c =>
      c.name?.toLowerCase().includes(q) ||
      c.incident?.ers_name?.toLowerCase().includes(q) ||
      c.incident?.organization_name?.toLowerCase().includes(q) ||
      c.incident?.caller_number?.includes(q)
    );
  }, [conferences, search]);

  return (
    <div className="space-y-5">
      {/* Page header */}
      <div className="flex items-center gap-3">
        <div className="w-9 h-9 rounded-xl bg-green-500/15 flex items-center justify-center shrink-0">
          <Activity size={18} className="text-green-500" />
        </div>
        <div>
          <h1 className="text-lg font-bold text-text-primary leading-tight">Conference Operations Center</h1>
          <p className="text-xs text-text-muted">Live FreeSWITCH conference monitoring &amp; control</p>
        </div>
        <button
          onClick={load}
          className="ml-auto flex items-center gap-1.5 text-xs text-text-muted hover:text-text-primary
                     btn-ghost py-1 px-2"
        >
          <RefreshCw size={12} /> Refresh
        </button>
      </div>

      {/* ESL status */}
      <EslStatusBar esl={esl} />

      {/* Stats row */}
      <div className="grid grid-cols-3 gap-3">
        <div className="card text-center py-3 !px-2">
          <p className="text-2xl font-bold text-text-primary">{conferences.length}</p>
          <p className="text-[11px] text-text-muted mt-0.5">Active Conferences</p>
        </div>
        <div className="card text-center py-3 !px-2">
          <p className="text-2xl font-bold text-text-primary">{totalMembers}</p>
          <p className="text-[11px] text-text-muted mt-0.5">Total Participants</p>
        </div>
        <div className="card text-center py-3 !px-2">
          <p className={`text-2xl font-bold ${recordingCount > 0 ? 'text-red-500' : 'text-text-muted'}`}>
            {recordingCount}
          </p>
          <p className="text-[11px] text-text-muted mt-0.5">Recording</p>
        </div>
      </div>

      {/* Search */}
      {conferences.length > 1 && (
        <div className="relative">
          <Search size={13} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-text-muted" />
          <input
            value={search}
            onChange={e => setSearch(e.target.value)}
            placeholder="Search by room, ERS name, org, or number…"
            className="w-full pl-7 pr-3 py-1.5 text-xs input"
          />
        </div>
      )}

      {/* Conference list */}
      <div className="space-y-3">
        {loading ? (
          Array.from({ length: 3 }).map((_, i) => <SkeletonCard key={i} />)
        ) : filtered.length === 0 ? (
          <div className="card flex flex-col items-center gap-3 py-12 text-center">
            <div className="w-12 h-12 rounded-2xl bg-surface-hover flex items-center justify-center">
              <Layers size={22} className="text-text-muted" />
            </div>
            <div>
              <p className="text-sm font-semibold text-text-primary">
                {search ? 'No matching conferences' : 'No active conferences'}
              </p>
              <p className="text-xs text-text-muted mt-1">
                {search
                  ? 'Try a different search term.'
                  : 'Conferences appear here when FreeSWITCH bridges a call.'}
              </p>
            </div>
          </div>
        ) : (
          filtered.map(conf => (
            <ConferenceCard
              key={conf.name}
              conf={conf}
              now={now}
            />
          ))
        )}
      </div>
    </div>
  );
}
