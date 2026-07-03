import { useEffect, useState, useCallback } from 'react';
import {
  Bell, ShieldAlert, Users, Activity,
  PhoneIncoming, AlertCircle, CheckCircle2
} from 'lucide-react';
import {
  ResponsiveContainer, AreaChart, Area,
  XAxis, YAxis, Tooltip, CartesianGrid, Legend
} from 'recharts';
import { api } from '../api/client.js';
import { socket } from '../api/socket.js';
import StatCard from '../components/ui/StatCard.jsx';
import Badge, { StatusBadge } from '../components/ui/Badge.jsx';

const PERIODS = ['day', 'week', 'month'];

function fmt(iso) {
  if (!iso) return '—';
  return new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

export default function Dashboard() {
  const [metrics, setMetrics] = useState(null);
  const [active,  setActive]  = useState(null);
  const [chart,   setChart]   = useState([]);
  const [period,  setPeriod]  = useState('week');
  const [loading, setLoading] = useState(true);

  const fetchMetrics = useCallback(async () => {
    try {
      const [m, a, c] = await Promise.all([
        api.dashMetrics(),
        api.dashActive(),
        api.dashChart(period),
      ]);
      setMetrics(m);
      setActive(a);
      setChart(c.data || []);
    } catch (e) {
      console.error('dashboard fetch', e);
    } finally {
      setLoading(false);
    }
  }, [period]);

  useEffect(() => { fetchMetrics(); }, [fetchMetrics]);

  useEffect(() => {
    const refresh = () => fetchMetrics();
    socket.on('conference.created',  refresh);
    socket.on('conference.ended',    refresh);
    socket.on('conference.member.joined', refresh);
    return () => {
      socket.off('conference.created',  refresh);
      socket.off('conference.ended',    refresh);
      socket.off('conference.member.joined', refresh);
    };
  }, [fetchMetrics]);

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64 text-text-muted text-sm">
        Loading dashboard…
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-bold text-text-primary">Dashboard</h1>
        <p className="text-sm text-text-muted mt-0.5">Real-time overview of emergency activity</p>
      </div>

      {/* Stat tiles */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <StatCard label="Total Notifications" value={metrics?.total_notifications}
                  icon={Bell} color="brand" />
        <StatCard label="Active Incidents"    value={metrics?.active_incidents}
                  icon={ShieldAlert} color="red"
                  sub={`${metrics?.total_incidents || 0} total`} />
        <StatCard label="Queued Calls"        value={metrics?.queued_calls}
                  icon={PhoneIncoming} color="yellow" />
        <StatCard label="Users"               value={metrics?.total_users}
                  icon={Users} color="blue"
                  sub={`${metrics?.total_organizations || 0} orgs`} />
      </div>

      <div className="grid grid-cols-1 xl:grid-cols-3 gap-4">
        {/* Chart */}
        <div className="card xl:col-span-2">
          <div className="flex items-center justify-between mb-4">
            <h2 className="font-semibold text-text-primary text-sm">Activity</h2>
            <div className="flex gap-1">
              {PERIODS.map(p => (
                <button key={p} onClick={() => setPeriod(p)}
                        className={`text-xs px-2.5 py-1 rounded-lg font-medium transition-colors
                          ${period === p
                            ? 'bg-brand text-white'
                            : 'btn-ghost'}`}>
                  {p.charAt(0).toUpperCase() + p.slice(1)}
                </button>
              ))}
            </div>
          </div>
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
              <Tooltip
                contentStyle={{
                  background: 'var(--surface-panel)',
                  border: '1px solid var(--surface-border)',
                  borderRadius: '8px', fontSize: 12,
                }}
              />
              <Legend wrapperStyle={{ fontSize: 12 }} />
              <Area type="monotone" dataKey="notifications" name="Notifications"
                    stroke="rgb(99 102 241)" fill="url(#gNotif)" strokeWidth={2} />
              <Area type="monotone" dataKey="incidents" name="Incidents"
                    stroke="rgb(239 68 68)" fill="url(#gInc)" strokeWidth={2} />
            </AreaChart>
          </ResponsiveContainer>
        </div>

        {/* Active right panel */}
        <div className="space-y-4">
          {/* Active conferences */}
          <div className="card">
            <h2 className="font-semibold text-text-primary text-sm mb-3 flex items-center gap-2">
              <Activity size={14} className="text-green-500" />
              Active Conferences
              {active?.conferences?.length > 0 && (
                <Badge variant="success">{active.conferences.length}</Badge>
              )}
            </h2>
            {active?.conferences?.length ? (
              <ul className="space-y-2">
                {active.conferences.map(c => (
                  <li key={c.name}
                      className="flex items-center justify-between text-xs py-1.5
                                 border-b border-surface-border last:border-0">
                    <span className="font-mono text-text-secondary truncate mr-2">{c.name}</span>
                    <Badge variant="success">{c.member_count} members</Badge>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-xs text-text-muted">No active conferences</p>
            )}
          </div>

          {/* Recent notifications */}
          <div className="card">
            <h2 className="font-semibold text-text-primary text-sm mb-3 flex items-center gap-2">
              <Bell size={14} className="text-brand" />
              Recent Notifications
            </h2>
            {active?.recent_notifications?.length ? (
              <ul className="space-y-2">
                {active.recent_notifications.slice(0, 5).map(n => (
                  <li key={n.id}
                      className="flex items-start gap-2 text-xs py-1.5
                                 border-b border-surface-border last:border-0">
                    {n.status === 'SENT'
                      ? <CheckCircle2 size={12} className="text-green-500 mt-0.5 shrink-0" />
                      : <AlertCircle  size={12} className="text-yellow-500 mt-0.5 shrink-0" />}
                    <div className="min-w-0">
                      <p className="text-text-secondary truncate">{n.title || n.id}</p>
                      <p className="text-text-muted">{fmt(n.created_at)}</p>
                    </div>
                    <StatusBadge status={n.status} />
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-xs text-text-muted">No recent notifications</p>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
