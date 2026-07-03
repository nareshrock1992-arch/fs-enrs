import { useEffect, useState } from 'react';
import { PhoneIncoming, Clock, CheckCircle2 } from 'lucide-react';
import { api } from '../../api/client.js';
import { socket } from '../../api/socket.js';
import { Table, Th, Td, Tr, EmptyRow } from '../../components/ui/Table.jsx';
import { StatusBadge } from '../../components/ui/Badge.jsx';

function age(iso) {
  const s = Math.floor((Date.now() - new Date(iso)) / 1000);
  if (s < 60) return `${s}s`;
  return `${Math.floor(s / 60)}m ${s % 60}s`;
}

export default function ErsLive() {
  const [incidents, setIncidents] = useState([]);
  const [queue,     setQueue]     = useState([]);
  const [tick,      setTick]      = useState(0);

  async function load() {
    try {
      const [inc, q] = await Promise.all([
        api.ers.incidents({ status: 'IN_PROGRESS' }),
        api.ers.queue(),
      ]);
      setIncidents(inc.incidents || []);
      setQueue(q.queue || []);
    } catch {}
  }

  useEffect(() => {
    load();
    const handler = () => load();
    socket.on('conference.created',  handler);
    socket.on('conference.ended',    handler);
    socket.on('channel.hangup',      handler);
    return () => {
      socket.off('conference.created',  handler);
      socket.off('conference.ended',    handler);
      socket.off('channel.hangup',      handler);
    };
  }, []);

  // Age counter
  useEffect(() => {
    const t = setInterval(() => setTick(x => x + 1), 5000);
    return () => clearInterval(t);
  }, []);

  async function complete(id) {
    try {
      await fetch(`/api/v1/ers/incidents/${id}/complete`, { method: 'POST' });
      load();
    } catch {}
  }

  return (
    <div className="space-y-6">
      <h1 className="text-xl font-bold text-text-primary">ERS Live View</h1>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        {/* Active incidents */}
        <div className="card">
          <h2 className="font-semibold text-text-primary text-sm mb-4 flex items-center gap-2">
            <PhoneIncoming size={14} className="text-brand" />
            Active Incidents ({incidents.length})
          </h2>
          <Table>
            <thead><tr className="bg-surface-hover">
              <Th>Conference</Th><Th>Age</Th><Th>Status</Th><Th></Th>
            </tr></thead>
            <tbody>
              {incidents.length === 0 ? <EmptyRow cols={4} message="No active incidents" /> : incidents.map(i => (
                <Tr key={i.id}>
                  <Td className="font-mono text-xs">{i.conference_id || '—'}</Td>
                  <Td className="text-text-muted text-xs">{age(i.started_at)}</Td>
                  <Td><StatusBadge status={i.status} /></Td>
                  <Td>
                    <button onClick={() => complete(i.id)}
                            className="btn-ghost p-1 text-green-500" title="Complete">
                      <CheckCircle2 size={13} />
                    </button>
                  </Td>
                </Tr>
              ))}
            </tbody>
          </Table>
        </div>

        {/* Queue */}
        <div className="card">
          <h2 className="font-semibold text-text-primary text-sm mb-4 flex items-center gap-2">
            <Clock size={14} className="text-yellow-500" />
            Queue ({queue.length})
          </h2>
          <Table>
            <thead><tr className="bg-surface-hover">
              <Th>Position</Th><Th>Incident</Th><Th>Queued At</Th><Th>Status</Th>
            </tr></thead>
            <tbody>
              {queue.length === 0 ? <EmptyRow cols={4} message="Queue is empty" /> : queue.map(q => (
                <Tr key={q.id}>
                  <Td className="text-center font-bold">{q.position}</Td>
                  <Td className="font-mono text-xs">{q.incident_id?.slice(0,8)}…</Td>
                  <Td className="text-text-muted text-xs">{age(q.queued_at)} ago</Td>
                  <Td><StatusBadge status={q.status} /></Td>
                </Tr>
              ))}
            </tbody>
          </Table>
        </div>
      </div>
    </div>
  );
}
