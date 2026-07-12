/**
 * ERS Operations Center — Enterprise Monitoring Page
 *
 * Real-time emergency response bridge monitoring with supervisor controls.
 * Architecture: Socket.IO-driven live state + REST seed + optimistic UI.
 */

import { useReducer, useEffect, useCallback, useRef, useState, memo } from 'react';
import {
  PhoneCall, PhoneOff, Users, Clock, Wifi, WifiOff,
  Mic, MicOff, UserMinus, Volume2, VolumeX,
  CheckCircle, AlertTriangle, Radio, Layers,
  RefreshCw, ChevronDown, ChevronRight,
  Play, StopCircle, Shield, ArrowUpRight,
  PhoneIncoming, Activity,
} from 'lucide-react';
import { api } from '../../api/client.js';
import { socket } from '../../api/socket.js';
import ConfirmDialog from '../../components/ui/ConfirmDialog.jsx';
import Drawer from '../../components/ui/Drawer.jsx';
import { SkeletonCard } from '../../components/ui/Skeleton.jsx';

// ── Helpers ───────────────────────────────────────────────────────────────────

function useLiveTimer(startedAt) {
  const [elapsed, setElapsed] = useState('');
  useEffect(() => {
    if (!startedAt) return;
    const tick = () => {
      const s = Math.floor((Date.now() - new Date(startedAt)) / 1000);
      const h = Math.floor(s / 3600);
      const m = Math.floor((s % 3600) / 60);
      const sec = s % 60;
      setElapsed(h > 0
        ? `${h}h ${String(m).padStart(2,'0')}m`
        : `${m}:${String(sec).padStart(2,'0')}`);
    };
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, [startedAt]);
  return elapsed;
}

function formatTime(iso) {
  if (!iso) return '—';
  return new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

function maskNumber(num) {
  if (!num) return '—';
  const s = String(num).replace(/\D/g,'');
  if (s.length < 4) return num;
  return s.slice(0,3) + '·'.repeat(Math.max(0, s.length - 6)) + s.slice(-3);
}

// ── State shape & reducer ─────────────────────────────────────────────────────

const INIT = {
  incidents:  {},   // keyed by incident_uuid
  queue:      [],
  eslStatus:  { connected: false },
  loading:    true,
  error:      null,
};

function reducer(state, action) {
  switch (action.type) {
    case 'SEED':
      return {
        ...state,
        loading: false,
        incidents: action.incidents,
        queue:     action.queue,
      };
    case 'ESL_STATUS':
      return { ...state, eslStatus: action.payload };
    case 'INCIDENT_CREATED': {
      const inc = action.payload;
      return {
        ...state,
        incidents: {
          ...state.incidents,
          [inc.incident_uuid]: {
            incident_uuid: inc.incident_uuid,
            incident_id:   inc.incident_id,
            configuration_id: inc.configuration_id,
            caller_number: inc.caller_number,
            conference_room: inc.conference_room,
            group_type:    inc.group_type,
            status:        inc.status,
            started_at:    inc.started_at || new Date().toISOString(),
            ers_name:      inc.ers_name || '',
            responders:    [],
            participants:  [],
            _liveMembers:  [],
          },
        },
      };
    }
    case 'INCIDENT_ENDED': {
      const { incident_uuid } = action.payload;
      const { [incident_uuid]: _, ...rest } = state.incidents;
      return {
        ...state,
        incidents: rest,
        queue: state.queue.filter(q => q.incident_uuid !== incident_uuid),
      };
    }
    case 'RESPONDER_UPDATE': {
      const p = action.payload;
      const inc = state.incidents[p.incident_uuid];
      if (!inc) return state;
      const existing = inc.responders || [];
      const idx = existing.findIndex(r => r.mobile_number === p.responder_number);
      const updated = idx >= 0
        ? existing.map((r, i) => i === idx ? { ...r, ...p, mobile_number: p.responder_number } : r)
        : [...existing, { mobile_number: p.responder_number, ...p }];
      return {
        ...state,
        incidents: { ...state.incidents, [p.incident_uuid]: { ...inc, responders: updated } },
      };
    }
    case 'QUEUE_CHANGED': {
      // Refresh queue from API — handled by effect
      return state;
    }
    case 'QUEUE_SEED':
      return { ...state, queue: action.queue };
    case 'MEMBER_JOINED': {
      const p = action.payload;
      const inc = Object.values(state.incidents).find(i => i.conference_room === p.confName);
      if (!inc) return state;
      const existing = inc._liveMembers || [];
      if (existing.find(m => m.member === p.member)) return state;
      return {
        ...state,
        incidents: {
          ...state.incidents,
          [inc.incident_uuid]: {
            ...inc,
            _liveMembers: [...existing, { member: p.member, callerNum: p.callerNum, callerName: p.callerName, muted: false, talking: false, joinedAt: new Date().toISOString() }],
          },
        },
      };
    }
    case 'MEMBER_LEFT': {
      const p = action.payload;
      const inc = Object.values(state.incidents).find(i => i.conference_room === p.confName);
      if (!inc) return state;
      return {
        ...state,
        incidents: {
          ...state.incidents,
          [inc.incident_uuid]: {
            ...inc,
            _liveMembers: (inc._liveMembers || []).filter(m => m.member !== p.member),
          },
        },
      };
    }
    case 'MEMBER_MUTED': {
      const p = action.payload;
      const inc = Object.values(state.incidents).find(i => i.conference_room === p.confName);
      if (!inc) return state;
      return {
        ...state,
        incidents: {
          ...state.incidents,
          [inc.incident_uuid]: {
            ...inc,
            _liveMembers: (inc._liveMembers || []).map(m =>
              m.member === p.member ? { ...m, muted: p.muted } : m
            ),
          },
        },
      };
    }
    case 'MEMBER_TALKING': {
      const p = action.payload;
      const inc = Object.values(state.incidents).find(i => i.conference_room === p.confName);
      if (!inc) return state;
      return {
        ...state,
        incidents: {
          ...state.incidents,
          [inc.incident_uuid]: {
            ...inc,
            _liveMembers: (inc._liveMembers || []).map(m =>
              m.member === p.member ? { ...m, talking: p.talking } : m
            ),
          },
        },
      };
    }
    case 'INCIDENT_DETAIL': {
      const inc = state.incidents[action.uuid];
      if (!inc) return state;
      return {
        ...state,
        incidents: {
          ...state.incidents,
          [action.uuid]: { ...inc, ...action.detail },
        },
      };
    }
    case 'ERROR':
      return { ...state, loading: false, error: action.message };
    default:
      return state;
  }
}

// ── Sub-components ────────────────────────────────────────────────────────────

const StatusDot = memo(({ active, label, title }) => (
  <span title={title} className="flex items-center gap-1.5">
    <span className={`w-2 h-2 rounded-full ${active ? 'bg-green-500 shadow-[0_0_4px_rgba(34,197,94,0.8)]' : 'bg-red-500'} ${active ? 'animate-pulse' : ''}`} />
    <span className="text-xs text-text-secondary">{label}</span>
  </span>
));

// Responder chip: JOINED=green, INVITED=amber, MISSED=red, OBSERVER=blue
const RESPONDER_COLORS = {
  JOINED:   'badge-green',
  REJOINED: 'badge-green',
  INVITED:  'badge-amber',
  MISSED:   'badge-red',
  OBSERVER: 'badge-blue',
};

const ResponderChip = memo(({ responder }) => {
  const cls = RESPONDER_COLORS[responder.status] || 'badge-gray';
  const name = [responder.first_name, responder.last_name].filter(Boolean).join(' ')
    || maskNumber(responder.mobile_number);
  return (
    <span className={`badge ${cls} text-[10px]`} title={`${name} — ${responder.status}`}>
      {name}
    </span>
  );
});

// Live conference member row with mute/kick controls
const MemberRow = memo(({ member, room, onMute, onKick }) => {
  const [muteLoading, setMuteLoading] = useState(false);
  const [kickLoading, setKickLoading] = useState(false);

  const handleMute = async () => {
    setMuteLoading(true);
    try { await onMute(room, member.member, !member.muted); }
    finally { setMuteLoading(false); }
  };

  const handleKick = async () => {
    setKickLoading(true);
    try { await onKick(room, member.member); }
    finally { setKickLoading(false); }
  };

  return (
    <div className="flex items-center gap-2 py-1.5 px-3 rounded-lg hover:bg-surface-raised/60 group">
      {/* Talking indicator */}
      <div className={`w-1.5 h-1.5 rounded-full shrink-0 ${member.talking ? 'bg-green-500 animate-pulse' : 'bg-surface-border'}`} />

      {/* Number / name */}
      <span className="flex-1 text-xs text-text-primary font-mono truncate">
        {member.displayName || maskNumber(member.callerNum)}
      </span>

      {/* Muted badge */}
      {member.muted && (
        <span className="badge badge-red text-[9px] px-1.5 py-0">Muted</span>
      )}

      {/* Controls — visible on hover */}
      <div className="flex gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity">
        <button
          title={member.muted ? 'Unmute' : 'Mute'}
          onClick={handleMute}
          disabled={muteLoading}
          className="p-1 rounded hover:bg-surface-border/60 text-text-muted hover:text-text-primary transition-colors"
        >
          {member.muted ? <Mic size={12} /> : <MicOff size={12} />}
        </button>
        <button
          title="Remove from conference"
          onClick={handleKick}
          disabled={kickLoading}
          className="p-1 rounded hover:bg-red-500/10 text-text-muted hover:text-red-400 transition-colors"
        >
          <UserMinus size={12} />
        </button>
      </div>
    </div>
  );
});

// Audio injection dialog
function AudioInjectDialog({ open, room, onClose, onPlay }) {
  const [path, setPath] = useState('');
  const [playing, setPlaying] = useState(false);

  const handlePlay = async () => {
    if (!path.trim()) return;
    setPlaying(true);
    try { await onPlay(room, path.trim()); onClose(); }
    finally { setPlaying(false); }
  };

  return (
    <Drawer open={open} onClose={onClose} title="Inject Audio" subtitle={`Conference: ${room}`} size="sm"
      footer={<>
        <button className="btn-secondary text-xs px-3 py-1.5" onClick={onClose}>Cancel</button>
        <button className="btn-primary text-xs px-3 py-1.5" onClick={handlePlay} disabled={playing || !path.trim()}>
          <Play size={12} /> {playing ? 'Playing…' : 'Play Now'}
        </button>
      </>}
    >
      <div className="p-5 space-y-4">
        <p className="text-xs text-text-secondary">
          Enter the absolute path to an audio file on the FreeSWITCH server. The file will play into the conference immediately for all participants.
        </p>
        <div>
          <label className="label">Audio File Path</label>
          <input
            className="input font-mono text-xs"
            placeholder="/var/lib/freeswitch/sounds/enrs/alert.wav"
            value={path}
            onChange={e => setPath(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && handlePlay()}
          />
        </div>
      </div>
    </Drawer>
  );
}

// Individual incident card
const IncidentCard = memo(function IncidentCard({ incident, onComplete, onKick, onMute, onPlay }) {
  const elapsed = useLiveTimer(incident.started_at);
  const [expanded, setExpanded] = useState(false);
  const [completing, setCompleting] = useState(false);
  const [showAudio, setShowAudio] = useState(false);
  const [confirm, setConfirm] = useState(false);

  const room        = incident.conference_room || '';
  const members     = incident._liveMembers || [];
  const responders  = incident.responders   || [];
  const memberCount = members.length;
  const talkingCount = members.filter(m => m.talking).length;

  const handleComplete = async () => {
    setCompleting(true);
    try { await onComplete(incident.incident_uuid); }
    finally { setCompleting(false); setConfirm(false); }
  };

  const tierColor = incident.group_type === 'primary' ? 'badge-blue' : 'badge-amber';

  return (
    <>
      <div className="card overflow-hidden transition-shadow hover:shadow-md">
        {/* Card header stripe */}
        <div className="h-0.5 w-full bg-gradient-to-r from-red-500 to-red-600/50" />

        {/* Main header */}
        <div className="px-4 py-3 flex items-start gap-3">
          {/* Pulsing live indicator */}
          <div className="w-2 h-2 mt-1.5 rounded-full bg-red-500 shrink-0 animate-pulse shadow-[0_0_6px_rgba(239,68,68,0.8)]" />

          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <span className="text-sm font-semibold text-text-primary truncate">
                {incident.ers_name || `ERS #${incident.configuration_id}`}
              </span>
              <span className={`badge ${tierColor} text-[10px]`}>
                {incident.group_type === 'primary' ? 'Primary' : 'Secondary'}
              </span>
              {incident.recording_path && (
                <span className="badge badge-red text-[10px]">
                  <span className="w-1.5 h-1.5 rounded-full bg-red-500 animate-pulse" />
                  REC
                </span>
              )}
            </div>
            <div className="flex items-center gap-3 mt-1 text-[11px] text-text-muted flex-wrap">
              <span className="font-mono">{maskNumber(incident.caller_number)}</span>
              {room && <span className="font-mono text-brand">Bridge: {room}</span>}
              <span className="flex items-center gap-1">
                <Clock size={10} />
                {elapsed}
              </span>
              <span className="flex items-center gap-1">
                <Users size={10} />
                {memberCount} live
                {talkingCount > 0 && <span className="text-green-500">· {talkingCount} talking</span>}
              </span>
            </div>
          </div>

          {/* Actions */}
          <div className="flex items-center gap-1.5 shrink-0">
            <button
              title="Inject audio into conference"
              onClick={() => setShowAudio(true)}
              className="p-1.5 rounded-lg hover:bg-surface-raised text-text-muted hover:text-brand transition-colors"
            >
              <Volume2 size={13} />
            </button>
            <button
              title="Complete / end this incident"
              onClick={() => setConfirm(true)}
              disabled={completing}
              className="btn-danger py-1 px-2.5 text-xs"
            >
              <PhoneOff size={12} />
              Complete
            </button>
          </div>
        </div>

        {/* Responder chips */}
        {responders.length > 0 && (
          <div className="px-4 pb-3 flex flex-wrap gap-1.5">
            {responders.map((r, i) => <ResponderChip key={r.id || i} responder={r} />)}
          </div>
        )}

        {/* Live members section — expandable */}
        {members.length > 0 && (
          <div className="border-t border-surface-border/60">
            <button
              onClick={() => setExpanded(v => !v)}
              className="w-full flex items-center justify-between px-4 py-2 text-[11px] text-text-muted hover:bg-surface-raised/50 transition-colors"
            >
              <span className="flex items-center gap-1.5">
                <Users size={10} />
                Live participants ({members.length})
              </span>
              {expanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
            </button>
            {expanded && (
              <div className="pb-2 border-t border-surface-border/40">
                {members.map(m => (
                  <MemberRow
                    key={m.member}
                    member={m}
                    room={room}
                    onMute={onMute}
                    onKick={onKick}
                  />
                ))}
              </div>
            )}
          </div>
        )}
      </div>

      {/* Confirm complete */}
      <ConfirmDialog
        open={confirm}
        title="Complete incident?"
        message={`This will end the conference bridge for ${incident.ers_name || 'this ERS'}. If there are callers in queue they will be promoted.`}
        confirmLabel="Complete incident"
        variant="danger"
        loading={completing}
        onConfirm={handleComplete}
        onCancel={() => setConfirm(false)}
      />

      {/* Audio inject drawer */}
      <AudioInjectDialog
        open={showAudio}
        room={room}
        onClose={() => setShowAudio(false)}
        onPlay={onPlay}
      />
    </>
  );
});

// Queue entry card
const QueueCard = memo(function QueueCard({ entry, onCancel }) {
  const elapsed = useLiveTimer(entry.created_at || entry.queued_at);
  const [cancelling, setCancelling] = useState(false);
  const [confirm, setConfirm] = useState(false);

  const handleCancel = async () => {
    setCancelling(true);
    try { await onCancel(entry.incident_uuid); }
    finally { setCancelling(false); setConfirm(false); }
  };

  return (
    <>
      <div className="flex items-center gap-3 px-4 py-3 border-b border-surface-border/60 last:border-0 hover:bg-surface-raised/40 transition-colors group">
        {/* Position badge */}
        <div className="w-6 h-6 rounded-full bg-amber-500/15 border border-amber-500/30 flex items-center justify-center shrink-0">
          <span className="text-[10px] font-bold text-amber-500">{entry.position}</span>
        </div>

        <div className="flex-1 min-w-0">
          <div className="text-xs font-medium text-text-primary truncate">
            {entry.ers_name || `ERS #${entry.ers_configuration_id}`}
          </div>
          <div className="text-[10px] text-text-muted font-mono mt-0.5">
            {maskNumber(entry.caller_number)} · {elapsed}
          </div>
        </div>

        <button
          onClick={() => setConfirm(true)}
          className="p-1 rounded hover:bg-red-500/10 text-text-muted hover:text-red-400 opacity-0 group-hover:opacity-100 transition-all"
          title="Cancel queued caller"
        >
          <PhoneOff size={12} />
        </button>
      </div>

      <ConfirmDialog
        open={confirm}
        title="Cancel queued caller?"
        message="This will remove the caller from the queue. They will need to call back."
        confirmLabel="Cancel caller"
        variant="warning"
        loading={cancelling}
        onConfirm={handleCancel}
        onCancel={() => setConfirm(false)}
      />
    </>
  );
});

// ── Main component ────────────────────────────────────────────────────────────

export default function ErsMonitoring() {
  const [state, dispatch] = useReducer(reducer, INIT);
  // socket is the singleton from api/socket.js
  const queueRefTimer = useRef(null);

  // ── Seed from REST ───────────────────────────────────────────────────────

  const refreshQueue = useCallback(async () => {
    try {
      const rows = await api.ers.queue();
      dispatch({ type: 'QUEUE_SEED', queue: Array.isArray(rows) ? rows : [] });
    } catch {}
  }, []);

  const load = useCallback(async () => {
    try {
      const [incidentRows, queueRows] = await Promise.all([
        api.ers.incidents({ status: 'ACTIVE', limit: 100 }),
        api.ers.queue(),
      ]);

      const rows = Array.isArray(incidentRows) ? incidentRows : (incidentRows?.incidents || []);
      const incidents = {};
      for (const inc of rows) {
        incidents[inc.incident_uuid] = {
          ...inc,
          responders:   [],
          _liveMembers: [],
        };
      }

      // Load responders for each active incident
      await Promise.all(
        Object.keys(incidents).map(async uuid => {
          try {
            const detail = await api.ers.incident(uuid);
            incidents[uuid] = { ...incidents[uuid], ...detail };
          } catch {}
        })
      );

      dispatch({
        type: 'SEED',
        incidents,
        queue: Array.isArray(queueRows) ? queueRows : [],
      });
    } catch (e) {
      dispatch({ type: 'ERROR', message: e.message });
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  // ── Socket.IO event subscriptions ───────────────────────────────────────

  useEffect(() => {
    const pairs = [
      ['esl.status',                 p => dispatch({ type: 'ESL_STATUS',       payload: p })],
      ['enrs::ers_incident_created', p => dispatch({ type: 'INCIDENT_CREATED', payload: p })],
      ['enrs::ers_incident_ended',   p => dispatch({ type: 'INCIDENT_ENDED',   payload: p })],
      ['enrs::ers_responder_update', p => dispatch({ type: 'RESPONDER_UPDATE', payload: p })],
      ['enrs::ers_queue_changed',    () => refreshQueue()],
      ['conference.member.joined',   p => dispatch({ type: 'MEMBER_JOINED',    payload: p })],
      ['conference.member.left',     p => dispatch({ type: 'MEMBER_LEFT',      payload: p })],
      ['conference.member.muted',    p => dispatch({ type: 'MEMBER_MUTED',     payload: p })],
      ['conference.member.talking',  p => dispatch({ type: 'MEMBER_TALKING',   payload: p })],
    ];
    for (const [evt, fn] of pairs) socket.on(evt, fn);
    return () => { for (const [evt, fn] of pairs) socket.off(evt, fn); };
  }, [refreshQueue]);

  // ── Actions ──────────────────────────────────────────────────────────────

  const handleComplete = useCallback(async (uuid) => {
    await api.ers.completeIncident(uuid);
    dispatch({ type: 'INCIDENT_ENDED', payload: { incident_uuid: uuid } });
    refreshQueue();
  }, [refreshQueue]);

  const handleCancelQueue = useCallback(async (uuid) => {
    await api.ers.cancelIncident(uuid);
    refreshQueue();
  }, [refreshQueue]);

  const handleKick = useCallback(async (room, memberId) => {
    await api.ers.confKick(room, memberId);
  }, []);

  const handleMute = useCallback(async (room, memberId, muted) => {
    await api.ers.confMute(room, memberId, muted);
  }, []);

  const handlePlay = useCallback(async (room, audioPath) => {
    await api.ers.confPlay(room, audioPath);
  }, []);

  // ── Derived values ───────────────────────────────────────────────────────

  const incidentList   = Object.values(state.incidents);
  const activeCount    = incidentList.length;
  const queueCount     = state.queue.length;
  const totalMembers   = incidentList.reduce((s, i) => s + (i._liveMembers?.length || 0), 0);
  const talkingTotal   = incidentList.reduce((s, i) => s + (i._liveMembers?.filter(m => m.talking).length || 0), 0);

  // ── Render ───────────────────────────────────────────────────────────────

  return (
    <div className="flex flex-col h-full min-h-0 overflow-hidden">

      {/* ── Top status bar ─────────────────────────────────────────────── */}
      <div className="flex items-center gap-6 px-5 py-2.5 border-b border-surface-border bg-surface-panel shrink-0 z-10">
        {/* ESL connection */}
        <StatusDot
          active={state.eslStatus?.connected}
          label={state.eslStatus?.connected ? 'FreeSWITCH Connected' : 'FreeSWITCH Offline'}
          title={`${state.eslStatus?.host || ''}:${state.eslStatus?.port || ''}`}
        />

        <div className="w-px h-4 bg-surface-border" />

        {/* Metric pills */}
        <div className="flex items-center gap-4">
          <MetricPill icon={<PhoneCall size={12} className="text-red-500" />}
            value={activeCount} label="Active" active={activeCount > 0} />
          <MetricPill icon={<Layers size={12} className="text-amber-500" />}
            value={queueCount} label="Queued" active={queueCount > 0} />
          <MetricPill icon={<Users size={12} className="text-blue-500" />}
            value={totalMembers} label="On bridge" />
          <MetricPill icon={<Radio size={12} className="text-green-500" />}
            value={talkingTotal} label="Talking" active={talkingTotal > 0} />
        </div>

        <div className="ml-auto flex items-center gap-2">
          <button
            onClick={load}
            title="Refresh"
            className="p-1.5 rounded-lg hover:bg-surface-raised text-text-muted hover:text-text-primary transition-colors"
          >
            <RefreshCw size={13} />
          </button>
          <span className="text-[10px] text-text-muted">
            Live · updated via socket
          </span>
        </div>
      </div>

      {/* ── Body: 2-column layout ──────────────────────────────────────── */}
      <div className="flex flex-1 min-h-0 overflow-hidden">

        {/* ── Left: Active incidents ──────────────────────────────────── */}
        <div className="flex-1 flex flex-col min-w-0 overflow-hidden">

          {/* Section header */}
          <div className="flex items-center justify-between px-5 py-2.5 border-b border-surface-border bg-surface-panel/50 shrink-0">
            <div className="flex items-center gap-2">
              <PhoneCall size={14} className="text-red-500" />
              <span className="text-xs font-semibold text-text-primary uppercase tracking-wider">
                Active Incidents
              </span>
              {activeCount > 0 && (
                <span className="badge badge-red text-[10px] px-1.5">{activeCount}</span>
              )}
            </div>
          </div>

          {/* Incidents list */}
          <div className="flex-1 overflow-y-auto p-4">
            {state.loading ? (
              <div className="space-y-3">
                <SkeletonCard lines={4} />
                <SkeletonCard lines={3} />
              </div>
            ) : state.error ? (
              <div className="flex flex-col items-center justify-center h-48 gap-3 text-center">
                <AlertTriangle size={28} className="text-red-400" />
                <p className="text-sm text-text-secondary">{state.error}</p>
                <button className="btn-secondary text-xs" onClick={load}>Retry</button>
              </div>
            ) : incidentList.length === 0 ? (
              <EmptyState
                icon={<Shield size={36} className="text-text-muted" />}
                title="No active incidents"
                subtitle="Emergency conference bridges will appear here in real time when calls arrive."
              />
            ) : (
              <div className="grid gap-3 grid-cols-1 xl:grid-cols-2">
                {incidentList.map(inc => (
                  <IncidentCard
                    key={inc.incident_uuid}
                    incident={inc}
                    onComplete={handleComplete}
                    onKick={handleKick}
                    onMute={handleMute}
                    onPlay={handlePlay}
                  />
                ))}
              </div>
            )}
          </div>
        </div>

        {/* ── Right: Queue panel ─────────────────────────────────────── */}
        <div className="w-72 shrink-0 border-l border-surface-border flex flex-col min-h-0 overflow-hidden">

          <div className="flex items-center justify-between px-4 py-2.5 border-b border-surface-border bg-surface-panel/50 shrink-0">
            <div className="flex items-center gap-2">
              <PhoneIncoming size={14} className="text-amber-500" />
              <span className="text-xs font-semibold text-text-primary uppercase tracking-wider">
                Queue
              </span>
              {queueCount > 0 && (
                <span className="badge badge-amber text-[10px] px-1.5">{queueCount}</span>
              )}
            </div>
          </div>

          <div className="flex-1 overflow-y-auto">
            {state.queue.length === 0 ? (
              <EmptyState
                icon={<Activity size={24} className="text-text-muted" />}
                title="Queue empty"
                subtitle="Callers waiting for a conference bridge will appear here."
                compact
              />
            ) : (
              state.queue.map(entry => (
                <QueueCard
                  key={entry.id}
                  entry={entry}
                  onCancel={handleCancelQueue}
                />
              ))
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

// ── Shared presentational components ─────────────────────────────────────────

function MetricPill({ icon, value, label, active = false }) {
  return (
    <div className={`flex items-center gap-1.5 px-2.5 py-1 rounded-lg border transition-colors
      ${active
        ? 'bg-surface-raised border-surface-border'
        : 'bg-transparent border-transparent'
      }`}
    >
      {icon}
      <span className={`text-sm font-bold tabular-nums ${active ? 'text-text-primary' : 'text-text-muted'}`}>
        {value}
      </span>
      <span className="text-[10px] text-text-muted">{label}</span>
    </div>
  );
}

function EmptyState({ icon, title, subtitle, compact = false }) {
  return (
    <div className={`flex flex-col items-center justify-center gap-2 text-center ${compact ? 'py-8 px-4' : 'py-16 px-6'}`}>
      <div className="opacity-40">{icon}</div>
      <p className="text-xs font-semibold text-text-secondary">{title}</p>
      {subtitle && <p className="text-[11px] text-text-muted leading-relaxed">{subtitle}</p>}
    </div>
  );
}
