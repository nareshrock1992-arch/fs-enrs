import { useEffect, useState, useCallback, useReducer } from 'react';
import {
  Bell, ShieldAlert, Users, Building2,
  PhoneIncoming, Settings2,
} from 'lucide-react';
import {
  ResponsiveContainer, AreaChart, Area,
  XAxis, YAxis, Tooltip, CartesianGrid, Legend,
} from 'recharts';

import { api } from '../api/client.js';
import { useSocketEvent } from '../hooks/useSocketEvent.js';
import StatCard from '../components/ui/StatCard.jsx';
import EslStatusBanner from '../components/dashboard/EslStatusBanner.jsx';
import ENSBlastPanel from '../components/dashboard/ENSBlastPanel.jsx';
import ErsActivePanel from '../components/dashboard/ErsActivePanel.jsx';
import ErsQueuePanel from '../components/dashboard/ErsQueuePanel.jsx';

// ── Chart helpers ─────────────────────────────────────────────────────────────

const PERIODS = ['day', 'week', 'month'];

function fmtBucket(iso, period) {
  if (!iso) return '';
  const d = new Date(iso);
  if (period === 'day') return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  return d.toLocaleDateString([], { month: 'short', day: 'numeric' });
}

// ── Dashboard reducer — surgical state updates from socket events ──────────────

function reducer(state, action) {
  switch (action.type) {

    // ── ENS ────────────────────────────────────────────────────────────────────
    case 'ENS_STARTED':
      return {
        ...state,
        activeBlasts: {
          ...state.activeBlasts,
          [action.payload.notification_uuid]: {
            notification_uuid: action.payload.notification_uuid,
            name:              action.payload.name || 'ENS Blast',
            total_targets:     action.payload.total_targets || 0,
            answered:          0,
            no_answer:         0,
            failed:            0,
            replayed:          0,
            started_at:        new Date().toISOString(),
          },
        },
        metrics: {
          ...state.metrics,
          notifications_today: (state.metrics?.notifications_today ?? 0) + 1,
        },
      };

    case 'ENS_DELIVERY': {
      const uuid = action.payload.notification_uuid;
      const blast = state.activeBlasts[uuid];
      if (!blast) return state;
      const field = action.payload.status === 'ANSWERED' ? 'answered'
        : action.payload.status === 'NO_ANSWER' ? 'no_answer'
        : action.payload.status === 'FAILED'    ? 'failed'
        : null;
      if (!field) return state;
      return {
        ...state,
        activeBlasts: {
          ...state.activeBlasts,
          [uuid]: { ...blast, [field]: blast[field] + 1 },
        },
      };
    }

    case 'ENS_CALLBACK': {
      const uuid = action.payload.notification_uuid;
      const blast = state.activeBlasts[uuid];
      if (!blast) return state;
      return {
        ...state,
        activeBlasts: {
          ...state.activeBlasts,
          [uuid]: { ...blast, replayed: blast.replayed + 1 },
        },
      };
    }

    case 'ENS_COMPLETE': {
      const { [action.payload.notification_uuid]: _, ...rest } = state.activeBlasts;
      return { ...state, activeBlasts: rest };
    }

    // ── ERS ────────────────────────────────────────────────────────────────────
    case 'ERS_CREATED':
      return {
        ...state,
        activeIncidents: {
          ...state.activeIncidents,
          [action.payload.incident_uuid]: {
            ...action.payload,
            responders: [],
          },
        },
        metrics: {
          ...state.metrics,
          active_conferences: (state.metrics?.active_conferences ?? 0) + 1,
        },
      };

    case 'ERS_RESPONDER': {
      const uuid = action.payload.incident_uuid;
      const inc = state.activeIncidents[uuid];
      if (!inc) return state;
      // Replace or append responder entry
      const existing = inc.responders.findIndex(
        r => r.responder_number === action.payload.responder_number
      );
      const responders = [...inc.responders];
      if (existing >= 0) responders[existing] = action.payload;
      else responders.push(action.payload);
      return {
        ...state,
        activeIncidents: {
          ...state.activeIncidents,
          [uuid]: { ...inc, responders },
        },
      };
    }

    case 'ERS_ENDED': {
      const { [action.payload.incident_uuid]: _, ...rest } = state.activeIncidents;
      return {
        ...state,
        activeIncidents: rest,
        metrics: {
          ...state.metrics,
          active_conferences: Math.max(0, (state.metrics?.active_conferences ?? 1) - 1),
        },
      };
    }

    // ── Queue ──────────────────────────────────────────────────────────────────
    case 'QUEUE_SET':
      return {
        ...state,
        queue: action.payload,
        metrics: {
          ...state.metrics,
          queued_calls: action.payload.length,
        },
      };

    // ── Seed from REST on mount ────────────────────────────────────────────────
    case 'SEED':
      return { ...state, ...action.payload };

    default:
      return state;
  }
}

const INIT = {
  metrics:         null,
  activeBlasts:    {},   // { [notification_uuid]: blast }
  activeIncidents: {},   // { [incident_uuid]: incident }
  queue:           [],
};

// ── Chart tooltip ─────────────────────────────────────────────────────────────

function ChartTooltip({ active, payload, label }) {
  if (!active || !payload?.length) return null;
  return (
    <div className="rounded-lg border border-surface-border bg-surface-panel px-3 py-2 text-xs shadow-lg">
      <p className="text-text-muted mb-1">{label}</p>
      {payload.map(p => (
        <p key={p.dataKey} style={{ color: p.stroke }}>
          {p.name}: <strong>{p.value}</strong>
        </p>
      ))}
    </div>
  );
}

// ── Dashboard ─────────────────────────────────────────────────────────────────

export default function Dashboard() {
  const [state, dispatch] = useReducer(reducer, INIT);
  const [chart,   setChart]   = useState([]);
  const [period,  setPeriod]  = useState('week');
  const [loading, setLoading] = useState(true);
  const [esl,     setEsl]     = useState({ connected: false });

  // ── Seed initial data from REST ─────────────────────────────────────────────
  const seed = useCallback(async () => {
    try {
      const [m, active] = await Promise.all([
        api.dashMetrics(),
        api.dashActive(),
      ]);

      // Build initial activeIncidents from REST
      const activeIncidents = {};
      for (const conf of active.conferences || []) {
        activeIncidents[conf.incident_uuid || conf.id] = {
          incident_uuid:   conf.incident_uuid || conf.id,
          conference_room: conf.conference_room || conf.name,
          ers_name:        conf.ers_name,
          caller_number:   conf.caller_number,
          group_type:      conf.group_type || 'primary',
          started_at:      conf.started_at,
          responders:      conf.responders || [],
        };
      }

      dispatch({
        type: 'SEED',
        payload: {
          metrics:         m,
          activeIncidents,
          queue:           active.queued || [],
        },
      });

      setEsl(m.esl || { connected: false });
    } catch (e) {
      console.error('[dashboard] seed failed', e);
    } finally {
      setLoading(false);
    }
  }, []);

  // ── Chart data ──────────────────────────────────────────────────────────────
  const loadChart = useCallback(async () => {
    try {
      const c = await api.dashChart(period);
      setChart(
        (c.data || []).map(row => ({
          ...row,
          label: fmtBucket(row.bucket, period),
        }))
      );
    } catch {}
  }, [period]);

  useEffect(() => { seed(); }, [seed]);
  useEffect(() => { loadChart(); }, [loadChart]);

  // ── Socket.IO push events ───────────────────────────────────────────────────
  useSocketEvent('esl.status', setEsl);

  useSocketEvent('enrs::ens_started',
    p => dispatch({ type: 'ENS_STARTED', payload: p }));

  useSocketEvent('enrs::ens_delivery',
    p => dispatch({ type: 'ENS_DELIVERY', payload: p }));

  useSocketEvent('enrs::ens_callback',
    p => dispatch({ type: 'ENS_CALLBACK', payload: p }));

  useSocketEvent('enrs::ens_complete',
    p => dispatch({ type: 'ENS_COMPLETE', payload: p }));

  useSocketEvent('enrs::ers_incident_created',
    p => dispatch({ type: 'ERS_CREATED', payload: p }));

  useSocketEvent('enrs::ers_responder_update',
    p => dispatch({ type: 'ERS_RESPONDER', payload: p }));

  useSocketEvent('enrs::ers_incident_ended',
    p => dispatch({ type: 'ERS_ENDED', payload: p }));

  // Re-seed metrics on any ESL conference event (catches direct FS calls not via internal API)
  const reseed = useCallback(() => seed(), [seed]);
  useSocketEvent('conference.created',        reseed);
  useSocketEvent('conference.ended',          reseed);
  useSocketEvent('conference.member.joined',  reseed);

  // ── Derived values ──────────────────────────────────────────────────────────
  const { metrics, activeBlasts, activeIncidents, queue } = state;
  const hasBlasts    = Object.keys(activeBlasts).length > 0;
  const hasIncidents = Object.keys(activeIncidents).length > 0;

  // ── Render ──────────────────────────────────────────────────────────────────
  if (loading) {
    return (
      <div className="flex items-center justify-center h-64 text-text-muted text-sm">
        Loading dashboard…
      </div>
    );
  }

  return (
    <div className="space-y-5">

      {/* Page title + ESL banner */}
      <div className="flex flex-col sm:flex-row sm:items-center gap-3">
        <div className="flex-1">
          <h1 className="text-xl font-bold text-text-primary">Dashboard</h1>
          <p className="text-xs text-text-muted mt-0.5">Real-time emergency activity</p>
        </div>
        <EslStatusBanner
          initialConnected={esl.connected}
          host={esl.host}
          port={esl.port}
        />
      </div>

      {/* Stat cards */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <StatCard
          label="Active Incidents"
          value={Object.keys(activeIncidents).length}
          icon={ShieldAlert}
          color={Object.keys(activeIncidents).length > 0 ? 'red' : 'green'}
          sub={`${metrics?.notifications_today ?? 0} notifications today`}
        />
        <StatCard
          label="Active ENS Blasts"
          value={Object.keys(activeBlasts).length}
          icon={Bell}
          color="brand"
          sub={`${metrics?.ens_configurations ?? 0} configs`}
        />
        <StatCard
          label="Queued Calls"
          value={queue.length}
          icon={PhoneIncoming}
          color={queue.length > 0 ? 'yellow' : 'green'}
          sub="ERS overflow queue"
        />
        <StatCard
          label="Organizations"
          value={metrics?.organizations ?? '—'}
          icon={Building2}
          color="blue"
          sub={`${metrics?.contacts ?? 0} contacts`}
        />
      </div>

      {/* Active blasts — only shown when a blast is running */}
      {hasBlasts && <ENSBlastPanel blasts={activeBlasts} />}

      {/* Active incidents */}
      <div className={`grid gap-4 ${hasIncidents ? 'grid-cols-1 xl:grid-cols-2' : 'grid-cols-1'}`}>
        <ErsActivePanel incidents={activeIncidents} />
        {queue.length > 0 && <ErsQueuePanel queue={queue} />}
      </div>

      {/* Chart + recent */}
      <div className="grid grid-cols-1 xl:grid-cols-3 gap-4">

        {/* Activity chart */}
        <div className="card xl:col-span-2">
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-sm font-semibold text-text-primary">Activity</h2>
            <div className="flex gap-1">
              {PERIODS.map(p => (
                <button key={p} onClick={() => setPeriod(p)}
                  className={`text-xs px-2.5 py-1 rounded-lg font-medium transition-colors
                    ${period === p ? 'bg-brand text-white' : 'btn-ghost'}`}>
                  {p.charAt(0).toUpperCase() + p.slice(1)}
                </button>
              ))}
            </div>
          </div>
          {chart.length === 0 ? (
            <div className="flex items-center justify-center h-[220px] text-xs text-text-muted">
              No activity in this period
            </div>
          ) : (
            <ResponsiveContainer width="100%" height={220}>
              <AreaChart data={chart} margin={{ top: 4, right: 4, bottom: 0, left: -20 }}>
                <defs>
                  <linearGradient id="gNotif" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%"  stopColor="rgb(99 102 241)" stopOpacity={0.3} />
                    <stop offset="95%" stopColor="rgb(99 102 241)" stopOpacity={0}   />
                  </linearGradient>
                  <linearGradient id="gInc" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%"  stopColor="rgb(239 68 68)" stopOpacity={0.3} />
                    <stop offset="95%" stopColor="rgb(239 68 68)" stopOpacity={0}   />
                  </linearGradient>
                </defs>
                <CartesianGrid strokeDasharray="3 3" stroke="rgba(128,128,128,0.15)" />
                <XAxis dataKey="label" tick={{ fontSize: 11 }} tickLine={false} axisLine={false} />
                <YAxis tick={{ fontSize: 11 }} tickLine={false} axisLine={false} allowDecimals={false} />
                <Tooltip content={<ChartTooltip />} />
                <Legend wrapperStyle={{ fontSize: 12 }} />
                <Area type="monotone" dataKey="notifications" name="Notifications"
                  stroke="rgb(99 102 241)" fill="url(#gNotif)" strokeWidth={2} />
                <Area type="monotone" dataKey="incidents" name="Incidents"
                  stroke="rgb(239 68 68)" fill="url(#gInc)" strokeWidth={2} />
              </AreaChart>
            </ResponsiveContainer>
          )}
        </div>

        {/* System summary */}
        <div className="card">
          <h2 className="text-sm font-semibold text-text-primary mb-4 flex items-center gap-2">
            <Settings2 size={14} className="text-text-muted" />
            System Summary
          </h2>
          <dl className="space-y-3 text-xs">
            {[
              { label: 'ENS Configurations',  value: metrics?.ens_configurations ?? '—' },
              { label: 'ERS Configurations',  value: metrics?.ers_configurations ?? '—' },
              { label: 'Responder Groups',    value: metrics?.groups ?? '—' },
              { label: 'Active Contacts',     value: metrics?.contacts ?? '—' },
              { label: 'Notifications Today', value: metrics?.notifications_today ?? 0 },
              { label: 'Incidents Today',     value: metrics?.incidents_today ?? 0 },
            ].map(({ label, value }) => (
              <div key={label} className="flex items-center justify-between
                                          border-b border-surface-border pb-2 last:border-0 last:pb-0">
                <dt className="text-text-muted">{label}</dt>
                <dd className="font-semibold text-text-primary">{value}</dd>
              </div>
            ))}
          </dl>
        </div>
      </div>
    </div>
  );
}
