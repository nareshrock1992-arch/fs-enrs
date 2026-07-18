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
    const h = ['Name', 'Mobile Number', 'Organization', 'ENS Direct Configs', 'ENS Group Configs', 'ERS Incidents'];
    const lines = [h.join(','), ...rows.map(r =>
      [
        `"${r.first_name} ${r.last_name}"`,
        r.mobile_number || '',
        `"${r.organization || ''}"`,
        r.ens_direct_configs ?? 0,
        r.ens_group_configs  ?? 0,
        r.ers_incidents      ?? 0,
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
          <Th>Name</Th><Th>Mobile</Th><Th>Organization</Th><Th>ENS (Direct)</Th><Th>ENS (Group)</Th><Th>ERS Incidents</Th>
        </tr></thead>
        <tbody>
          {rows.length === 0 ? <EmptyRow cols={6} /> : rows.map(r => (
            <Tr key={r.id}>
              <Td className="font-medium">{r.first_name} {r.last_name}</Td>
              <Td className="text-text-muted font-mono text-xs">{r.mobile_number || '—'}</Td>
              <Td>{r.organization || '—'}</Td>
              <Td>{r.ens_direct_configs ?? 0}</Td>
              <Td>{r.ens_group_configs  ?? 0}</Td>
              <Td>{r.ers_incidents      ?? 0}</Td>
            </Tr>
          ))}
        </tbody>
      </Table>
    </div>
  );
}
