import { useEffect, useState } from 'react';
import { Download } from 'lucide-react';
import { api } from '../../api/client.js';
import { Table, Th, Td, Tr, EmptyRow } from '../../components/ui/Table.jsx';
import { StatusBadge } from '../../components/ui/Badge.jsx';

const STATUSES = ['', 'PENDING', 'SENT', 'FAILED', 'CANCELLED'];

function fmt(iso) { return iso ? new Date(iso).toLocaleString() : '—'; }

export default function ReportNotifications() {
  const [rows,    setRows]    = useState([]);
  const [loading, setLoading] = useState(false);
  const [filters, setFilters] = useState({ status: '', from: '', to: '' });

  async function load() {
    setLoading(true);
    try {
      const q = {};
      if (filters.status) q.status = filters.status;
      if (filters.from)   q.from   = filters.from;
      if (filters.to)     q.to     = filters.to;
      setRows((await api.reports.notifications(q)).notifications || []);
    } catch {} finally { setLoading(false); }
  }

  useEffect(() => { load(); }, []);

  const f = (k, v) => setFilters(p => ({ ...p, [k]: v }));

  function exportCsv() {
    const h = ['ID', 'Title', 'Status', 'Created At'];
    const lines = [h.join(','), ...rows.map(r => [r.id, r.title, r.status, fmt(r.created_at)].join(','))];
    const blob = new Blob([lines.join('\n')], { type: 'text/csv' });
    const a = document.createElement('a'); a.href = URL.createObjectURL(blob);
    a.download = 'notifications.csv'; a.click();
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-bold text-text-primary">Notification Report</h1>
        <button onClick={exportCsv} className="btn-secondary flex items-center gap-1.5">
          <Download size={14} /> Export CSV
        </button>
      </div>

      <div className="card flex flex-wrap gap-3">
        <div>
          <label className="label">Status</label>
          <select className="input py-1.5 text-sm" value={filters.status} onChange={e => f('status', e.target.value)}>
            {STATUSES.map(s => <option key={s} value={s}>{s || 'All'}</option>)}
          </select>
        </div>
        <div>
          <label className="label">From</label>
          <input type="date" className="input py-1.5 text-sm" value={filters.from}
                 onChange={e => f('from', e.target.value)} />
        </div>
        <div>
          <label className="label">To</label>
          <input type="date" className="input py-1.5 text-sm" value={filters.to}
                 onChange={e => f('to', e.target.value)} />
        </div>
        <div className="flex items-end">
          <button onClick={load} className="btn-primary py-1.5">Apply</button>
        </div>
      </div>

      {loading ? (
        <p className="text-sm text-text-muted">Loading…</p>
      ) : (
        <Table>
          <thead><tr className="bg-surface-hover">
            <Th>Title</Th><Th>Status</Th><Th>Deliveries</Th><Th>Created</Th>
          </tr></thead>
          <tbody>
            {rows.length === 0 ? <EmptyRow cols={4} /> : rows.map(r => (
              <Tr key={r.id}>
                <Td className="font-medium">{r.title || r.id}</Td>
                <Td><StatusBadge status={r.status} /></Td>
                <Td className="text-text-muted">{r.delivery_count ?? '—'}</Td>
                <Td className="text-text-muted text-xs">{fmt(r.created_at)}</Td>
              </Tr>
            ))}
          </tbody>
        </Table>
      )}
    </div>
  );
}
