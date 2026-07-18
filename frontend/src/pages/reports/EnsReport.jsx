import { useEffect, useState, useCallback } from 'react';
import { RefreshCw, ChevronDown, ChevronRight, Mic } from 'lucide-react';
import { api } from '../../api/client.js';
import Badge from '../../components/ui/Badge.jsx';

const STATUS_VARIANT = { PENDING: 'warning', IN_PROGRESS: 'warning', COMPLETED: 'success', FAILED: 'danger', CANCELLED: 'default' };
const DELIVERY_VARIANT = { ANSWERED: 'success', REPLAYED: 'success', NO_ANSWER: 'warning', FAILED: 'danger', PENDING: 'default', DIALLING: 'warning', CANCELLED: 'default' };

const fmt = iso => iso ? new Date(iso).toLocaleString() : '—';

function DetailPanel({ uuid }) {
  const [data, setData]       = useState(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr]         = useState(null);

  useEffect(() => {
    setLoading(true); setErr(null);
    api.reports.ensDetail(uuid)
      .then(r => setData(r.notification))
      .catch(e => setErr(e.message))
      .finally(() => setLoading(false));
  }, [uuid]);

  if (loading) return <div className="text-xs text-text-muted p-4">Loading…</div>;
  if (err)     return <div className="text-xs text-red-500 p-4">{err}</div>;
  if (!data)   return null;

  const n = data;
  const answered   = (n.deliveries || []).filter(d => d.delivery_status === 'ANSWERED' || d.delivery_status === 'REPLAYED').length;
  const noAnswer   = (n.deliveries || []).filter(d => d.delivery_status === 'NO_ANSWER').length;
  const failed     = (n.deliveries || []).filter(d => d.delivery_status === 'FAILED').length;

  return (
    <div className="px-4 pb-4 border-t border-surface-border pt-3 space-y-4">
      {/* Key metadata */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3 text-[11px]">
        <div><p className="text-text-muted">Notification UUID</p><p className="font-mono text-text-primary truncate">{n.notification_uuid}</p></div>
        <div><p className="text-text-muted">Triggered Via</p><p className="text-text-primary capitalize">{n.triggered_via || '—'}</p></div>
        <div><p className="text-text-muted">Triggered By</p><p className="text-text-primary">{n.triggered_by_name || n.caller_number || '—'}</p></div>
        <div><p className="text-text-muted">Organization</p><p className="text-text-primary">{n.org_name || '—'}</p></div>
        <div><p className="text-text-muted">Started</p><p className="text-text-primary">{fmt(n.started_at)}</p></div>
        <div><p className="text-text-muted">Completed</p><p className="text-text-primary">{fmt(n.completed_at)}</p></div>
        <div><p className="text-text-muted">Targets</p><p className="text-text-primary">{n.total_targets ?? '—'}</p></div>
        <div><p className="text-text-muted">Answered / No-answer / Failed</p>
          <p className="text-text-primary">{answered} / {noAnswer} / {failed}</p></div>
      </div>

      {/* Recording */}
      {n.recording_file && (
        <div className="flex items-center gap-2 text-[11px] bg-surface-hover rounded p-2">
          <Mic size={12} className="text-text-muted shrink-0" />
          <span className="text-text-muted">Recording:</span>
          <span className="font-mono text-text-primary truncate">{n.recording_file}</span>
        </div>
      )}

      {/* Deliveries */}
      <div>
        <p className="text-[10px] font-medium text-text-muted uppercase tracking-wide mb-1.5">
          Deliveries ({(n.deliveries || []).length})
        </p>
        {(n.deliveries || []).length === 0
          ? <p className="text-[11px] text-text-muted">No delivery records.</p>
          : (
            <div className="overflow-x-auto">
              <table className="w-full text-[11px]">
                <thead><tr className="text-text-muted text-left">
                  <th className="py-1 pr-3 font-medium">Name</th>
                  <th className="py-1 pr-3 font-medium">Number</th>
                  <th className="py-1 pr-3 font-medium">Status</th>
                  <th className="py-1 pr-3 font-medium">Attempt</th>
                  <th className="py-1 pr-3 font-medium">Answered At</th>
                  <th className="py-1 font-medium">Hangup Cause</th>
                </tr></thead>
                <tbody>
                  {(n.deliveries || []).map((d, i) => (
                    <tr key={i} className="border-t border-surface-border/50">
                      <td className="py-1.5 pr-3 text-text-primary">{d.name || '—'}</td>
                      <td className="py-1.5 pr-3 font-mono text-text-muted">{d.contact_number}</td>
                      <td className="py-1.5 pr-3">
                        <Badge variant={DELIVERY_VARIANT[d.delivery_status] || 'default'}>{d.delivery_status}</Badge>
                      </td>
                      <td className="py-1.5 pr-3 text-text-muted tabular-nums">{d.attempt_number ?? '—'}</td>
                      <td className="py-1.5 pr-3 text-text-muted">{fmt(d.answered_at)}</td>
                      <td className="py-1.5 text-text-muted">{d.hangup_cause || '—'}</td>
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

export default function EnsReport() {
  const [notifications, setNotifications] = useState([]);
  const [total, setTotal]                 = useState(0);
  const [page, setPage]                   = useState(1);
  const [loading, setLoading]             = useState(false);
  const [expanded, setExpanded]           = useState({});
  const [filters, setFilters]             = useState({ from: '', to: '', status: '' });
  const LIMIT = 50;

  const load = useCallback(async (pg = page) => {
    setLoading(true);
    try {
      const q = { page: pg, limit: LIMIT };
      if (filters.from)   q.from   = filters.from;
      if (filters.to)     q.to     = filters.to;
      if (filters.status) q.status = filters.status;
      const r = await api.reports.ens(q);
      setNotifications(r.notifications || []);
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
          <h1 className="text-xl font-bold text-text-primary">ENS Reports</h1>
          <p className="text-xs text-text-muted mt-0.5">Emergency Notification System broadcast history — click a row to expand deliveries</p>
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
              <option value="PENDING">Pending</option>
              <option value="IN_PROGRESS">In Progress</option>
              <option value="COMPLETED">Completed</option>
              <option value="FAILED">Failed</option>
              <option value="CANCELLED">Cancelled</option>
            </select>
          </div>
          <button onClick={() => load(1)} disabled={loading} className="btn-primary flex items-center gap-1.5">
            <RefreshCw size={13} className={loading ? 'animate-spin' : ''} /> Search
          </button>
        </div>
      </div>

      <p className="text-xs text-text-muted">{total} broadcast{total !== 1 ? 's' : ''} found</p>

      <div className="space-y-2">
        {!loading && notifications.length === 0 && (
          <p className="text-sm text-text-muted text-center py-8">No broadcasts match the current filters.</p>
        )}
        {notifications.map(n => (
          <div key={n.notification_uuid} className="card p-0 overflow-hidden">
            <button
              className="w-full flex items-center gap-3 px-4 py-3 text-left hover:bg-surface-hover transition-colors"
              onClick={() => toggle(n.notification_uuid)}
            >
              {expanded[n.notification_uuid] ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
              <div className="flex-1 min-w-0">
                <p className="text-sm font-semibold text-text-primary">{n.ens_name}</p>
                <p className="text-[11px] text-text-muted">
                  {n.org_name} · Via: {n.triggered_via || '—'} · {fmt(n.created_at)}
                </p>
              </div>
              <div className="flex items-center gap-2 shrink-0">
                <span className="text-[11px] text-text-muted tabular-nums">
                  {n.total_answered ?? 0}/{n.total_targets ?? 0} answered
                </span>
                <Badge variant={STATUS_VARIANT[n.status] || 'default'}>{n.status}</Badge>
              </div>
            </button>

            {expanded[n.notification_uuid] && (
              <DetailPanel uuid={n.notification_uuid} />
            )}
          </div>
        ))}
      </div>

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
