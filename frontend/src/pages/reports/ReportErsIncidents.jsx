import { useEffect, useState } from 'react';
import { RefreshCw, Download, ChevronDown, ChevronRight } from 'lucide-react';
import { api } from '../../api/client.js';
import Badge from '../../components/ui/Badge.jsx';

// Phase 5 C4 — full ERS incident detail: timestamps, every participant's
// join/leave/rejoin + directory identity, recording link.
export default function ReportErsIncidents() {
  const [incidents, setIncidents] = useState([]);
  const [loading, setLoading] = useState(false);
  const [expanded, setExpanded] = useState({});
  const [filters, setFilters] = useState({ from: '', to: '' });

  async function load() {
    setLoading(true);
    try {
      const q = {};
      if (filters.from) q.from = filters.from;
      if (filters.to)   q.to = filters.to;
      const r = await api.reports.ersIncidents(q);
      setIncidents(r.incidents || []);
    } catch (e) {
      console.error(e);
    } finally {
      setLoading(false);
    }
  }
  useEffect(() => { load(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const fmt = iso => iso ? new Date(iso).toLocaleString() : '—';
  const dur = s => s >= 3600 ? `${Math.floor(s/3600)}h ${Math.floor((s%3600)/60)}m` : s >= 60 ? `${Math.floor(s/60)}m ${s%60}s` : `${s}s`;

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-bold text-text-primary">ERS Incident Report</h1>
          <p className="text-xs text-text-muted mt-0.5">Full participant detail — join, leave, and rejoin per responder</p>
        </div>
        <div className="flex items-end gap-2">
          <div><label className="label">From</label>
            <input type="date" className="input" value={filters.from} onChange={e => setFilters(f => ({ ...f, from: e.target.value }))} /></div>
          <div><label className="label">To</label>
            <input type="date" className="input" value={filters.to} onChange={e => setFilters(f => ({ ...f, to: e.target.value }))} /></div>
          <button onClick={load} disabled={loading} className="btn-primary flex items-center gap-1.5">
            <RefreshCw size={13} className={loading ? 'animate-spin' : ''} /> Refresh
          </button>
        </div>
      </div>

      <div className="space-y-2">
        {incidents.length === 0 && (
          <p className="text-sm text-text-muted text-center py-8">No incidents in this range.</p>
        )}
        {incidents.map(inc => (
          <div key={inc.id} className="card p-0 overflow-hidden">
            <button
              className="w-full flex items-center gap-3 px-4 py-3 text-left hover:bg-surface-hover transition-colors"
              onClick={() => setExpanded(e => ({ ...e, [inc.id]: !e[inc.id] }))}
            >
              {expanded[inc.id] ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
              <div className="flex-1 min-w-0">
                <p className="text-sm font-semibold text-text-primary">
                  {inc.ers_name} — {inc.group_type === 'primary' ? 'Level 1' : 'Level 2'}
                </p>
                <p className="text-[11px] text-text-muted">
                  Caller {inc.caller_name || inc.caller_number} · {fmt(inc.started_at)} · {dur(inc.duration_seconds)}
                </p>
              </div>
              <Badge variant={inc.status === 'ACTIVE' ? 'danger' : inc.status === 'COMPLETED' ? 'success' : 'warning'}>
                {inc.status}
              </Badge>
            </button>

            {expanded[inc.id] && (
              <div className="px-4 pb-4 border-t border-surface-border pt-3 space-y-3">
                <div className="grid grid-cols-2 md:grid-cols-4 gap-3 text-[11px]">
                  <div><p className="text-text-muted">Room</p><p className="font-mono text-text-primary">{inc.conference_room || '—'}</p></div>
                  <div><p className="text-text-muted">Started</p><p className="text-text-primary">{fmt(inc.started_at)}</p></div>
                  <div><p className="text-text-muted">Ended</p><p className="text-text-primary">{fmt(inc.ended_at)}</p></div>
                  <div><p className="text-text-muted">Recording</p>
                    <p className="font-mono text-text-primary break-all">{inc.recording_path || '—'}</p></div>
                </div>

                <div>
                  <p className="text-[10px] font-medium text-text-muted uppercase tracking-wide mb-1.5">
                    Participants ({(inc.participants || []).length})
                  </p>
                  {(inc.participants || []).length === 0
                    ? <p className="text-[11px] text-text-muted">No participant events recorded.</p>
                    : (
                      <table className="w-full text-[11px]">
                        <thead><tr className="text-text-muted text-left">
                          <th className="py-1 pr-3 font-medium">Name</th>
                          <th className="py-1 pr-3 font-medium">Number</th>
                          <th className="py-1 pr-3 font-medium">Role</th>
                          <th className="py-1 pr-3 font-medium">Joined</th>
                          <th className="py-1 pr-3 font-medium">Left</th>
                          <th className="py-1 font-medium">Rejoined</th>
                        </tr></thead>
                        <tbody>
                          {(inc.participants || []).map((p, i) => (
                            <tr key={i} className="border-t border-surface-border/50">
                              <td className="py-1.5 pr-3 text-text-primary">{p.name}</td>
                              <td className="py-1.5 pr-3 font-mono text-text-muted">{p.number}</td>
                              <td className="py-1.5 pr-3">{p.role === 'initiator'
                                ? <Badge variant="danger">initiator</Badge>
                                : <span className="text-text-muted">responder</span>}</td>
                              <td className="py-1.5 pr-3 text-text-muted">{fmt(p.joined_at)}</td>
                              <td className="py-1.5 pr-3 text-text-muted">{fmt(p.left_at)}</td>
                              <td className="py-1.5 text-text-muted">{fmt(p.rejoined_at)}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    )}
                </div>
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
