import { useEffect, useState, useCallback, useRef } from 'react';
import {
  Bell, Pause, Play, XCircle, RefreshCw, ChevronDown, ChevronRight,
  CheckCircle, AlertCircle, Phone, Clock, BarChart2, Users,
  Activity, PhoneOff, PhoneMissed, SkipForward
} from 'lucide-react';
import { api } from '../../api/client.js';

// ── Status helpers ────────────────────────────────────────────────────────────

const STATUS_META = {
  queued:    { label: 'Queued',    cls: 'bg-blue-500/10 text-blue-400 border-blue-500/20' },
  running:   { label: 'Running',   cls: 'bg-green-500/10 text-green-400 border-green-500/20' },
  paused:    { label: 'Paused',    cls: 'bg-yellow-500/10 text-yellow-400 border-yellow-500/20' },
  completed: { label: 'Completed', cls: 'bg-surface-raised text-text-secondary border-surface-border' },
  cancelled: { label: 'Cancelled', cls: 'bg-surface-raised text-text-muted border-surface-border' },
  failed:    { label: 'Failed',    cls: 'bg-red-500/10 text-red-400 border-red-500/20' },
};

const DEST_STATUS_META = {
  queued:    { icon: Clock,        cls: 'text-blue-400',   label: 'Queued'     },
  dialing:   { icon: Phone,        cls: 'text-yellow-400', label: 'Dialing'    },
  answered:  { icon: Phone,        cls: 'text-green-300',  label: 'Answered'   },
  busy:      { icon: PhoneOff,     cls: 'text-orange-400', label: 'Busy'       },
  no_answer: { icon: PhoneMissed,  cls: 'text-yellow-500', label: 'No Answer'  },
  failed:    { icon: AlertCircle,  cls: 'text-red-400',    label: 'Failed'     },
  completed: { icon: CheckCircle,  cls: 'text-green-400',  label: 'Completed'  },
  expired:   { icon: Clock,        cls: 'text-text-muted', label: 'Expired'    },
  skipped:   { icon: SkipForward,  cls: 'text-text-muted', label: 'Skipped'   },
};

function StatusBadge({ status }) {
  const m = STATUS_META[status] || STATUS_META.queued;
  return (
    <span className={`inline-flex items-center px-2 py-0.5 rounded border text-[11px] font-semibold ${m.cls}`}>
      {m.label}
    </span>
  );
}

function pct(num, total) {
  if (!total) return 0;
  return Math.round((num / total) * 100);
}

// ── Progress Bar ──────────────────────────────────────────────────────────────

function CampaignProgress({ c }) {
  const done     = (c.completed_count || 0) + (c.failed_count || 0) + (c.expired_count || 0) + (c.skipped_count || 0);
  const answered = c.answered_count || 0;
  const total    = c.total_destinations || 1;
  const donePct  = pct(done, total);
  const dialPct  = pct(c.dialing_count || 0, total);

  return (
    <div className="space-y-1.5">
      <div className="flex justify-between text-[11px] text-text-muted">
        <span>{done} / {total} processed</span>
        <span>{donePct}%</span>
      </div>
      <div className="h-2 bg-surface-raised rounded-full overflow-hidden flex">
        <div className="bg-green-500 transition-all duration-500" style={{ width: `${pct(answered, total)}%` }} />
        <div className="bg-yellow-400 transition-all duration-500" style={{ width: `${dialPct}%` }} />
        <div className="bg-red-500/60 transition-all duration-500" style={{ width: `${pct(c.failed_count || 0, total)}%` }} />
      </div>
      <div className="flex gap-3 text-[10px]">
        <span className="text-green-400">■ Answered: {answered}</span>
        <span className="text-yellow-400">■ Dialing: {c.dialing_count || 0}</span>
        <span className="text-blue-400">■ Queued: {c.queued_count || 0}</span>
        <span className="text-red-400">■ Failed: {c.failed_count || 0}</span>
      </div>
    </div>
  );
}

// ── Stats Grid ────────────────────────────────────────────────────────────────

function StatBox({ label, value, sub, icon: Icon, warn }) {
  return (
    <div className="bg-surface-raised rounded-lg p-3 border border-surface-border">
      <div className="flex items-start justify-between">
        <div>
          <p className="text-[10px] text-text-muted uppercase tracking-wide mb-1">{label}</p>
          <p className={`text-xl font-bold font-mono ${warn && value > 0 ? 'text-red-400' : 'text-text-primary'}`}>
            {value ?? '—'}
          </p>
          {sub && <p className="text-[10px] text-text-muted mt-0.5">{sub}</p>}
        </div>
        {Icon && <Icon size={14} className="text-text-muted mt-0.5" />}
      </div>
    </div>
  );
}

// ── Destination Row ───────────────────────────────────────────────────────────

function DestRow({ d }) {
  const m = DEST_STATUS_META[d.status] || DEST_STATUS_META.queued;
  const Icon = m.icon;
  return (
    <tr className="border-b border-surface-border/40 hover:bg-surface-raised/40">
      <td className="py-2 px-3 text-xs font-mono text-text-primary">{d.phone_number}</td>
      <td className="py-2 px-3 text-xs text-text-secondary truncate max-w-[140px]">{d.contact_name || '—'}</td>
      <td className="py-2 px-3">
        <div className={`flex items-center gap-1.5 text-xs ${m.cls}`}>
          <Icon size={11} />
          <span>{m.label}</span>
        </div>
      </td>
      <td className="py-2 px-3 text-xs text-text-muted">{d.attempt_count}/{d.max_attempts}</td>
      <td className="py-2 px-3 text-xs font-mono text-text-muted">
        {d.hangup_cause || '—'}
      </td>
      <td className="py-2 px-3 text-xs text-text-muted">
        {d.completed_at ? new Date(d.completed_at).toLocaleTimeString() : '—'}
      </td>
    </tr>
  );
}

// ── Destination Panel ─────────────────────────────────────────────────────────

function DestinationPanel({ campaignId }) {
  const [dests, setDests] = useState([]);
  const [loading, setLoading] = useState(true);
  const [statusFilter, setStatusFilter] = useState('');
  const [page, setPage] = useState(1);
  const [total, setTotal] = useState(0);
  const limit = 50;

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const data = await api.campaigns.destinations(campaignId, {
        status: statusFilter || undefined,
        page,
        limit,
      });
      setDests(data.destinations || []);
      setTotal(data.total || 0);
    } catch {}
    setLoading(false);
  }, [campaignId, statusFilter, page]);

  useEffect(() => { load(); }, [load]);

  const statuses = ['', 'queued', 'dialing', 'answered', 'completed', 'busy', 'no_answer', 'failed', 'expired', 'skipped'];

  return (
    <div className="mt-4 border-t border-surface-border pt-4">
      <div className="flex items-center justify-between mb-3">
        <span className="text-xs font-semibold text-text-secondary uppercase tracking-wide">
          Destinations ({total})
        </span>
        <div className="flex items-center gap-2">
          <select
            value={statusFilter}
            onChange={e => { setStatusFilter(e.target.value); setPage(1); }}
            className="input-field text-xs py-1 px-2 pr-6"
          >
            {statuses.map(s => (
              <option key={s} value={s}>{s || 'All statuses'}</option>
            ))}
          </select>
          <button onClick={load} className="btn-ghost py-1 px-2">
            <RefreshCw size={12} className={loading ? 'animate-spin' : ''} />
          </button>
        </div>
      </div>

      <div className="overflow-x-auto rounded-lg border border-surface-border">
        <table className="w-full min-w-[600px]">
          <thead>
            <tr className="border-b border-surface-border bg-surface-raised">
              {['Phone', 'Name', 'Status', 'Attempts', 'Cause', 'Done At'].map(h => (
                <th key={h} className="py-2 px-3 text-left text-[10px] font-semibold text-text-muted uppercase tracking-wide">
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {loading
              ? <tr><td colSpan={6} className="py-8 text-center text-xs text-text-muted">Loading…</td></tr>
              : dests.length === 0
                ? <tr><td colSpan={6} className="py-8 text-center text-xs text-text-muted">No destinations</td></tr>
                : dests.map(d => <DestRow key={d.id} d={d} />)
            }
          </tbody>
        </table>
      </div>

      {total > limit && (
        <div className="flex items-center justify-between mt-2">
          <span className="text-xs text-text-muted">{total} total</span>
          <div className="flex gap-1">
            <button disabled={page === 1} onClick={() => setPage(p => p - 1)} className="btn-ghost py-1 px-2 text-xs">Prev</button>
            <span className="text-xs text-text-muted py-1 px-2">Page {page}</span>
            <button disabled={page * limit >= total} onClick={() => setPage(p => p + 1)} className="btn-ghost py-1 px-2 text-xs">Next</button>
          </div>
        </div>
      )}
    </div>
  );
}

// ── Campaign Row ──────────────────────────────────────────────────────────────

function CampaignRow({ c, onAction, onRefresh }) {
  const [expanded, setExpanded] = useState(false);
  const [acting, setActing] = useState(false);

  async function act(fn) {
    setActing(true);
    try { await fn(); onRefresh(); }
    catch (e) { alert(e.message); }
    finally { setActing(false); }
  }

  const isActive   = c.status === 'running' || c.status === 'queued';
  const isPaused   = c.status === 'paused';
  const canControl = isActive || isPaused;
  const durSec     = c.campaign_duration_sec;
  const durStr     = durSec
    ? `${Math.floor(durSec / 60)}m ${durSec % 60}s`
    : c.started_at ? 'Running…' : '—';

  return (
    <div className="bg-surface-panel border border-surface-border rounded-xl overflow-hidden">
      {/* Header row */}
      <div className="p-4">
        <div className="flex items-start gap-3">
          <button
            onClick={() => setExpanded(e => !e)}
            className="text-text-muted hover:text-text-primary mt-0.5"
          >
            {expanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
          </button>

          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 flex-wrap mb-1">
              <StatusBadge status={c.status} />
              {c.trigger_number && (
                <span className="text-xs font-mono bg-surface-raised text-text-secondary px-2 py-0.5 rounded border border-surface-border">
                  {c.trigger_number}
                </span>
              )}
              {isActive && (
                <span className="w-1.5 h-1.5 rounded-full bg-green-400 animate-pulse" />
              )}
            </div>

            <p className="text-sm font-semibold text-text-primary truncate">
              {c.ens_name || `Campaign ${c.id.slice(0, 8)}`}
            </p>

            <div className="flex items-center gap-3 mt-0.5 text-[11px] text-text-muted flex-wrap">
              <span>{c.triggered_via}</span>
              {c.triggered_by_name && <span>by {c.triggered_by_name}</span>}
              <span>·</span>
              <span>{new Date(c.created_at).toLocaleString()}</span>
              {durStr !== '—' && <span>· {durStr}</span>}
            </div>

            {/* Progress */}
            {c.total_destinations > 0 && (
              <div className="mt-3">
                <CampaignProgress c={c} />
              </div>
            )}
          </div>

          {/* Controls */}
          {canControl && (
            <div className="flex gap-1 shrink-0">
              {c.status === 'running' && (
                <button
                  disabled={acting}
                  onClick={() => act(() => api.campaigns.pause(c.id))}
                  className="btn-ghost p-1.5"
                  title="Pause"
                >
                  <Pause size={14} />
                </button>
              )}
              {isPaused && (
                <button
                  disabled={acting}
                  onClick={() => act(() => api.campaigns.resume(c.id))}
                  className="btn-ghost p-1.5"
                  title="Resume"
                >
                  <Play size={14} />
                </button>
              )}
              <button
                disabled={acting}
                onClick={() => {
                  if (window.confirm('Cancel this campaign?')) act(() => api.campaigns.cancel(c.id));
                }}
                className="btn-ghost p-1.5 text-red-400 hover:text-red-300"
                title="Cancel"
              >
                <XCircle size={14} />
              </button>
            </div>
          )}
        </div>

        {/* Stats grid (always visible) */}
        <div className="grid grid-cols-4 sm:grid-cols-8 gap-2 mt-4">
          {[
            { label: 'Total',     value: c.total_destinations, icon: Users },
            { label: 'Answered',  value: c.answered_count,     icon: CheckCircle },
            { label: 'Completed', value: c.completed_count,    icon: CheckCircle },
            { label: 'Busy',      value: c.busy_count,         icon: PhoneOff,   warn: true },
            { label: 'No Ans',    value: c.no_answer_count,    icon: PhoneMissed, warn: true },
            { label: 'Failed',    value: c.failed_count,       icon: AlertCircle, warn: true },
            { label: 'Retried',   value: c.retried_count,      icon: RefreshCw },
            { label: 'Peak CC',   value: c.peak_concurrent,    icon: BarChart2 },
          ].map(s => (
            <div key={s.label} className="text-center">
              <p className="text-[10px] text-text-muted">{s.label}</p>
              <p className={`text-sm font-bold font-mono ${s.warn && (s.value || 0) > 0 ? 'text-red-400' : 'text-text-primary'}`}>
                {s.value ?? 0}
              </p>
            </div>
          ))}
        </div>
      </div>

      {/* Expanded destinations */}
      {expanded && (
        <div className="px-4 pb-4">
          <DestinationPanel campaignId={c.id} />
        </div>
      )}
    </div>
  );
}

// ── Page ──────────────────────────────────────────────────────────────────────

const STATUS_FILTERS = [
  { value: '',           label: 'All' },
  { value: 'running',   label: 'Running' },
  { value: 'queued',    label: 'Queued' },
  { value: 'paused',    label: 'Paused' },
  { value: 'completed', label: 'Completed' },
  { value: 'cancelled', label: 'Cancelled' },
];

export default function CampaignDashboard() {
  const [campaigns, setCampaigns] = useState([]);
  const [total, setTotal]         = useState(0);
  const [loading, setLoading]     = useState(true);
  const [error, setError]         = useState('');
  const [statusFilter, setStatusFilter] = useState('');
  const [page, setPage]           = useState(1);
  const [engineStats, setEngineStats] = useState(null);
  const pollRef = useRef(null);
  const limit = 20;

  const load = useCallback(async () => {
    setError('');
    try {
      const [data, stats] = await Promise.all([
        api.campaigns.list({ status: statusFilter || undefined, page, limit }),
        api.campaigns.engineStats().catch(() => null),
      ]);
      setCampaigns(data.campaigns || []);
      setTotal(data.total || 0);
      setEngineStats(stats);
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }, [statusFilter, page]);

  useEffect(() => {
    setLoading(true);
    load();
  }, [load]);

  // Auto-refresh every 3 s when active campaigns exist
  useEffect(() => {
    pollRef.current = setInterval(() => {
      if (engineStats?.active_campaigns > 0 || campaigns.some(c => c.status === 'running' || c.status === 'queued')) {
        load();
      }
    }, 3000);
    return () => clearInterval(pollRef.current);
  }, [load, engineStats, campaigns]);

  const activeCampaigns = campaigns.filter(c => c.status === 'running' || c.status === 'queued').length;

  return (
    <div className="p-6 max-w-5xl mx-auto">
      {/* Header */}
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-xl font-bold text-text-primary flex items-center gap-2">
            <Bell size={20} className="text-brand" />
            ENS Campaigns
          </h1>
          <p className="text-sm text-text-muted mt-0.5">
            Outbound blast campaign management
          </p>
        </div>
        <div className="flex items-center gap-2">
          {engineStats && (
            <div className={`
              flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-full border
              ${engineStats.active_campaigns > 0
                ? 'border-green-500/30 bg-green-500/10 text-green-400'
                : 'border-surface-border bg-surface-raised text-text-muted'}
            `}>
              <Activity size={11} />
              Engine: {engineStats.active_campaigns} active
            </div>
          )}
          <button onClick={load} disabled={loading} className="btn-ghost flex items-center gap-1.5">
            <RefreshCw size={14} className={loading ? 'animate-spin' : ''} />
            Refresh
          </button>
        </div>
      </div>

      {/* Summary */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-6">
        {[
          { label: 'Total Campaigns', value: total,           icon: Bell },
          { label: 'Active',          value: activeCampaigns, icon: Activity, warn: activeCampaigns > 0 },
          { label: 'Running',         value: campaigns.filter(c => c.status === 'running').length,   icon: Play },
          { label: 'Completed Today', value: campaigns.filter(c => c.status === 'completed').length, icon: CheckCircle },
        ].map(s => (
          <div key={s.label} className="bg-surface-panel border border-surface-border rounded-xl p-4">
            <div className="flex items-start justify-between">
              <div>
                <p className="text-xs text-text-muted mb-1">{s.label}</p>
                <p className={`text-2xl font-bold ${s.warn && (s.value || 0) > 0 ? 'text-green-400' : 'text-text-primary'}`}>
                  {s.value ?? 0}
                </p>
              </div>
              <s.icon size={16} className="text-text-muted mt-0.5" />
            </div>
          </div>
        ))}
      </div>

      {/* Status filter */}
      <div className="flex items-center gap-2 mb-4">
        <div className="flex gap-1 bg-surface-raised rounded-lg p-1">
          {STATUS_FILTERS.map(f => (
            <button
              key={f.value}
              onClick={() => { setStatusFilter(f.value); setPage(1); }}
              className={`px-3 py-1 rounded text-xs font-medium transition-colors ${
                statusFilter === f.value
                  ? 'bg-surface-panel text-text-primary shadow-sm'
                  : 'text-text-muted hover:text-text-secondary'
              }`}
            >
              {f.label}
            </button>
          ))}
        </div>
      </div>

      {/* Error */}
      {error && (
        <div className="flex items-center gap-2 text-red-400 bg-red-500/10 border border-red-500/20 rounded-lg p-3 text-sm mb-4">
          <AlertCircle size={14} />
          {error}
        </div>
      )}

      {/* Campaign list */}
      {loading ? (
        <div className="space-y-3">
          {[...Array(3)].map((_, i) => (
            <div key={i} className="bg-surface-panel border border-surface-border rounded-xl h-36 animate-pulse" />
          ))}
        </div>
      ) : campaigns.length === 0 ? (
        <div className="text-center py-16 text-text-muted">
          <Bell size={32} className="mx-auto mb-3 opacity-30" />
          <p className="text-sm">No campaigns found</p>
          <p className="text-xs mt-1">Campaigns are triggered from the Service Registry or by calling an ENS trigger number</p>
        </div>
      ) : (
        <div className="space-y-3">
          {campaigns.map(c => (
            <CampaignRow key={c.id} c={c} onRefresh={load} />
          ))}
        </div>
      )}

      {/* Pagination */}
      {total > limit && (
        <div className="flex items-center justify-between mt-4">
          <span className="text-xs text-text-muted">{total} total campaigns</span>
          <div className="flex gap-1">
            <button disabled={page === 1} onClick={() => setPage(p => p - 1)} className="btn-ghost py-1 px-3 text-xs">Previous</button>
            <span className="text-xs text-text-muted py-1.5 px-2">Page {page}</span>
            <button disabled={page * limit >= total} onClick={() => setPage(p => p + 1)} className="btn-ghost py-1 px-3 text-xs">Next</button>
          </div>
        </div>
      )}
    </div>
  );
}
