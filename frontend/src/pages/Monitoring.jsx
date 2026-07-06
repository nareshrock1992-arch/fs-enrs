import { useEffect, useState, useCallback } from 'react';
import { Activity, Wifi, WifiOff, Users, Clock, RefreshCw } from 'lucide-react';
import { api } from '../api/client.js';
import { useSocketEvent } from '../hooks/useSocketEvent.js';
import { useLiveDuration } from '../hooks/useLiveDuration.js';
import Badge from '../components/ui/Badge.jsx';
import PulsingDot from '../components/ui/PulsingDot.jsx';

function fmt(iso) {
  return iso ? new Date(iso).toLocaleString() : '—';
}

function ConferenceRow({ conf }) {
  const duration = useLiveDuration(conf.started_at || conf.created_at);
  return (
    <div className="border border-surface-border rounded-lg p-3 flex items-center gap-4
                    hover:bg-surface-hover transition-colors">
      <div className="flex-1 min-w-0">
        <p className="text-sm font-mono font-medium text-text-primary truncate">
          {conf.conference_room || conf.name}
        </p>
        <p className="text-xs text-text-muted">
          {conf.ers_name ? `ERS: ${conf.ers_name} · ` : ''}Started {fmt(conf.started_at || conf.created_at)}
        </p>
      </div>
      <div className="flex items-center gap-1.5 text-xs text-text-muted shrink-0">
        <Clock size={11} /> {duration}
      </div>
      <div className="text-center shrink-0">
        <p className="text-lg font-bold text-text-primary">{conf.member_count ?? 0}</p>
        <p className="text-xs text-text-muted">members</p>
      </div>
      <Badge variant="success">Active</Badge>
    </div>
  );
}

export default function Monitoring() {
  const [esl,         setEsl]         = useState(null);
  const [conferences, setConferences] = useState([]);
  const [lastRefresh, setLastRefresh] = useState(null);

  const refresh = useCallback(async () => {
    try {
      const [status, active] = await Promise.all([
        api.settings.eslStatus(),
        api.dashActive(),
      ]);
      setEsl(status);
      setConferences(active.conferences || []);
      setLastRefresh(new Date());
    } catch {}
  }, []);

  useEffect(() => { refresh(); }, [refresh]);

  // ESL status updates via push — no polling needed
  useSocketEvent('esl.status', payload => {
    setEsl(prev => ({ ...prev, ...payload }));
  });

  // Conference list changes via push
  useSocketEvent('enrs::ers_incident_created', refresh);
  useSocketEvent('enrs::ers_incident_ended',   refresh);
  useSocketEvent('conference.created',         refresh);
  useSocketEvent('conference.ended',           refresh);
  useSocketEvent('conference.member.joined',   refresh);
  useSocketEvent('conference.member.left',     refresh);

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-3">
        <Activity size={20} className="text-green-500" />
        <h1 className="text-xl font-bold text-text-primary">Live Monitoring</h1>
        <button onClick={refresh}
                className="btn-ghost ml-auto flex items-center gap-1.5 text-xs">
          <RefreshCw size={13} /> Refresh
        </button>
        {lastRefresh && (
          <span className="text-xs text-text-muted">
            Updated {lastRefresh.toLocaleTimeString()}
          </span>
        )}
      </div>

      {/* ESL status card */}
      <div className="card flex items-center gap-4">
        <div className={`w-10 h-10 rounded-xl flex items-center justify-center
          ${esl?.connected ? 'bg-green-500/15 text-green-500' : 'bg-red-500/15 text-red-500'}`}>
          {esl?.connected ? <Wifi size={18} /> : <WifiOff size={18} />}
        </div>
        <div className="flex-1">
          <p className="text-sm font-semibold text-text-primary flex items-center gap-2">
            FreeSWITCH ESL
            <PulsingDot active={!!esl?.connected} size="sm" />
          </p>
          <p className="text-xs text-text-muted">
            {esl?.connected
              ? `Connected — ${esl.host}:${esl.port}`
              : 'Disconnected — attempting reconnect…'}
          </p>
        </div>
        <div className="text-right shrink-0">
          <Badge variant={esl?.connected ? 'success' : 'danger'}>
            {esl?.connected ? 'Online' : 'Offline'}
          </Badge>
          {esl?.reconnect_attempts > 0 && (
            <p className="text-[10px] text-text-muted mt-1">
              Attempt #{esl.reconnect_attempts}
            </p>
          )}
        </div>
      </div>

      {/* Stats row */}
      <div className="grid grid-cols-2 sm:grid-cols-3 gap-3 text-sm">
        <div className="card text-center py-3">
          <p className="text-2xl font-bold text-text-primary">{conferences.length}</p>
          <p className="text-xs text-text-muted mt-0.5">Active Conferences</p>
        </div>
        <div className="card text-center py-3">
          <p className="text-2xl font-bold text-text-primary">
            {conferences.reduce((s, c) => s + (c.member_count ?? 0), 0)}
          </p>
          <p className="text-xs text-text-muted mt-0.5">Total Members</p>
        </div>
        <div className="card text-center py-3 sm:col-span-1 col-span-2">
          <p className={`text-2xl font-bold ${esl?.connected ? 'text-green-500' : 'text-red-500'}`}>
            {esl?.connected ? 'UP' : 'DOWN'}
          </p>
          <p className="text-xs text-text-muted mt-0.5">ESL Status</p>
        </div>
      </div>

      {/* Live conferences */}
      <div className="card">
        <h2 className="font-semibold text-text-primary text-sm mb-4 flex items-center gap-2">
          <Users size={14} className="text-green-500" />
          Active Conferences
          <span className="ml-auto badge bg-green-500/15 text-green-600 dark:text-green-400">
            {conferences.length}
          </span>
        </h2>
        {conferences.length === 0 ? (
          <p className="text-sm text-text-muted">No active conferences right now.</p>
        ) : (
          <div className="space-y-2">
            {conferences.map((c, i) => (
              <ConferenceRow key={c.conference_room || c.name || i} conf={c} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
