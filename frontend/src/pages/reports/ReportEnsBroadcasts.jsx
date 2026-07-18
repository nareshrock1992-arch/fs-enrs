import { useEffect, useState } from 'react';
import { RefreshCw, ChevronDown, ChevronRight } from 'lucide-react';
import { api } from '../../api/client.js';
import Badge from '../../components/ui/Badge.jsx';

// Phase 5 C4 — full ENS broadcast detail: per-contact delivery status
// (each contact's extension AND mobile leg tracked separately) plus the
// authorized-playback access log.
export default function ReportEnsBroadcasts() {
  const [broadcasts, setBroadcasts] = useState([]);
  const [playbackLog, setPlaybackLog] = useState([]);
  const [loading, setLoading] = useState(false);
  const [expanded, setExpanded] = useState({});
  const [filters, setFilters] = useState({ from: '', to: '' });

  async function load() {
    setLoading(true);
    try {
      const q = {};
      if (filters.from) q.from = filters.from;
      if (filters.to)   q.to = filters.to;
      const r = await api.reports.ensBroadcasts(q);
      setBroadcasts(r.broadcasts || []);
      setPlaybackLog(r.playback_access_log || []);
    } catch (e) {
      console.error(e);
    } finally {
      setLoading(false);
    }
  }
  useEffect(() => { load(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const fmt = iso => iso ? new Date(iso).toLocaleString() : '—';

  const deliveryVariant = s =>
    s === 'ANSWERED' ? 'success' :
    s === 'FAILED' || s === 'NO_ANSWER' ? 'danger' :
    s === 'DIALLING' ? 'warning' : 'default';

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-bold text-text-primary">ENS Broadcast Report</h1>
          <p className="text-xs text-text-muted mt-0.5">Per-contact delivery status + playback access log</p>
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
        {broadcasts.length === 0 && (
          <p className="text-sm text-text-muted text-center py-8">No broadcasts in this range.</p>
        )}
        {broadcasts.map(b => (
          <div key={b.id} className="card p-0 overflow-hidden">
            <button
              className="w-full flex items-center gap-3 px-4 py-3 text-left hover:bg-surface-hover transition-colors"
              onClick={() => setExpanded(e => ({ ...e, [b.id]: !e[b.id] }))}
            >
              {expanded[b.id] ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
              <div className="flex-1 min-w-0">
                <p className="text-sm font-semibold text-text-primary">{b.ens_name}</p>
                <p className="text-[11px] text-text-muted">
                  {fmt(b.created_at)} · via {b.triggered_via} · by {b.recorded_by_name || b.caller_number || 'unknown'}
                  {b.pin_verified_at && ' · PIN verified'}
                </p>
              </div>
              <span className="text-[11px] text-text-muted">{b.total_answered}/{b.total_targets} answered</span>
              <Badge variant={b.status === 'COMPLETED' ? 'success' : b.status === 'FAILED' ? 'danger' : 'warning'}>
                {b.status}
              </Badge>
            </button>

            {expanded[b.id] && (
              <div className="px-4 pb-4 border-t border-surface-border pt-3">
                <p className="text-[10px] font-medium text-text-muted uppercase tracking-wide mb-1.5">
                  Deliveries ({(b.deliveries || []).length})
                </p>
                {(b.deliveries || []).length === 0
                  ? <p className="text-[11px] text-text-muted">No delivery rows.</p>
                  : (
                    <table className="w-full text-[11px]">
                      <thead><tr className="text-text-muted text-left">
                        <th className="py-1 pr-3 font-medium">Number</th>
                        <th className="py-1 pr-3 font-medium">Status</th>
                        <th className="py-1 pr-3 font-medium">Attempts</th>
                        <th className="py-1 pr-3 font-medium">Answered</th>
                        <th className="py-1 font-medium">Hangup Cause</th>
                      </tr></thead>
                      <tbody>
                        {(b.deliveries || []).map((d, i) => (
                          <tr key={i} className="border-t border-surface-border/50">
                            <td className="py-1.5 pr-3 font-mono text-text-primary">{d.contact_number}</td>
                            <td className="py-1.5 pr-3"><Badge variant={deliveryVariant(d.delivery_status)}>{d.delivery_status}</Badge></td>
                            <td className="py-1.5 pr-3 text-text-muted">{d.attempt_number}</td>
                            <td className="py-1.5 pr-3 text-text-muted">{fmt(d.answered_at)}</td>
                            <td className="py-1.5 text-text-muted">{d.hangup_cause || '—'}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  )}
              </div>
            )}
          </div>
        ))}
      </div>

      {/* Playback access log */}
      <div className="card">
        <p className="text-[10px] font-medium text-text-muted uppercase tracking-wide mb-2">
          Playback Access Log
        </p>
        {playbackLog.length === 0
          ? <p className="text-[11px] text-text-muted">No playback attempts in this range.</p>
          : (
            <table className="w-full text-[11px]">
              <thead><tr className="text-text-muted text-left">
                <th className="py-1 pr-3 font-medium">When</th>
                <th className="py-1 pr-3 font-medium">Caller</th>
                <th className="py-1 pr-3 font-medium">Outcome</th>
                <th className="py-1 font-medium">Detail</th>
              </tr></thead>
              <tbody>
                {playbackLog.map((entry, i) => {
                  let d = entry.details;
                  if (typeof d === 'string') { try { d = JSON.parse(d); } catch { d = {}; } }
                  return (
                    <tr key={i} className="border-t border-surface-border/50">
                      <td className="py-1.5 pr-3 text-text-muted">{fmt(entry.created_at)}</td>
                      <td className="py-1.5 pr-3 font-mono text-text-primary">{d?.caller}</td>
                      <td className="py-1.5 pr-3">
                        <Badge variant={d?.outcome === 'played' ? 'success' : d?.outcome === 'rejected' ? 'danger' : 'warning'}>
                          {d?.outcome}
                        </Badge>
                      </td>
                      <td className="py-1.5 text-text-muted break-all">{d?.detail}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
      </div>
    </div>
  );
}
