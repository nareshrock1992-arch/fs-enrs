import { useEffect, useState, useCallback } from 'react';
import { RefreshCw, ChevronDown, ChevronRight, Mic } from 'lucide-react';
import { api } from '../../api/client.js';
import Badge from '../../components/ui/Badge.jsx';

const STATUS_VARIANT = { ACTIVE: 'danger', COMPLETED: 'success', QUEUED: 'warning', FAILED: 'danger', CANCELLED: 'default' };

const fmt   = iso => iso ? new Date(iso).toLocaleString() : '—';
const dur   = s  => !s ? '—' : s >= 3600 ? `${Math.floor(s/3600)}h ${Math.floor((s%3600)/60)}m` : s >= 60 ? `${Math.floor(s/60)}m ${s%60}s` : `${s}s`;

function DetailPanel({ uuid, onClose }) {
  const [data, setData]     = useState(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr]       = useState(null);

  useEffect(() => {
    setLoading(true); setErr(null);
    api.reports.ersDetail(uuid)
      .then(r => setData(r.incident))
      .catch(e => setErr(e.message))
      .finally(() => setLoading(false));
  }, [uuid]);

  if (loading) return <div className="text-xs text-text-muted p-4">Loading…</div>;
  if (err)     return <div className="text-xs text-red-500 p-4">{err}</div>;
  if (!data)   return null;

  const inc = data;

  return (
    <div className="px-4 pb-4 border-t border-surface-border pt-3 space-y-4">
      {/* Key metadata */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3 text-[11px]">
        <div><p className="text-text-muted">Incident UUID</p><p className="font-mono text-text-primary truncate">{inc.incident_uuid}</p></div>
        <div><p className="text-text-muted">Conference Room</p><p className="font-mono text-text-primary">{inc.conference_room || '—'}</p></div>
        <div><p className="text-text-muted">Started</p><p className="text-text-primary">{fmt(inc.started_at)}</p></div>
        <div><p className="text-text-muted">Ended</p><p className="text-text-primary">{fmt(inc.ended_at)}</p></div>
        <div><p className="text-text-muted">Duration</p><p className="text-text-primary">{dur(inc.duration_seconds)}</p></div>
        <div><p className="text-text-muted">Priority</p><p className="text-text-primary">{inc.priority || '—'}</p></div>
        <div><p className="text-text-muted">Group Type</p><p className="text-text-primary capitalize">{inc.group_type || '—'}</p></div>
        <div><p className="text-text-muted">Organization</p><p className="text-text-primary">{inc.org_name || '—'}</p></div>
      </div>

      {/* Recording */}
      {(inc.recording || inc.recording_path) && (
        <div className="flex items-center gap-2 text-[11px] bg-surface-hover rounded p-2">
          <Mic size={12} className="text-text-muted shrink-0" />
          <span className="text-text-muted">Recording:</span>
          <span className="font-mono text-text-primary truncate">{inc.recording?.recording_path || inc.recording_path}</span>
          {inc.recording?.duration_sec && <span className="text-text-muted ml-auto shrink-0">{dur(inc.recording.duration_sec)}</span>}
        </div>
      )}

      {/* Responders */}
      <div>
        <p className="text-[10px] font-medium text-text-muted uppercase tracking-wide mb-1.5">
          Responders ({(inc.responders || []).length})
        </p>
        {(inc.responders || []).length === 0
          ? <p className="text-[11px] text-text-muted">No responder records.</p>
          : (
            <div className="overflow-x-auto">
              <table className="w-full text-[11px]">
                <thead><tr className="text-text-muted text-left">
                  <th className="py-1 pr-3 font-medium">Name</th>
                  <th className="py-1 pr-3 font-medium">Number</th>
                  <th className="py-1 pr-3 font-medium">Status</th>
                  <th className="py-1 pr-3 font-medium">Joined Via</th>
                  <th className="py-1 pr-3 font-medium">Join Time</th>
                  <th className="py-1 pr-3 font-medium">Leave Time</th>
                  <th className="py-1 font-medium">Hangup Cause</th>
                </tr></thead>
                <tbody>
                  {(inc.responders || []).map((r, i) => (
                    <tr key={i} className="border-t border-surface-border/50">
                      <td className="py-1.5 pr-3 text-text-primary">{r.name}</td>
                      <td className="py-1.5 pr-3 font-mono text-text-muted">{r.number || '—'}</td>
                      <td className="py-1.5 pr-3">
                        <Badge variant={r.status === 'JOINED' || r.status === 'REJOINED' ? 'success' : r.status === 'MISSED' ? 'warning' : 'default'}>
                          {r.status}
                        </Badge>
                      </td>
                      <td className="py-1.5 pr-3 text-text-muted capitalize">{r.joined_via || '—'}</td>
                      <td className="py-1.5 pr-3 text-text-muted">{fmt(r.join_time)}</td>
                      <td className="py-1.5 pr-3 text-text-muted">{fmt(r.leave_time)}</td>
                      <td className="py-1.5 text-text-muted">{r.hangup_cause || '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )
        }
      </div>

      {/* Participants */}
      <div>
        <p className="text-[10px] font-medium text-text-muted uppercase tracking-wide mb-1.5">
          Conference Participants ({(inc.participants || []).length})
        </p>
        {(inc.participants || []).length === 0
          ? <p className="text-[11px] text-text-muted">No participant events recorded.</p>
          : (
            <div className="overflow-x-auto">
              <table className="w-full text-[11px]">
                <thead><tr className="text-text-muted text-left">
                  <th className="py-1 pr-3 font-medium">Name / Number</th>
                  <th className="py-1 pr-3 font-medium">Role</th>
                  <th className="py-1 pr-3 font-medium">Joined</th>
                  <th className="py-1 pr-3 font-medium">Left</th>
                  <th className="py-1 font-medium">Rejoined</th>
                </tr></thead>
                <tbody>
                  {(inc.participants || []).map((p, i) => (
                    <tr key={i} className="border-t border-surface-border/50">
                      <td className="py-1.5 pr-3">
                        <span className="text-text-primary">{p.name}</span>
                        {p.number && p.number !== p.name && <span className="ml-1.5 font-mono text-text-muted">{p.number}</span>}
                      </td>
                      <td className="py-1.5 pr-3">
                        {p.role === 'initiator'
                          ? <Badge variant="danger">initiator</Badge>
                          : <span className="text-text-muted capitalize">{p.role || 'responder'}</span>}
                      </td>
                      <td className="py-1.5 pr-3 text-text-muted">{fmt(p.joined_at)}</td>
                      <td className="py-1.5 pr-3 text-text-muted">{fmt(p.left_at)}</td>
                      <td className="py-1.5 text-text-muted">{fmt(p.rejoined_at)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )
        }
      </div>
    </div>
  );
}

export default function ErsReport() {
  const [incidents, setIncidents] = useState([]);
  const [total, setTotal]         = useState(0);
  const [page, setPage]           = useState(1);
  const [loading, setLoading]     = useState(false);
  const [expanded, setExpanded]   = useState({});
  const [filters, setFilters]     = useState({ from: '', to: '', status: '' });
  const LIMIT = 50;

  const load = useCallback(async (pg = page) => {
    setLoading(true);
    try {
      const q = { page: pg, limit: LIMIT };
      if (filters.from)   q.from   = filters.from;
      if (filters.to)     q.to     = filters.to;
      if (filters.status) q.status = filters.status;
      const r = await api.reports.ers(q);
      setIncidents(r.incidents || []);
      setTotal(r.total ?? 0);
      setPage(pg);
      setExpanded({});
    } catch (e) {
      console.error(e);
    } finally {
      setLoading(false);
    }
  }, [filters, page]);

  useEffect(() => { load(1); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const toggle = uuid => setExpanded(e => ({ ...e, [uuid]: !e[uuid] }));

  const totalPages = Math.max(1, Math.ceil(total / LIMIT));

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between flex-wrap gap-2">
        <div>
          <h1 className="text-xl font-bold text-text-primary">ERS Reports</h1>
          <p className="text-xs text-text-muted mt-0.5">Emergency Response System incident history — click a row to expand details</p>
        </div>
        <div className="flex items-end gap-2 flex-wrap">
          <div><label className="label">From</label>
            <input type="date" className="input" value={filters.from}
              onChange={e => setFilters(f => ({ ...f, from: e.target.value }))} /></div>
          <div><label className="label">To</label>
            <input type="date" className="input" value={filters.to}
              onChange={e => setFilters(f => ({ ...f, to: e.target.value }))} /></div>
          <div><label className="label">Status</label>
            <select className="input" value={filters.status}
              onChange={e => setFilters(f => ({ ...f, status: e.target.value }))}>
              <option value="">All</option>
              <option value="ACTIVE">Active</option>
              <option value="COMPLETED">Completed</option>
              <option value="QUEUED">Queued</option>
              <option value="FAILED">Failed</option>
              <option value="CANCELLED">Cancelled</option>
            </select>
          </div>
          <button onClick={() => load(1)} disabled={loading} className="btn-primary flex items-center gap-1.5">
            <RefreshCw size={13} className={loading ? 'animate-spin' : ''} /> Search
          </button>
        </div>
      </div>

      {/* Summary stats */}
      <p className="text-xs text-text-muted">{total} incident{total !== 1 ? 's' : ''} found</p>

      <div className="space-y-2">
        {!loading && incidents.length === 0 && (
          <p className="text-sm text-text-muted text-center py-8">No incidents match the current filters.</p>
        )}
        {incidents.map(inc => (
          <div key={inc.incident_uuid} className="card p-0 overflow-hidden">
            <button
              className="w-full flex items-center gap-3 px-4 py-3 text-left hover:bg-surface-hover transition-colors"
              onClick={() => toggle(inc.incident_uuid)}
            >
              {expanded[inc.incident_uuid] ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
              <div className="flex-1 min-w-0">
                <p className="text-sm font-semibold text-text-primary">
                  {inc.ers_name}
                  {inc.group_type && <span className="ml-1.5 text-text-muted font-normal capitalize">({inc.group_type})</span>}
                </p>
                <p className="text-[11px] text-text-muted">
                  {inc.org_name} · Caller: {inc.caller_name || inc.caller_number || '—'} · {fmt(inc.started_at)} · {dur(inc.duration_seconds)}
                </p>
              </div>
              <div className="flex items-center gap-2 shrink-0">
                <span className="text-[11px] text-text-muted tabular-nums">{inc.answered_count}/{inc.responder_count} answered</span>
                <Badge variant={STATUS_VARIANT[inc.status] || 'default'}>{inc.status}</Badge>
              </div>
            </button>

            {expanded[inc.incident_uuid] && (
              <DetailPanel uuid={inc.incident_uuid} />
            )}
          </div>
        ))}
      </div>

      {/* Pagination */}
      {totalPages > 1 && (
        <div className="flex items-center justify-center gap-2 pt-2">
          <button className="btn-ghost text-xs px-2 py-1" disabled={page <= 1} onClick={() => load(page - 1)}>Prev</button>
          <span className="text-xs text-text-muted">Page {page} of {totalPages}</span>
          <button className="btn-ghost text-xs px-2 py-1" disabled={page >= totalPages} onClick={() => load(page + 1)}>Next</button>
        </div>
      )}
    </div>
  );
}
