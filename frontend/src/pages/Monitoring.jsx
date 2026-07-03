import { useEffect, useState } from 'react';
import { Activity, Wifi, WifiOff } from 'lucide-react';
import { api } from '../api/client.js';
import { socket } from '../api/socket.js';
import Badge, { StatusBadge } from '../components/ui/Badge.jsx';

function fmt(iso) {
  return iso ? new Date(iso).toLocaleString() : '—';
}

export default function Monitoring() {
  const [esl, setEsl] = useState(null);
  const [conferences, setConfs] = useState([]);

  async function refresh() {
    try {
      const [status, active] = await Promise.all([
        api.settings.eslStatus(),
        api.dashActive(),
      ]);
      setEsl(status);
      setConfs(active.conferences || []);
    } catch {}
  }

  useEffect(() => {
    refresh();
    const handler = () => refresh();
    socket.on('conference.created',        handler);
    socket.on('conference.ended',          handler);
    socket.on('conference.member.joined',  handler);
    socket.on('conference.member.left',    handler);
    return () => {
      socket.off('conference.created',       handler);
      socket.off('conference.ended',         handler);
      socket.off('conference.member.joined', handler);
      socket.off('conference.member.left',   handler);
    };
  }, []);

  return (
    <div className="space-y-6">
      <h1 className="text-xl font-bold text-text-primary">Live Monitoring</h1>

      {/* ESL status */}
      <div className="card flex items-center gap-4">
        <div className={`w-10 h-10 rounded-xl flex items-center justify-center
          ${esl?.connected ? 'bg-green-500/15 text-green-500' : 'bg-red-500/15 text-red-500'}`}>
          {esl?.connected ? <Wifi size={18} /> : <WifiOff size={18} />}
        </div>
        <div>
          <p className="text-sm font-semibold text-text-primary">FreeSWITCH ESL</p>
          <p className="text-xs text-text-muted">
            {esl?.connected ? `Connected — ${esl.host}:${esl.port}` : 'Disconnected'}
          </p>
        </div>
        <Badge variant={esl?.connected ? 'success' : 'danger'} className="ml-auto">
          {esl?.connected ? 'Online' : 'Offline'}
        </Badge>
      </div>

      {/* Live conferences */}
      <div className="card">
        <h2 className="font-semibold text-text-primary text-sm mb-4 flex items-center gap-2">
          <Activity size={14} className="text-green-500" />
          Active Conferences ({conferences.length})
        </h2>
        {conferences.length === 0 ? (
          <p className="text-sm text-text-muted">No active conferences right now.</p>
        ) : (
          <div className="space-y-3">
            {conferences.map(c => (
              <div key={c.name}
                   className="border border-surface-border rounded-lg p-3 flex items-center gap-4">
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-mono font-medium text-text-primary truncate">{c.name}</p>
                  <p className="text-xs text-text-muted">Started {fmt(c.created_at)}</p>
                </div>
                <div className="text-center">
                  <p className="text-lg font-bold text-text-primary">{c.member_count ?? 0}</p>
                  <p className="text-xs text-text-muted">members</p>
                </div>
                <Badge variant="success">Active</Badge>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
