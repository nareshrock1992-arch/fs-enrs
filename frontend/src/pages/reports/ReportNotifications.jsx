import { useEffect, useState } from 'react';
import { Download, Bell } from 'lucide-react';
import { api } from '../../api/client.js';
import PageHeader from '../../components/ui/PageHeader.jsx';
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
    const h = ['ID', 'ENS Name', 'Status', 'Targets', 'Answered', 'Created At'];
    const lines = [h.join(','), ...rows.map(r =>
      [r.id, `"${r.ens_name || ''}"`, r.status, r.total_targets ?? '', r.total_answered ?? '', fmt(r.created_at)].join(',')
    )];
    const blob = new Blob([lines.join('\n')], { type: 'text/csv' });
    const a = document.createElement('a'); a.href = URL.createObjectURL(blob);
    a.download = 'notifications.csv'; a.click();
  }

  return (
    <div className="space-y-6">
      <PageHeader title="Notification Report" icon={Bell}>
        <button onClick={exportCsv} className="btn-secondary">
          <Download size={14} /> Export CSV
        </button>
      </PageHeader>

      <div className="filter-bar">
        <div className="flex flex-col gap-1">
          <label className="label">Status</label>
          <select className="input-sm" value={filters.status} onChange={e => f('status', e.target.value)}>
            {STATUSES.map(s => <option key={s} value={s}>{s || 'All'}</option>)}
          </select>
        </div>
        <div className="flex flex-col gap-1">
          <label className="label">From</label>
          <input type="date" className="input-sm" value={filters.from} onChange={e => f('from', e.target.value)} />
        </div>
        <div className="flex flex-col gap-1">
          <label className="label">To</label>
          <input type="date" className="input-sm" value={filters.to} onChange={e => f('to', e.target.value)} />
        </div>
        <div className="flex items-end">
          <button onClick={load} className="btn-primary">Apply</button>
        </div>
      </div>

      {loading ? (
        <p className="text-sm text-text-muted">Loading…</p>
      ) : (
        <Table>
          <thead><tr>
            <Th>ENS Name</Th><Th>Status</Th><Th>Targets</Th><Th>Answered</Th><Th>Created</Th>
          </tr></thead>
          <tbody>
            {rows.length === 0 ? <EmptyRow cols={5} /> : rows.map(r => (
              <Tr key={r.id}>
                <Td className="font-medium">{r.ens_name || r.id}</Td>
                <Td><StatusBadge status={r.status} /></Td>
                <Td className="text-text-muted">{r.total_targets ?? '—'}</Td>
                <Td className="text-text-muted">{r.total_answered ?? '—'}</Td>
                <Td className="text-text-muted text-xs">{fmt(r.created_at)}</Td>
              </Tr>
            ))}
          </tbody>
        </Table>
      )}
    </div>
  );
}
