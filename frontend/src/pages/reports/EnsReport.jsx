import { useEffect, useState, useCallback, memo } from 'react';
import {
  RefreshCw, ChevronRight, Phone, Users, Clock,
  Building2, Calendar, AlertCircle, CheckCircle2,
  XCircle, CircleDot, Mic, BarChart3, PhoneCall,
  Bell, FileAudio, UserCheck, Activity,
} from 'lucide-react';
import { api } from '../../api/client.js';
import Badge from '../../components/ui/Badge.jsx';
import PageHeader from '../../components/ui/PageHeader.jsx';
import EmptyState from '../../components/ui/EmptyState.jsx';

// ─── Helpers ──────────────────────────────────────────────────────────────────

const fmt     = iso => iso ? new Date(iso).toLocaleString(undefined, { dateStyle: 'short', timeStyle: 'short' }) : '—';
const fmtLong = iso => iso ? new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'medium' }) : '—';

const NOTIF_STATUS = {
  PENDING:    { label: 'Pending',     badge: 'badge-amber', dot: 'bg-amber-500',              icon: Clock },
  IN_PROGRESS:{ label: 'In Progress', badge: 'badge-blue',  dot: 'bg-blue-500 animate-pulse', icon: Activity },
  COMPLETED:  { label: 'Completed',   badge: 'badge-green', dot: 'bg-green-500',              icon: CheckCircle2 },
  FAILED:     { label: 'Failed',      badge: 'badge-red',   dot: 'bg-red-600',                icon: XCircle },
  CANCELLED:  { label: 'Cancelled',   badge: 'badge-gray',  dot: 'bg-gray-400',               icon: CircleDot },
};

const DELIVERY_CONF = {
  ANSWERED:  { badge: 'badge-green', icon: CheckCircle2 },
  NO_ANSWER: { badge: 'badge-amber', icon: Clock },
  BUSY:      { badge: 'badge-red',   icon: XCircle },
  FAILED:    { badge: 'badge-red',   icon: AlertCircle },
  PENDING:   { badge: 'badge-gray',  icon: CircleDot },
};

function StatusDot({ status }) {
  const c = NOTIF_STATUS[status];
  if (!c) return null;
  return (
    <span className="flex items-center gap-1.5">
      <span className={`w-2 h-2 rounded-full shrink-0 ${c.dot}`} />
      <span className={`badge ${c.badge}`}>{c.label}</span>
    </span>
  );
}

function MetricPill({ icon: Icon, value, label, color = '' }) {
  return (
    <div className={`flex flex-col items-center gap-0.5 px-3 py-2 rounded-xl
                     bg-surface-raised border border-surface-border min-w-0 ${color}`}>
      {Icon && <Icon size={13} className="text-text-muted shrink-0" />}
      <span className="text-sm font-bold text-text-primary tabular-nums leading-none">{value ?? '—'}</span>
      <span className="text-[10px] text-text-muted whitespace-nowrap">{label}</span>
    </div>
  );
}

// ─── Detail Panel ─────────────────────────────────────────────────────────────

const DetailPanel = memo(function DetailPanel({ uuid }) {
  const [data, setData]       = useState(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr]         = useState(null);
  const [tab, setTab]         = useState('summary');

  useEffect(() => {
    setLoading(true); setErr(null); setTab('summary');
    api.reports.ensDetail(uuid)
      .then(r => setData(r.notification))
      .catch(e => setErr(e.message))
      .finally(() => setLoading(false));
  }, [uuid]);

  if (loading) return (
    <div className="px-4 pb-4 border-t border-surface-border pt-3 space-y-3">
      {[...Array(3)].map((_, i) => <div key={i} className="skeleton h-12 w-full rounded-xl" />)}
    </div>
  );

  if (err) return (
    <div className="px-4 pb-4 border-t border-surface-border pt-3">
      <div className="alert alert-danger">
        <AlertCircle size={16} className="shrink-0 mt-0.5" />
        <div>
          <p className="font-semibold">Failed to load details</p>
          <p className="text-xs mt-0.5">{err}</p>
        </div>
      </div>
    </div>
  );

  if (!data) return null;

  const n          = data;
  const deliveries = n.deliveries || [];
  const answered   = deliveries.filter(d => d.delivery_status === 'ANSWERED').length;
  const noAnswer   = deliveries.filter(d => d.delivery_status === 'NO_ANSWER').length;
  const failed     = deliveries.filter(d => ['FAILED', 'BUSY'].includes(d.delivery_status)).length;
  const answerRate = deliveries.length > 0 ? Math.round((answered / deliveries.length) * 100) : 0;

  const TABS = [
    { id: 'summary',    label: 'Summary',                          icon: BarChart3 },
    { id: 'deliveries', label: `Deliveries (${deliveries.length})`, icon: PhoneCall },
    { id: 'recording',  label: 'Recording',                        icon: FileAudio },
  ];

  return (
    <div className="border-t border-surface-border">
      <div className="px-4 pt-3 flex items-center gap-1 overflow-x-auto">
        {TABS.map(t => (
          <button
            key={t.id}
            onClick={() => setTab(t.id)}
            className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold
                        whitespace-nowrap transition-colors
                        ${tab === t.id
                          ? 'bg-brand/10 text-brand'
                          : 'text-text-muted hover:text-text-primary hover:bg-surface-raised'}`}
          >
            <t.icon size={12} />
            {t.label}
          </button>
        ))}
      </div>

      <div className="px-4 pb-5 pt-3">

        {tab === 'summary' && (
          <div className="space-y-4">
            <div className="flex gap-3 flex-wrap">
              <MetricPill icon={Users}        value={n.total_targets}  label="Targets" />
              <MetricPill icon={CheckCircle2} value={answered}         label="Answered"
                color={answered > 0 ? 'border-green-500/30 bg-green-500/5' : ''} />
              <MetricPill icon={Clock}        value={noAnswer}         label="No Answer"
                color={noAnswer > 0 ? 'border-amber-500/30 bg-amber-500/5' : ''} />
              <MetricPill icon={XCircle}      value={failed}           label="Failed"
                color={failed > 0 ? 'border-red-500/30 bg-red-500/5' : ''} />
              <MetricPill icon={BarChart3}    value={`${answerRate}%`} label="Answer Rate" />
              {n.total_replayed > 0 && (
                <MetricPill icon={RefreshCw} value={n.total_replayed} label="Replayed" />
              )}
            </div>

            {deliveries.length > 0 && (
              <div>
                <div className="flex items-center justify-between mb-1">
                  <span className="text-[11px] text-text-muted">Delivery rate</span>
                  <span className="text-[11px] font-semibold text-text-primary">{answered}/{deliveries.length}</span>
                </div>
                <div className="progress-bar-track">
                  <div
                    className={`progress-bar-fill ${answerRate >= 75 ? 'bg-green-500' : answerRate >= 40 ? 'bg-amber-500' : 'bg-red-500'}`}
                    style={{ width: `${answerRate}%` }}
                  />
                </div>
              </div>
            )}

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-8">
              {[
                { label: 'Notification UUID', value: <span className="font-mono text-xs">{n.notification_uuid}</span> },
                { label: 'Triggered Via',     value: <span className="capitalize">{n.triggered_via || '—'}</span> },
                { label: 'Triggered By',      value: n.triggered_by_name || '—' },
                { label: 'Caller Number',     value: n.caller_number ? <span className="font-mono text-xs">{n.caller_number}</span> : '—' },
                { label: 'Organization',      value: n.org_name || '—' },
                { label: 'Created',           value: fmtLong(n.created_at) },
                { label: 'Started',           value: fmtLong(n.started_at) },
                { label: 'Completed',         value: fmtLong(n.completed_at) },
              ].map(({ label, value }) => (
                <div key={label} className="detail-row">
                  <span className="detail-label">{label}</span>
                  <span className="detail-value text-xs">{value}</span>
                </div>
              ))}
            </div>
          </div>
        )}

        {tab === 'deliveries' && (
          deliveries.length === 0 ? (
            <EmptyState icon={PhoneCall} title="No delivery records" description="No per-contact delivery records exist for this notification." />
          ) : (
            <div className="overflow-x-auto">
              <table className="table-base">
                <thead>
                  <tr>
                    {['Contact', 'Number', 'Status', 'Attempts', 'Answered At', 'Hangup'].map(h => (
                      <th key={h} className="table-head">{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {deliveries.map((d, i) => {
                    const dc = DELIVERY_CONF[d.delivery_status] || DELIVERY_CONF.PENDING;
                    return (
                      <tr key={i} className="table-row">
                        <td className="table-cell font-medium">{d.name || '—'}</td>
                        <td className="table-cell">
                          <span className="font-mono text-xs">{d.contact_number}</span>
                        </td>
                        <td className="table-cell">
                          <span className={`badge ${dc.badge}`}>
                            {(d.delivery_status || '').toLowerCase().replace('_', ' ') || '—'}
                          </span>
                        </td>
                        <td className="table-cell-muted tabular-nums">{d.attempt_number ?? '—'}</td>
                        <td className="table-cell-muted">{fmt(d.answered_at)}</td>
                        <td className="table-cell-muted">{d.hangup_cause || '—'}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )
        )}

        {tab === 'recording' && (
          !n.recording_file ? (
            <EmptyState icon={FileAudio} title="No recording" description="No broadcast recording was found for this notification." />
          ) : (
            <div className="p-4 rounded-xl bg-surface-raised border border-surface-border">
              <div className="flex items-start gap-3">
                <div className="w-10 h-10 rounded-xl bg-blue-500/10 border border-blue-500/20
                                flex items-center justify-center text-blue-500 shrink-0">
                  <Mic size={18} />
                </div>
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-semibold text-text-primary">Broadcast Recording</p>
                  <p className="font-mono text-[11px] text-text-muted mt-1 break-all">{n.recording_file}</p>
                </div>
              </div>
            </div>
          )
        )}
      </div>
    </div>
  );
});

// ─── Notification Row Card ────────────────────────────────────────────────────

function NotificationCard({ notif, expanded, onToggle }) {
  const answerPct = notif.total_targets > 0
    ? Math.round(((notif.total_answered || 0) / notif.total_targets) * 100)
    : null;

  return (
    <div className={`card p-0 overflow-hidden transition-all duration-150
                     ${expanded ? 'border-brand/30 shadow-md' : 'hover:border-brand/20'}`}>
      <div className={`h-0.5 ${
        notif.status === 'IN_PROGRESS' ? 'bg-blue-500' :
        notif.status === 'COMPLETED'   ? 'bg-green-500' :
        notif.status === 'PENDING'     ? 'bg-amber-500' :
        notif.status === 'FAILED'      ? 'bg-red-600' : 'bg-surface-border'
      }`} />

      <button
        className="w-full flex items-center gap-4 px-5 py-4 text-left
                   hover:bg-surface-hover transition-colors duration-100"
        onClick={onToggle}
        aria-expanded={expanded}
      >
        <span className="text-text-muted shrink-0 transition-transform duration-150"
              style={{ transform: expanded ? 'rotate(90deg)' : 'rotate(0deg)' }}>
          <ChevronRight size={16} />
        </span>

        <div className="w-9 h-9 rounded-xl bg-blue-500/10 border border-blue-500/20
                        flex items-center justify-center shrink-0">
          <Bell size={16} className="text-blue-500" />
        </div>

        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-sm font-bold text-text-primary">{notif.ens_name}</span>
            {notif.triggered_via && (
              <span className="badge badge-blue capitalize">{notif.triggered_via}</span>
            )}
          </div>
          <div className="flex items-center gap-3 mt-1 text-[11px] text-text-muted flex-wrap">
            {notif.org_name && (
              <span className="flex items-center gap-1"><Building2 size={10} />{notif.org_name}</span>
            )}
            {notif.triggered_by_name && (
              <span className="flex items-center gap-1"><UserCheck size={10} />{notif.triggered_by_name}</span>
            )}
            <span className="flex items-center gap-1">
              <Calendar size={10} />{fmt(notif.created_at)}
            </span>
          </div>
        </div>

        <div className="flex items-center gap-4 shrink-0 flex-wrap justify-end">
          {notif.total_targets > 0 && (
            <div className="text-right hidden sm:block">
              <p className="text-xs font-semibold text-text-primary tabular-nums">
                {notif.total_answered}/{notif.total_targets}
              </p>
              <p className="text-[10px] text-text-muted">answered</p>
              {answerPct !== null && (
                <div className="w-16 progress-bar-track mt-1">
                  <div
                    className={`progress-bar-fill ${answerPct >= 75 ? 'bg-green-500' : answerPct >= 40 ? 'bg-amber-500' : 'bg-red-500'}`}
                    style={{ width: `${answerPct}%` }}
                  />
                </div>
              )}
            </div>
          )}
          {notif.recording_file && (
            <span className="flex items-center gap-1 text-[11px] text-text-muted hidden md:flex">
              <Mic size={12} className="text-blue-400" />Recorded
            </span>
          )}
          <StatusDot status={notif.status} />
        </div>
      </button>

      {expanded && <DetailPanel uuid={notif.notification_uuid} />}
    </div>
  );
}

// ─── Skeleton ─────────────────────────────────────────────────────────────────

function NotificationSkeleton() {
  return (
    <div className="card p-0 overflow-hidden">
      <div className="h-0.5 skeleton" />
      <div className="flex items-center gap-4 px-5 py-4">
        <div className="skeleton w-4 h-4 rounded shrink-0" />
        <div className="skeleton w-9 h-9 rounded-xl shrink-0" />
        <div className="flex-1 space-y-2">
          <div className="skeleton h-4 w-48" />
          <div className="skeleton h-3 w-64" />
        </div>
        <div className="skeleton h-6 w-20 rounded-full" />
      </div>
    </div>
  );
}

// ─── Filter Bar ───────────────────────────────────────────────────────────────

function FilterBar({ filters, onChange, onSearch, loading }) {
  return (
    <div className="filter-bar">
      <div className="flex flex-wrap items-end gap-3 flex-1">
        <div>
          <label className="label">From</label>
          <input type="date" className="input-sm w-36" value={filters.from}
            onChange={e => onChange({ ...filters, from: e.target.value })} />
        </div>
        <div>
          <label className="label">To</label>
          <input type="date" className="input-sm w-36" value={filters.to}
            onChange={e => onChange({ ...filters, to: e.target.value })} />
        </div>
        <div>
          <label className="label">Status</label>
          <select className="input-sm w-40" value={filters.status}
            onChange={e => onChange({ ...filters, status: e.target.value })}>
            <option value="">All Statuses</option>
            <option value="PENDING">Pending</option>
            <option value="IN_PROGRESS">In Progress</option>
            <option value="COMPLETED">Completed</option>
            <option value="FAILED">Failed</option>
            <option value="CANCELLED">Cancelled</option>
          </select>
        </div>
      </div>
      <div className="flex items-center gap-2 shrink-0">
        <button onClick={() => onChange({ from: '', to: '', status: '' })} className="btn-ghost btn-sm text-xs">Clear</button>
        <button onClick={onSearch} disabled={loading} className="btn-primary btn-sm">
          <RefreshCw size={12} className={loading ? 'animate-spin' : ''} />
          Search
        </button>
      </div>
    </div>
  );
}

// ─── Summary stats ────────────────────────────────────────────────────────────

function SummaryStats({ notifications }) {
  const total     = notifications.length;
  const active    = notifications.filter(n => n.status === 'IN_PROGRESS').length;
  const completed = notifications.filter(n => n.status === 'COMPLETED').length;
  const totalT    = notifications.reduce((s, n) => s + (n.total_targets  || 0), 0);
  const totalA    = notifications.reduce((s, n) => s + (n.total_answered || 0), 0);

  if (total === 0) return null;

  return (
    <div className="flex items-center gap-3 flex-wrap text-xs">
      <span className="text-text-muted">{total} broadcast{total !== 1 ? 's' : ''}</span>
      {active > 0 && (
        <span className="badge badge-blue">
          <span className="w-1.5 h-1.5 rounded-full bg-blue-500 animate-pulse" />{active} in progress
        </span>
      )}
      {completed > 0 && <span className="badge badge-green">{completed} completed</span>}
      {totalT > 0 && <span className="text-text-muted">{totalA}/{totalT} contacts answered</span>}
    </div>
  );
}

// ─── Pagination ───────────────────────────────────────────────────────────────

function Pagination({ page, totalPages, onPage }) {
  if (totalPages <= 1) return null;
  const pages = [];
  for (let p = Math.max(1, page - 2); p <= Math.min(totalPages, page + 2); p++) pages.push(p);

  return (
    <div className="flex items-center justify-center gap-1 pt-2">
      <button className="btn-ghost btn-sm" disabled={page <= 1} onClick={() => onPage(1)}>«</button>
      <button className="btn-ghost btn-sm" disabled={page <= 1} onClick={() => onPage(page - 1)}>‹</button>
      {pages.map(p => (
        <button key={p} onClick={() => onPage(p)}
          className={`btn-sm rounded-lg font-semibold ${p === page ? 'btn-primary' : 'btn-ghost'}`}>{p}</button>
      ))}
      <button className="btn-ghost btn-sm" disabled={page >= totalPages} onClick={() => onPage(page + 1)}>›</button>
      <button className="btn-ghost btn-sm" disabled={page >= totalPages} onClick={() => onPage(totalPages)}>»</button>
      <span className="text-xs text-text-muted ml-2">Page {page} of {totalPages}</span>
    </div>
  );
}

// ─── Main Page ────────────────────────────────────────────────────────────────

export default function EnsReport() {
  const [notifications, setNotifications] = useState([]);
  const [total,         setTotal]         = useState(0);
  const [page,          setPage]          = useState(1);
  const [loading,       setLoading]       = useState(true);
  const [expanded,      setExpanded]      = useState({});
  const [filters,       setFilters]       = useState({ from: '', to: '', status: '' });
  const LIMIT = 25;

  const load = useCallback(async (pg = 1) => {
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
      console.error('[EnsReport] load failed:', e);
    } finally {
      setLoading(false);
    }
  }, [filters]);

  useEffect(() => { load(1); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const toggle = uuid => setExpanded(e => ({ ...e, [uuid]: !e[uuid] }));
  const totalPages = Math.max(1, Math.ceil(total / LIMIT));

  return (
    <div className="space-y-5">
      <PageHeader
        title="ENS Reports"
        description="Emergency Notification System broadcast history with per-contact delivery tracking and recording access."
        icon={Bell}
        badge={total > 0 ? { label: `${total} broadcasts`, variant: 'info' } : undefined}
      />

      <FilterBar filters={filters} onChange={setFilters} onSearch={() => load(1)} loading={loading} />

      <SummaryStats notifications={notifications} />

      <div className="space-y-2.5">
        {loading ? (
          [...Array(5)].map((_, i) => <NotificationSkeleton key={i} />)
        ) : notifications.length === 0 ? (
          <div className="card">
            <EmptyState
              icon={Bell}
              title="No broadcasts found"
              description="No ENS broadcasts match the current filters. Try adjusting the date range or status."
            />
          </div>
        ) : (
          notifications.map(n => (
            <NotificationCard
              key={n.notification_uuid}
              notif={n}
              expanded={!!expanded[n.notification_uuid]}
              onToggle={() => toggle(n.notification_uuid)}
            />
          ))
        )}
      </div>

      <Pagination page={page} totalPages={totalPages} onPage={p => load(p)} />
    </div>
  );
}
