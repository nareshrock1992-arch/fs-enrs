import { useEffect, useReducer, useCallback } from 'react';
import { PhoneIncoming, Clock, CheckCircle2, User, ShieldAlert } from 'lucide-react';
import { api } from '../../api/client.js';
import { useSocketEvent } from '../../hooks/useSocketEvent.js';
import { useLiveDuration } from '../../hooks/useLiveDuration.js';
import { Table, Th, Td, Tr, EmptyRow } from '../../components/ui/Table.jsx';
import { StatusBadge } from '../../components/ui/Badge.jsx';
import PulsingDot from '../../components/ui/PulsingDot.jsx';

function maskPhone(num) {
  if (!num) return '—';
  const d = String(num).replace(/\D/g, '');
  if (d.length < 4) return num;
  return d.slice(0, -4).replace(/./g, 'x') + '-' + d.slice(-4);
}

// ── Reducer ───────────────────────────────────────────────────────────────────

function reducer(state, action) {
  switch (action.type) {
    case 'SEED':
      return { ...state, ...action.payload };

    case 'ERS_CREATED':
      return {
        ...state,
        incidents: {
          ...state.incidents,
          [action.payload.incident_uuid]: { ...action.payload, responders: [] },
        },
      };

    case 'ERS_RESPONDER': {
      const uuid = action.payload.incident_uuid;
      const inc = state.incidents[uuid];
      if (!inc) return state;
      const idx = inc.responders.findIndex(
        r => r.responder_number === action.payload.responder_number
      );
      const responders = [...inc.responders];
      if (idx >= 0) responders[idx] = action.payload;
      else responders.push(action.payload);
      return {
        ...state,
        incidents: { ...state.incidents, [uuid]: { ...inc, responders } },
      };
    }

    case 'ERS_ENDED': {
      const { [action.payload.incident_uuid]: _, ...rest } = state.incidents;
      return { ...state, incidents: rest };
    }

    case 'QUEUE_SYNC':
      return { ...state, queue: action.payload };

    default:
      return state;
  }
}

const INIT = { incidents: {}, queue: [] };

// ── IncidentRow ───────────────────────────────────────────────────────────────

function IncidentRow({ incident, onComplete }) {
  const { incident_uuid, conference_room, caller_number,
          ers_name, group_type, started_at, responders = [] } = incident;
  const duration = useLiveDuration(started_at);
  const joined = responders.filter(r => r.status === 'JOINED' || r.status === 'REJOINED');

  return (
    <div className="border border-surface-border rounded-xl p-4 bg-surface
                    hover:bg-surface-hover transition-colors space-y-3">
      {/* Header */}
      <div className="flex items-center gap-2">
        <PulsingDot active size="sm" />
        <p className="text-sm font-semibold text-text-primary flex-1 truncate">
          {ers_name || 'ERS Incident'}
        </p>
        <span className={`text-[10px] px-2 py-0.5 rounded-full font-medium
          ${group_type === 'primary'
            ? 'bg-brand/15 text-brand'
            : 'bg-yellow-500/15 text-yellow-600 dark:text-yellow-400'}`}>
          {group_type}
        </span>
        <button onClick={() => onComplete(incident_uuid)}
                className="btn-ghost p-1.5 text-green-500 hover:bg-green-500/10 rounded-lg ml-1"
                title="Complete incident">
          <CheckCircle2 size={14} />
        </button>
      </div>

      {/* Meta */}
      <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-xs">
        <span className="text-text-muted flex items-center gap-1">
          <Clock size={10} /> {duration}
        </span>
        <span className="text-text-muted font-mono truncate">{conference_room || '—'}</span>
        <span className="text-text-muted">
          Caller: <span className="font-mono text-text-primary">{maskPhone(caller_number)}</span>
        </span>
        <span className="text-text-muted">
          Responders: <strong className="text-text-primary">{joined.length}</strong>
        </span>
      </div>

      {/* Responder chips */}
      {joined.length > 0 && (
        <div className="flex flex-wrap gap-1">
          {joined.map((r, i) => (
            <span key={i}
              className="inline-flex items-center gap-1 text-[10px] px-2 py-0.5 rounded-full
                         bg-green-500/10 text-green-600 dark:text-green-400 border border-green-500/20">
              <User size={9} /> {maskPhone(r.responder_number)}
              {r.status === 'REJOINED' && <span className="opacity-60">(rejoined)</span>}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

// ── QueueRow ──────────────────────────────────────────────────────────────────

function QueueRow({ entry }) {
  const { position, caller_number, queued_at, ers_name, status } = entry;
  const wait = useLiveDuration(queued_at);
  return (
    <Tr>
      <Td className="text-center font-bold">{position}</Td>
      <Td className="font-mono text-xs">{maskPhone(caller_number)}</Td>
      <Td className="text-text-muted text-xs truncate max-w-[120px]">{ers_name || '—'}</Td>
      <Td className="text-text-muted text-xs flex items-center gap-1">
        <Clock size={10} /> {wait}
      </Td>
      <Td><StatusBadge status={status} /></Td>
    </Tr>
  );
}

// ── ErsLive ───────────────────────────────────────────────────────────────────

export default function ErsLive() {
  const [state, dispatch] = useReducer(reducer, INIT);

  const seed = useCallback(async () => {
    try {
      const [inc, q] = await Promise.all([
        api.ers.incidents({ status: 'IN_PROGRESS' }),
        api.ers.queue(),
      ]);

      // Normalise incidents into keyed map
      const incidents = {};
      for (const i of inc.incidents || []) {
        incidents[i.incident_uuid || i.id] = {
          incident_uuid:   i.incident_uuid || i.id,
          conference_room: i.conference_room || i.conference_id,
          caller_number:   i.caller_number,
          ers_name:        i.ers_name,
          group_type:      i.group_type || 'primary',
          started_at:      i.started_at,
          responders:      i.responders || [],
        };
      }

      dispatch({ type: 'SEED', payload: { incidents, queue: q.queue || [] } });
    } catch {}
  }, []);

  useEffect(() => { seed(); }, [seed]);

  // Push-driven incident updates
  useSocketEvent('enrs::ers_incident_created',
    p => dispatch({ type: 'ERS_CREATED', payload: p }));
  useSocketEvent('enrs::ers_responder_update',
    p => dispatch({ type: 'ERS_RESPONDER', payload: p }));
  useSocketEvent('enrs::ers_incident_ended',
    p => dispatch({ type: 'ERS_ENDED', payload: p }));

  // Queue changes need a REST reload (position numbers are server-computed)
  const reloadQueue = useCallback(async () => {
    try {
      const q = await api.ers.queue();
      dispatch({ type: 'QUEUE_SYNC', payload: q.queue || [] });
    } catch {}
  }, []);

  useSocketEvent('enrs::ers_incident_created', reloadQueue);
  useSocketEvent('enrs::ers_incident_ended',   reloadQueue);
  // Phase 5 — overflow queue enqueue/promote events (ersOverflowEnqueue /
  // ersOverflowPoll emit these) keep the queue depth live in real time.
  useSocketEvent('enrs::ers_queue_changed',    reloadQueue);

  async function completeIncident(uuid) {
    try {
      await api.ers.completeIncident(uuid);
      dispatch({ type: 'ERS_ENDED', payload: { incident_uuid: uuid } });
    } catch {}
  }

  const incidents = Object.values(state.incidents);
  const { queue } = state;

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-3">
        <ShieldAlert size={20} className="text-red-500" />
        <h1 className="text-xl font-bold text-text-primary">ERS Live View</h1>
        {incidents.length > 0 && (
          <span className="badge bg-red-500/15 text-red-500">{incidents.length} active</span>
        )}
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        {/* Active incidents */}
        <div className="card space-y-3">
          <h2 className="font-semibold text-text-primary text-sm flex items-center gap-2">
            <PhoneIncoming size={14} className="text-brand" />
            Active Incidents
            <span className="ml-auto badge bg-brand/15 text-brand">{incidents.length}</span>
          </h2>
          {incidents.length === 0 ? (
            <p className="text-xs text-text-muted">No active incidents</p>
          ) : (
            incidents.map(inc => (
              <IncidentRow
                key={inc.incident_uuid}
                incident={inc}
                onComplete={completeIncident}
              />
            ))
          )}
        </div>

        {/* Queue */}
        <div className="card">
          <h2 className="font-semibold text-text-primary text-sm mb-4 flex items-center gap-2">
            <Clock size={14} className="text-yellow-500" />
            ERS Queue
            <span className="ml-auto badge bg-yellow-500/15 text-yellow-600 dark:text-yellow-400">
              {queue.length}
            </span>
          </h2>
          <Table>
            <thead>
              <tr className="bg-surface-hover">
                <Th>#</Th>
                <Th>Caller</Th>
                <Th>ERS</Th>
                <Th>Waiting</Th>
                <Th>Status</Th>
              </tr>
            </thead>
            <tbody>
              {queue.length === 0
                ? <EmptyRow cols={5} message="Queue is empty" />
                : queue.map((q, i) => <QueueRow key={q.id ?? i} entry={q} />)}
            </tbody>
          </Table>
        </div>
      </div>
    </div>
  );
}
