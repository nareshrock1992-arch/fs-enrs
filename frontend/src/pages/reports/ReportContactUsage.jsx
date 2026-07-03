import { useEffect, useState } from 'react';
import { Download } from 'lucide-react';
import { api } from '../../api/client.js';
import { Table, Th, Td, Tr, EmptyRow } from '../../components/ui/Table.jsx';

export default function ReportContactUsage() {
  const [rows, setRows] = useState([]);

  async function load() {
    try { setRows((await api.reports.contactUsage()).contacts || []); } catch {}
  }
  useEffect(() => { load(); }, []);

  function exportCsv() {
    const h = ['Name', 'Phone', 'Groups', 'ENS Configs', 'Notification Count'];
    const lines = [h.join(','), ...rows.map(r =>
      [
        `${r.first_name} ${r.last_name}`,
        r.phone || '',
        r.group_count ?? 0,
        r.ens_count ?? 0,
        r.notification_count ?? 0,
      ].join(',')
    )];
    const blob = new Blob([lines.join('\n')], { type: 'text/csv' });
    const a = document.createElement('a'); a.href = URL.createObjectURL(blob);
    a.download = 'contact-usage.csv'; a.click();
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-bold text-text-primary">Contact Usage Report</h1>
        <button onClick={exportCsv} className="btn-secondary flex items-center gap-1.5"><Download size={14} /> Export CSV</button>
      </div>
      <Table>
        <thead><tr className="bg-surface-hover">
          <Th>Name</Th><Th>Phone</Th><Th>Groups</Th><Th>ENS Configs</Th><Th>Notifications</Th>
        </tr></thead>
        <tbody>
          {rows.length === 0 ? <EmptyRow cols={5} /> : rows.map(r => (
            <Tr key={r.id}>
              <Td className="font-medium">{r.first_name} {r.last_name}</Td>
              <Td className="text-text-muted font-mono text-xs">{r.phone || '—'}</Td>
              <Td>{r.group_count ?? 0}</Td>
              <Td>{r.ens_count ?? 0}</Td>
              <Td>{r.notification_count ?? 0}</Td>
            </Tr>
          ))}
        </tbody>
      </Table>
    </div>
  );
}
