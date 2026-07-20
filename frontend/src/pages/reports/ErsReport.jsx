import { useEffect, useState, useCallback, memo } from 'react';
import {
  RefreshCw, ChevronDown, ChevronRight,
  Mic, Phone, Users, Clock, Building2,
  Activity, Shield, MapPin, Calendar, Download,
  CheckCircle2, XCircle, AlertCircle, CircleDot,
  PhoneCall, FileAudio, BarChart3, Info,
  Siren, Radio, TimerReset, Hash,
} from 'lucide-react';
import { api } from '../../api/client.js';
import Badge from '../../components/ui/Badge.jsx';
import PageHeader from '../../components/ui/PageHeader.jsx';
import EmptyState from '../../components/ui/EmptyState.jsx';

// ─── Helpers ──────────────────────────────────────────────────────────────────

const fmt   = iso => iso ? new Date(iso).toLocaleString(undefined, { dateStyle: 'short', timeStyle: 'short' }) : '—';
const fmtLong = iso => iso ? new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'medium' }) : '—';
const dur   = s => {
  if (!s && s !== 0) return '—';
  if (s < 60)   return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m ${s % 60}s`;
  return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
};

const STATUS_CONF = {
  ACTIVE:    { label: 'Active',     dot: 'bg-red-500',    badge: 'badge-red',    icon: Activity },
  COMPLETED: { label: 'Completed',  dot: 'bg-green-500',  badge: 'badge-green',  icon: CheckCircle2 },
  QUEUED:    { label: 'Queued',     dot: 'bg-amber-500',  badge: 'badge-amber',  icon: Clock },
  CANCELLED: { label: 'Cancelled',  dot: 'bg-gray-400',   badge: 'badge-gray',   icon: XCircle },
  FAILED:    { label: 'Failed',     dot: 'bg-red-600',    badge: 'badge-red',    icon: AlertCircle },
};

const RESPONDER_CONF = {
  JOINED:    { label: 'Answered',  badge: 'badge-green',  icon: CheckCircle2 },
  REJOINED:  { label: 'Rejoined',  badge: 'badge-blue',   icon: RefreshCw },
  INVITED:   { label: 'Ringing',   badge: 'badge-amber',  icon: Phone },
  MISSED:    { label: 'Missed',    badge: 'badge-red',    icon: XCircle },
  OBSERVER:  { label: 'Observer',  badge: 'badge-gray',   icon: CircleDot },
};

function StatusDot({ status }) {
  const c = STATUS_CONF[status];
  if (!c) return null;
  return (
    <span className="relative flex items-center gap-1.5">
      <span className={`w-2 h-2 rounded-full shrink-0 ${c.dot} ${status === 'ACTIVE' ? 'animate-pulse' : ''}`} />
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

const DetailPanel = memo(function DetailPanel({ uuid, onClose }) {
  const [data, setData]       = useState(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr]         = useState(null);
  const [tab, setTab]         = useState('summary');

  useEffect(() => {
    setLoading(true); setErr(null); setTab('summary');
    api.reports.ersDetail(uuid)
      .then(r => setData(r.incident))
      .catch(e => setErr(e.message))
      .finally(() => setLoading(false));
  }, [uuid]);

  if (loading) return (
    <div className="px-4 pb-4 border-t border-surface-border pt-3 space-y-3">
      {[...Array(3)].map((_, i) => (
        <div key={i} className="skeleton h-12 w-full rounded-xl" />
      ))}
    </div>
  );

  if (err) return (
    <div className="px-4 pb-4 border-t border-surface-border pt-3">
      <div className="alert alert-danger">
        <AlertCircle size={16} className="shrink-0 mt-0.5" />
        <div><p className="font-semibold">Failed to load details</p><p className="text-xs mt-0.5">{err}</p></div>
      </div>
    </div>
  );

  if (!data) return null;

  const inc = data;
  const responders   = inc.responders   || [];
  const participants = inc.participants || [];
  const rec          = inc.recording;

  const answeredCount = responders.filter(r => r.status === 'JOINED' || r.status === 'REJOINED').length;
  const missedCount   = responders.filter(r => r.status === 'MISSED').length;
  const pendingCount  = responders.filter(r => r.status === 'INVITED').length;
  const answerRate    = responders.length > 0 ? Math.round((answeredCount / responders.length) * 100) : 0;

  const TABS = [
    { id: 'summary',      label: 'Summary',      icon: Info },
    { id: 'responders',   label: `Responders (${responders.length})`, icon: Users },
    { id: 'participants', label: `Participants (${participants.length})`, icon: PhoneCall },
    { id: 'recording',    label: 'Recording',    icon: FileAudio },
  ];

  return (
    <div className="border-t border-surface-border">
      {/* Tab bar */}
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

        {/* ── Summary tab ─────────────────────────────────────── */}
        {tab === 'summary' && (
          <div className="space-y-4">
            {/* Metrics row */}
            <div className="flex gap-3 flex-wrap">
              <MetricPill icon={Clock}       value={dur(inc.duration_seconds)} label="Duration" />
              <MetricPill icon={Users}       value={responders.length}         label="Responders" />
              <MetricPill icon={CheckCircle2} value={answeredCount}            label="Answered"
                color={answeredCount > 0 ? 'border-green-500/30 bg-green-500/5' : ''} />
              <MetricPill icon={XCircle}     value={missedCount}               label="Missed"
                color={missedCount > 0 ? 'border-red-500/30 bg-red-500/5' : ''} />
              <MetricPill icon={BarChart3}   value={`${answerRate}%`}          label="Answer Rate" />
              {inc.queued_at && inc.started_at && (
                <MetricPill icon={TimerReset}
                  value={dur(Math.round((new Date(inc.started_at) - new Date(inc.queued_at)) / 1000))}
                  label="Queue Time" />
              )}
            </div>

            {/* Answer rate bar */}
            {responders.length > 0 && (
              <div>
                <div className="flex items-center justify-between mb-1">
                  <span className="text-[11px] text-text-muted">Response rate</span>
                  <span className="text-[11px] font-semibold text-text-primary">{answeredCount}/{responders.length}</span>
                </div>
                <div className="progress-bar-track">
                  <div
                    className={`progress-bar-fill ${answerRate >= 75 ? 'bg-green-500' : answerRate >= 40 ? 'bg-amber-500' : 'bg-red-500'}`}
                    style={{ width: `${answerRate}%` }}
                  />
                </div>
              </div>
            )}

            {/* Incident details */}
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-8">
              {[
                { label: 'Incident UUID', value: <span className="font-mono text-xs">{inc.incident_uuid}</span> },
                { label: 'Conference Room', value: <span className="font-mono text-xs">{inc.conference_room || '—'}</span> },
                { label: 'Caller', value: `${inc.caller_name || ''} ${inc.caller_number || ''}`.trim() || '—' },
                { label: 'Group Type', value: <span className="capitalize">{inc.group_type || '—'}</span> },
                { label: 'Organization', value: inc.org_name || '—' },
                { label: 'Started', value: fmtLong(inc.started_at) },
                { label: 'Ended', value: fmtLong(inc.ended_at) },
                { label: 'Queue Time', value: inc.queued_at ? fmt(inc.queued_at) : '—' },
              ].map(({ label, value }) => (
                <div key={label} className="detail-row">
                  <span className="detail-label">{label}</span>
                  <span className="detail-value text-xs">{value}</span>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* ── Responders tab ───────────────────────────────────── */}
        {tab === 'responders' && (
          responders.length === 0 ? (
            <EmptyState icon={Users} title="No responders recorded" description="No responder records exist for this incident." />
          ) : (
            <div className="space-y-2">
              {responders.map((r, i) => {
                const rc = RESPONDER_CONF[r.status] || RESPONDER_CONF.INVITED;
                return (
                  <div key={i} className="flex items-start gap-3 p-3 rounded-xl bg-surface-raised
                                          border border-surface-border/60">
                    <div className={`w-8 h-8 rounded-lg flex items-center justify-center shrink-0
                                     ${r.status === 'JOINED' || r.status === 'REJOINED'
                                       ? 'bg-green-500/10 text-green-600 dark:text-green-400 border border-green-500/20'
                                       : r.status === 'MISSED'
                                         ? 'bg-red-500/10 text-red-600 dark:text-red-400 border border-red-500/20'
                                         : 'bg-surface-border text-text-muted border border-surface-border'}`}>
                      <rc.icon size={14} />
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="text-sm font-semibold text-text-primary">{r.name}</span>
                        <span className={`badge ${rc.badge}`}>{rc.label}</span>
                        {r.rejoin_count > 0 && (
                          <span className="badge badge-blue">{r.rejoin_count}× rejoin</span>
                        )}
                      </div>
                      <div className="flex items-center gap-3 mt-1 text-[11px] text-text-muted flex-wrap">
                        {r.number && <span className="font-mono">{r.number}</span>}
                        {r.contact_role && <span className="capitalize">{r.contact_role}</span>}
                        {r.joined_via && <span className="capitalize">via {r.joined_via}</span>}
                      </div>
                    </div>
                    <div className="text-right text-[11px] text-text-muted space-y-0.5 shrink-0">
                      {r.join_time  && <p><span className="text-text-muted/60">Joined </span>{fmt(r.join_time)}</p>}
                      {r.leave_time && <p><span className="text-text-muted/60">Left </span>{fmt(r.leave_time)}</p>}
                    </div>
                  </div>
                );
              })}
            </div>
          )
        )}

        {/* ── Participants tab ─────────────────────────────────── */}
        {tab === 'participants' && (
          participants.length === 0 ? (
            <EmptyState icon={PhoneCall} title="No participant events" description="No conference participant timeline was recorded for this incident." />
          ) : (
            <div className="overflow-x-auto">
              <table className="table-base">
                <thead>
                  <tr>
                    {['Participant', 'Role', 'Joined', 'Left', 'Rejoined'].map(h => (
                      <th key={h} className="table-head">{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {participants.map((p, i) => (
                    <tr key={i} className="table-row">
                      <td className="table-cell">
                        <span className="font-medium">{p.name}</span>
                        {p.number && p.number !== p.name && (
                          <span className="ml-2 font-mono text-xs text-text-muted">{p.number}</span>
                        )}
                      </td>
                      <td className="table-cell">
                        {p.role === 'initiator'
                          ? <span className="badge badge-red">Initiator</span>
                          : <span className="text-text-muted capitalize text-xs">{p.role || 'responder'}</span>}
                      </td>
                      <td className="table-cell-muted">{fmt(p.joined_at)}</td>
                      <td className="table-cell-muted">{fmt(p.left_at)}</td>
                      <td className="table-cell-muted">{fmt(p.rejoined_at)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )
        )}

        {/* ── Recording tab ────────────────────────────────────── */}
        {tab === 'recording' && (
          !rec && !inc.recording_path ? (
            <EmptyState icon={FileAudio} title="No recording" description="No conference recording was found for this incident." />
          ) : (
            <div className="space-y-3">
              {(rec || inc.recording_path) && (
                <div className="p-4 rounded-xl bg-surface-raised border border-surface-border">
                  <div className="flex items-start gap-3">
                    <div className="w-10 h-10 rounded-xl bg-red-500/10 border border-red-500/20
                                    flex items-center justify-center text-red-500 shrink-0">
                      <Mic size={18} />
                    </div>
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-semibold text-text-primary">Conference Recording</p>
                      {rec && (
                        <div className="flex flex-wrap gap-3 mt-2 text-xs text-text-muted">
                          {rec.duration_sec && <span className="metric-pill"><Clock size={11}/> {dur(rec.duration_sec)}</span>}
                          {rec.file_size_bytes && <span className="metric-pill">
                            {(rec.file_size_bytes / 1_048_576).toFixed(1)} MB
                          </span>}
                          {rec.status && <span className={`badge ${rec.status === 'COMPLETED' ? 'badge-green' : 'badge-amber'}`}>{rec.status}</span>}
                        </div>
                      )}
                      <p className="font-mono text-[11px] text-text-muted mt-2 break-all">
                        {rec?.recording_path || inc.recording_path}
                      </p>
                    </div>
                  </div>
                </div>
              )}
            </div>
          )
        )}
      </div>
    </div>
  );
});

// ─── Incident Row Card ────────────────────────────────────────────────────────

function IncidentCard({ inc, expanded, onToggle }) {
  const sc = STATUS_CONF[inc.status] || STATUS_CONF.COMPLETED;
  const hasRecording = !!(inc.recording_path);
  const answerPct = inc.responder_count > 0
    ? Math.round((inc.answered_count / inc.responder_count) * 100)
    : null;

  return (
    <div className={`card p-0 overflow-hidden transition-all duration-150
                     ${expanded ? 'border-brand/30 shadow-md' : 'hover:border-brand/20'}`}>
      {/* Status stripe */}
      <div className={`h-0.5 ${
        inc.status === 'ACTIVE'    ? 'bg-red-500' :
        inc.status === 'COMPLETED' ? 'bg-green-500' :
        inc.status === 'QUEUED'    ? 'bg-amber-500' :
        'bg-surface-border'
      }`} />

      <button
        className="w-full flex items-center gap-4 px-5 py-4 text-left
                   hover:bg-surface-hover transition-colors duration-100"
        onClick={onToggle}
        aria-expanded={expanded}
      >
        {/* Expand chevron */}
        <span className="text-text-muted shrink-0 transition-transform duration-150"
              style={{ transform: expanded ? 'rotate(90deg)' : 'rotate(0deg)' }}>
          <ChevronRight size={16} />
        </span>

        {/* ERS icon */}
        <div className="w-9 h-9 rounded-xl bg-brand/10 border border-brand/20
                        flex items-center justify-center shrink-0">
          <Siren size={16} className="text-brand" />
        </div>

        {/* Main info */}
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-sm font-bold text-text-primary">{inc.ers_name}</span>
            {inc.group_type && (
              <span className="badge badge-blue capitalize">{inc.group_type}</span>
            )}
          </div>
          <div className="flex items-center gap-3 mt-1 text-[11px] text-text-muted flex-wrap">
            {inc.org_name && (
              <span className="flex items-center gap-1">
                <Building2 size={10} />{inc.org_name}
              </span>
            )}
            {inc.caller_number && (
              <span className="flex items-center gap-1">
                <Phone size={10} />{inc.caller_name || inc.caller_number}
              </span>
            )}
            <span className="flex items-center gap-1">
              <Calendar size={10} />{fmt(inc.started_at)}
            </span>
            <span className="flex items-center gap-1">
              <Clock size={10} />{dur(inc.duration_seconds)}
            </span>
          </div>
        </div>

        {/* Right side — metrics + status */}
        <div className="flex items-center gap-4 shrink-0 flex-wrap justify-end">
          {/* Responder progress */}
          {inc.responder_count > 0 && (
            <div className="text-right hidden sm:block">
              <p className="text-xs font-semibold text-text-primary tabular-nums">
                {inc.answered_count}/{inc.responder_count}
              </p>
              <p className="text-[10px] text-text-muted">responded</p>
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

          {/* Recording indicator */}
          {hasRecording && (
            <span className="flex items-center gap-1 text-[11px] text-text-muted hidden md:flex">
              <Radio size={12} className="text-red-400" />
              Recorded
            </span>
          )}

          <StatusDot status={inc.status} />
        </div>
      </button>

      {expanded && <DetailPanel uuid={inc.incident_uuid} />}
    </div>
  );
}

// ─── Skeleton Loading ─────────────────────────────────────────────────────────

function IncidentSkeleton() {
  return (
    <div className="card p-0 overflow-hidden">
      <div className="h-0.5 skeleton" />
      <div className="flex items-center gap-4 px-5 py-4">
        <div className="skeleton w-4 h-4 rounded shrink-0" />
        <div className="skeleton w-9 h-9 rounded-xl shrink-0" />
        <div className="flex-1 space-y-2">
          <div className="skeleton h-4 w-48" />
          <div className="skeleton h-3 w-72" />
        </div>
        <div className="skeleton h-6 w-20 rounded-full" />
      </div>
    </div>
  );
}

// ─── Filter Bar ──────────────────────────────────────────────────────────────

function FilterBar({ filters, onChange, onSearch, loading }) {
  return (
    <div className="filter-bar">
      <div className="flex flex-wrap items-end gap-3 flex-1">
        <div>
          <label className="label">From</label>
          <input type="date" className="input-sm w-36"
            value={filters.from}
            onChange={e => onChange({ ...filters, from: e.target.value })} />
        </div>
        <div>
          <label className="label">To</label>
          <input type="date" className="input-sm w-36"
            value={filters.to}
            onChange={e => onChange({ ...filters, to: e.target.value })} />
        </div>
        <div>
          <label className="label">Status</label>
          <select className="input-sm w-36"
            value={filters.status}
            onChange={e => onChange({ ...filters, status: e.target.value })}>
            <option value="">All Statuses</option>
            <option value="ACTIVE">Active</option>
            <option value="COMPLETED">Completed</option>
            <option value="QUEUED">Queued</option>
            <option value="FAILED">Failed</option>
            <option value="CANCELLED">Cancelled</option>
          </select>
        </div>
      </div>
      <div className="flex items-center gap-2 shrink-0">
        <button
          onClick={() => onChange({ from: '', to: '', status: '' })}
          className="btn-ghost btn-sm text-xs"
        >
          Clear
        </button>
        <button onClick={onSearch} disabled={loading} className="btn-primary btn-sm">
          <RefreshCw size={12} className={loading ? 'animate-spin' : ''} />
          Search
        </button>
      </div>
    </div>
  );
}

// ─── Summary stat pills ───────────────────────────────────────────────────────

function SummaryStats({ incidents }) {
  const total     = incidents.length;
  const active    = incidents.filter(i => i.status === 'ACTIVE').length;
  const completed = incidents.filter(i => i.status === 'COMPLETED').length;
  const totalResp = incidents.reduce((s, i) => s + (i.responder_count || 0), 0);
  const answered  = incidents.reduce((s, i) => s + (i.answered_count  || 0), 0);

  if (total === 0) return null;

  return (
    <div className="flex items-center gap-3 flex-wrap text-xs">
      <span className="text-text-muted">{total} incident{total !== 1 ? 's' : ''}</span>
      {active > 0 && (
        <span className="badge badge-red">
          <span className="w-1.5 h-1.5 rounded-full bg-red-500 animate-pulse" />{active} active
        </span>
      )}
      {completed > 0 && <span className="badge badge-green">{completed} completed</span>}
      {totalResp > 0 && (
        <span className="text-text-muted">
          {answered}/{totalResp} responders answered
        </span>
      )}
    </div>
  );
}

// ─── Pagination ───────────────────────────────────────────────────────────────

function Pagination({ page, totalPages, onPage }) {
  if (totalPages <= 1) return null;
  const pages = [];
  const start = Math.max(1, page - 2);
  const end   = Math.min(totalPages, page + 2);
  for (let p = start; p <= end; p++) pages.push(p);

  return (
    <div className="flex items-center justify-center gap-1 pt-2">
      <button className="btn-ghost btn-sm" disabled={page <= 1} onClick={() => onPage(1)}>«</button>
      <button className="btn-ghost btn-sm" disabled={page <= 1} onClick={() => onPage(page - 1)}>‹</button>
      {pages.map(p => (
        <button key={p}
          className={`btn-sm rounded-lg font-semibold ${p === page ? 'btn-primary' : 'btn-ghost'}`}
          onClick={() => onPage(p)}>
          {p}
        </button>
      ))}
      <button className="btn-ghost btn-sm" disabled={page >= totalPages} onClick={() => onPage(page + 1)}>›</button>
      <button className="btn-ghost btn-sm" disabled={page >= totalPages} onClick={() => onPage(totalPages)}>»</button>
      <span className="text-xs text-text-muted ml-2">Page {page} of {totalPages}</span>
    </div>
  );
}

// ─── Main Page ────────────────────────────────────────────────────────────────

export default function ErsReport() {
  const [incidents, setIncidents] = useState([]);
  const [total,     setTotal]     = useState(0);
  const [page,      setPage]      = useState(1);
  const [loading,   setLoading]   = useState(true);
  const [expanded,  setExpanded]  = useState({});
  const [filters,   setFilters]   = useState({ from: '', to: '', status: '' });
  const LIMIT = 25;

  const load = useCallback(async (pg = 1) => {
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
      console.error('[ErsReport] load failed:', e);
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
        title="ERS Reports"
        description="Emergency Response System incident history with responder detail, timeline, and recording information."
        icon={Siren}
        badge={total > 0 ? { label: `${total} incidents`, variant: 'info' } : undefined}
      />

      <FilterBar
        filters={filters}
        onChange={setFilters}
        onSearch={() => load(1)}
        loading={loading}
      />

      <SummaryStats incidents={incidents} />

      <div className="space-y-2.5">
        {loading ? (
          [...Array(5)].map((_, i) => <IncidentSkeleton key={i} />)
        ) : incidents.length === 0 ? (
          <div className="card">
            <EmptyState
              icon={Siren}
              title="No incidents found"
              description="No ERS incidents match the current filters. Try adjusting the date range or status."
            />
          </div>
        ) : (
          incidents.map(inc => (
            <IncidentCard
              key={inc.incident_uuid}
              inc={inc}
              expanded={!!expanded[inc.incident_uuid]}
              onToggle={() => toggle(inc.incident_uuid)}
            />
          ))
        )}
      </div>

      <Pagination page={page} totalPages={totalPages} onPage={p => load(p)} />
    </div>
  );
}
