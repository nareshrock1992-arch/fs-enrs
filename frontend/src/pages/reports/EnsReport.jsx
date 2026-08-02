import { useEffect, useState, useCallback, memo } from 'react';
import {
  RefreshCw, ChevronRight, Phone, Users, Clock,
  Building2, Calendar, AlertCircle, CheckCircle2,
  XCircle, CircleDot, Mic, BarChart3, PhoneCall,
  Bell, FileAudio, UserCheck, Activity, MessageSquare,
} from 'lucide-react';
import { api } from '../../api/client.js';
import Badge from '../../components/ui/Badge.jsx';
import PageHeader from '../../components/ui/PageHeader.jsx';
import EmptyState from '../../components/ui/EmptyState.jsx';

// ─── Helpers ──────────────────────────────────────────────────────────────────

const fmt     = iso => iso ? new Date(iso).toLocaleString(undefined, { dateStyle: 'short', timeStyle: 'short' }) : '—';
const fmtLong = iso => iso ? new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'medium' }) : '—';
const dur     = sec => sec == null ? '—' : `${Math.floor(sec / 60)}m ${sec % 60}s`;

const CAMPAIGN_STATUS = {
  Pending:     { label: 'Pending',     badge: 'badge-amber', dot: 'bg-amber-500',              icon: Clock },
  Running:     { label: 'Running',     badge: 'badge-blue',  dot: 'bg-blue-500 animate-pulse', icon: Activity },
  Completed:   { label: 'Completed',   badge: 'badge-green', dot: 'bg-green-500',              icon: CheckCircle2 },
  Failed:      { label: 'Failed',      badge: 'badge-red',   dot: 'bg-red-600',                icon: XCircle },
  Cancelled:   { label: 'Cancelled',   badge: 'badge-gray',  dot: 'bg-gray-400',               icon: CircleDot },
};

const DEST_STATUS = {
  Pending:   { badge: 'badge-gray',  icon: CircleDot },
  Dialing:   { badge: 'badge-blue',  icon: PhoneCall },
  Answered:  { badge: 'badge-green', icon: CheckCircle2 },
  Failed:    { badge: 'badge-red',   icon: XCircle },
  Retrying:  { badge: 'badge-amber', icon: RefreshCw },
  Completed: { badge: 'badge-green', icon: CheckCircle2 },
};

function StatusDot({ status }) {
  const c = CAMPAIGN_STATUS[status] || CAMPAIGN_STATUS.Pending;
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

const DetailPanel = memo(function DetailPanel({ campaignId }) {
  const [data, setData]       = useState(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr]         = useState(null);
  const [tab, setTab]         = useState('summary');

  useEffect(() => {
    setLoading(true); setErr(null); setTab('summary');
    api.reports.ensCampaignDetail(campaignId)
      .then(r => setData(r.campaign))
      .catch(e => setErr(e.message))
      .finally(() => setLoading(false));
  }, [campaignId]);

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

  const c    = data;
  const dsts = c.destinations || [];
  const answered  = dsts.filter(d => ['Answered', 'Completed'].includes(d.status)).length;
  const failed    = dsts.filter(d => d.status === 'Failed').length;
  const retried   = dsts.filter(d => d.attempt_count > 1).length;
  const answerPct = dsts.length > 0 ? Math.round((answered / dsts.length) * 100) : 0;

  const TABS = [
    { id: 'summary',  label: 'Summary',                     icon: BarChart3 },
    { id: 'contacts', label: `Contacts (${dsts.length})`,   icon: PhoneCall },
    { id: 'content',  label: 'Content',                     icon: FileAudio },
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
              <MetricPill icon={Users}        value={c.total_destinations} label="Targets" />
              <MetricPill icon={CheckCircle2} value={answered}             label="Answered"
                color={answered > 0 ? 'border-green-500/30 bg-green-500/5' : ''} />
              <MetricPill icon={XCircle}      value={failed}               label="Failed"
                color={failed > 0 ? 'border-red-500/30 bg-red-500/5' : ''} />
              <MetricPill icon={RefreshCw}    value={retried}              label="Retried"
                color={retried > 0 ? 'border-amber-500/30 bg-amber-500/5' : ''} />
              <MetricPill icon={BarChart3}    value={`${answerPct}%`}      label="Answer Rate" />
              {c.campaign_duration_sec != null && (
                <MetricPill icon={Clock} value={dur(c.campaign_duration_sec)} label="Duration" />
              )}
            </div>

            {dsts.length > 0 && (
              <div>
                <div className="flex items-center justify-between mb-1">
                  <span className="text-[11px] text-text-muted">Delivery rate</span>
                  <span className="text-[11px] font-semibold text-text-primary">{answered}/{dsts.length}</span>
                </div>
                <div className="progress-bar-track">
                  <div
                    className={`progress-bar-fill ${answerPct >= 75 ? 'bg-green-500' : answerPct >= 40 ? 'bg-amber-500' : 'bg-red-500'}`}
                    style={{ width: `${answerPct}%` }}
                  />
                </div>
              </div>
            )}

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-8">
              {[
                { label: 'Campaign ID',    value: <span className="font-mono text-xs">{c.id}</span> },
                { label: 'Triggered Via',  value: <span className="capitalize">{c.triggered_via || '—'}</span> },
                { label: 'Triggered By',   value: c.triggered_by_name || '—' },
                { label: 'Trigger Number', value: c.trigger_number ? <span className="font-mono text-xs">{c.trigger_number}</span> : '—' },
                { label: 'Organization',   value: c.org_name || '—' },
                { label: 'Created',        value: fmtLong(c.created_at) },
                { label: 'Started',        value: fmtLong(c.started_at) },
                { label: 'Completed',      value: fmtLong(c.completed_at) },
              ].map(({ label, value }) => (
                <div key={label} className="detail-row">
                  <span className="detail-label">{label}</span>
                  <span className="detail-value text-xs">{value}</span>
                </div>
              ))}
            </div>
          </div>
        )}

        {tab === 'contacts' && (
          dsts.length === 0 ? (
            <EmptyState icon={PhoneCall} title="No destination records" description="No per-contact destination records exist for this campaign." />
          ) : (
            <div className="overflow-x-auto">
              <table className="table-base">
                <thead>
                  <tr>
                    {['Contact', 'Extension', 'Mobile', 'Routing', 'Gateway', 'Status', 'Attempts', 'Hangup', 'Answered At', 'Call UUID'].map(h => (
                      <th key={h} className="table-head">{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {dsts.map((d, i) => {
                    const dc = DEST_STATUS[d.status] || DEST_STATUS.Pending;
                    return (
                      <tr key={i} className="table-row">
                        <td className="table-cell font-medium">{d.contact_name || '—'}</td>
                        <td className="table-cell font-mono text-xs">{d.extension_number || '—'}</td>
                        <td className="table-cell font-mono text-xs">{d.mobile_number || d.phone_number || '—'}</td>
                        <td className="table-cell-muted capitalize">{d.routing_mode || '—'}</td>
                        <td className="table-cell-muted">{d.gateway || '—'}</td>
                        <td className="table-cell">
                          <span className={`badge ${dc.badge}`}>{d.status || '—'}</span>
                        </td>
                        <td className="table-cell-muted tabular-nums">{d.attempt_count ?? '—'}/{d.max_attempts ?? '—'}</td>
                        <td className="table-cell-muted">{d.hangup_cause || d.error_message || '—'}</td>
                        <td className="table-cell-muted">{fmt(d.answered_at)}</td>
                        <td className="table-cell">
                          {d.call_uuid
                            ? <span className="font-mono text-[10px] text-text-muted">{d.call_uuid.slice(0, 8)}…</span>
                            : '—'}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )
        )}

        {tab === 'content' && (
          <div className="space-y-3">
            {c.recording_file && (
              <div className="p-4 rounded-xl bg-surface-raised border border-surface-border">
                <div className="flex items-start gap-3">
                  <div className="w-10 h-10 rounded-xl bg-blue-500/10 border border-blue-500/20
                                  flex items-center justify-center text-blue-500 shrink-0">
                    <Mic size={18} />
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-semibold text-text-primary">Broadcast Recording</p>
                    <p className="font-mono text-[11px] text-text-muted mt-1 break-all">{c.recording_file}</p>
                  </div>
                </div>
              </div>
            )}
            {c.message_text && (
              <div className="p-4 rounded-xl bg-surface-raised border border-surface-border">
                <div className="flex items-start gap-3">
                  <div className="w-10 h-10 rounded-xl bg-purple-500/10 border border-purple-500/20
                                  flex items-center justify-center text-purple-500 shrink-0">
                    <MessageSquare size={18} />
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-semibold text-text-primary">TTS Message</p>
                    <p className="text-[12px] text-text-muted mt-1">{c.message_text}</p>
                  </div>
                </div>
              </div>
            )}
            {!c.recording_file && !c.message_text && (
              <EmptyState icon={FileAudio} title="No content" description="No recording or message text was stored for this campaign." />
            )}
          </div>
        )}
      </div>
    </div>
  );
});

// ─── Campaign Row Card ────────────────────────────────────────────────────────

function CampaignCard({ campaign, expanded, onToggle }) {
  const answerPct = campaign.total_destinations > 0
    ? Math.round(((campaign.answered_count || 0) / campaign.total_destinations) * 100)
    : null;

  return (
    <div className={`card p-0 overflow-hidden transition-all duration-150
                     ${expanded ? 'border-brand/30 shadow-md' : 'hover:border-brand/20'}`}>
      <div className={`h-0.5 ${
        campaign.status === 'Running'   ? 'bg-blue-500' :
        campaign.status === 'Completed' ? 'bg-green-500' :
        campaign.status === 'Pending'   ? 'bg-amber-500' :
        campaign.status === 'Failed'    ? 'bg-red-600' : 'bg-surface-border'
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
            <span className="text-sm font-bold text-text-primary">{campaign.ens_name}</span>
            {campaign.triggered_via && (
              <span className="badge badge-blue capitalize">{campaign.triggered_via}</span>
            )}
          </div>
          <div className="flex items-center gap-3 mt-1 text-[11px] text-text-muted flex-wrap">
            {campaign.org_name && (
              <span className="flex items-center gap-1"><Building2 size={10} />{campaign.org_name}</span>
            )}
            {campaign.triggered_by_name && (
              <span className="flex items-center gap-1"><UserCheck size={10} />{campaign.triggered_by_name}</span>
            )}
            <span className="flex items-center gap-1">
              <Calendar size={10} />{fmt(campaign.created_at)}
            </span>
          </div>
        </div>

        <div className="flex items-center gap-4 shrink-0 flex-wrap justify-end">
          {campaign.total_destinations > 0 && (
            <div className="text-right hidden sm:block">
              <p className="text-xs font-semibold text-text-primary tabular-nums">
                {campaign.answered_count}/{campaign.total_destinations}
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
          {campaign.recording_file && (
            <span className="flex items-center gap-1 text-[11px] text-text-muted hidden md:flex">
              <Mic size={12} className="text-blue-400" />Recorded
            </span>
          )}
          {campaign.message_text && !campaign.recording_file && (
            <span className="flex items-center gap-1 text-[11px] text-text-muted hidden md:flex">
              <MessageSquare size={12} className="text-purple-400" />TTS
            </span>
          )}
          <StatusDot status={campaign.status} />
        </div>
      </button>

      {expanded && <DetailPanel campaignId={campaign.id} />}
    </div>
  );
}

// ─── Skeleton ─────────────────────────────────────────────────────────────────

function CampaignSkeleton() {
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
            <option value="Pending">Pending</option>
            <option value="Running">Running</option>
            <option value="Completed">Completed</option>
            <option value="Failed">Failed</option>
            <option value="Cancelled">Cancelled</option>
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

function SummaryStats({ campaigns }) {
  const total     = campaigns.length;
  const active    = campaigns.filter(c => c.status === 'Running').length;
  const completed = campaigns.filter(c => c.status === 'Completed').length;
  const totalT    = campaigns.reduce((s, c) => s + (c.total_destinations || 0), 0);
  const totalA    = campaigns.reduce((s, c) => s + (c.answered_count     || 0), 0);

  if (total === 0) return null;

  return (
    <div className="flex items-center gap-3 flex-wrap text-xs">
      <span className="text-text-muted">{total} campaign{total !== 1 ? 's' : ''}</span>
      {active > 0 && (
        <span className="badge badge-blue">
          <span className="w-1.5 h-1.5 rounded-full bg-blue-500 animate-pulse" />{active} running
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
  const [campaigns, setCampaigns] = useState([]);
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
      const r = await api.reports.ensCampaigns(q);
      setCampaigns(r.campaigns || []);
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

  const toggle = id => setExpanded(e => ({ ...e, [id]: !e[id] }));
  const totalPages = Math.max(1, Math.ceil(total / LIMIT));

  return (
    <div className="space-y-6">
      <PageHeader
        title="ENS Reports"
        description="Emergency Notification System campaign history with per-contact delivery tracking."
        icon={Bell}
        badge={total > 0 ? { label: `${total} campaigns`, variant: 'info' } : undefined}
      />

      <FilterBar filters={filters} onChange={setFilters} onSearch={() => load(1)} loading={loading} />

      <SummaryStats campaigns={campaigns} />

      <div className="space-y-2.5">
        {loading ? (
          [...Array(5)].map((_, i) => <CampaignSkeleton key={i} />)
        ) : campaigns.length === 0 ? (
          <div className="card">
            <EmptyState
              icon={Bell}
              title="No campaigns found"
              description="No ENS campaigns match the current filters. Try adjusting the date range or status."
            />
          </div>
        ) : (
          campaigns.map(c => (
            <CampaignCard
              key={c.id}
              campaign={c}
              expanded={!!expanded[c.id]}
              onToggle={() => toggle(c.id)}
            />
          ))
        )}
      </div>

      <Pagination page={page} totalPages={totalPages} onPage={p => load(p)} />
    </div>
  );
}
