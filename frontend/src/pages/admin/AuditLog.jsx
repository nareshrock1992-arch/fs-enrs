import { useCallback, useEffect, useRef, useState } from 'react';
import { ScrollText, X } from 'lucide-react';
import { api } from '../../api/client.js';
import PageHeader from '../../components/ui/PageHeader.jsx';
import Pagination from '../../components/ui/Pagination.jsx';
import Drawer from '../../components/ui/Drawer.jsx';
import { SkeletonTable } from '../../components/ui/Skeleton.jsx';
import { Table, Th, Td, Tr, EmptyRow } from '../../components/ui/Table.jsx';
import { createLatestGuard, loadErrorMessage } from '../reports/reportState.js';
import { auditActionLabel, auditSummary, detailEntries } from './auditFormat.js';

const LIMIT = 50;
const EMPTY = { from: '', to: '', action: '', entity_type: '', audit_tenant_id: '' };

export default function AuditLog() {
  const [filters, setFilters] = useState(EMPTY);
  const [data, setData]       = useState({ entries: [], total: 0, actions: [], entity_types: [] });
  const [tenants, setTenants] = useState([]);
  const [page, setPage]       = useState(1);
  const [loading, setLoading] = useState(true);
  const [error, setError]     = useState(null);
  const [open, setOpen]       = useState(null);
  const guard = useRef(createLatestGuard()).current;

  const load = useCallback(async (pg) => {
    const token = guard.next();
    setLoading(true);
    setError(null);
    setPage(pg);
    try {
      const q = { page: pg, limit: LIMIT };
      for (const k of Object.keys(EMPTY)) if (filters[k]) q[k] = filters[k];
      const r = await api.audit.list(q);
      if (guard.isCurrent(token)) setData({ entity_types: [], ...r });
    } catch (e) {
      if (guard.isCurrent(token)) {
        setData((d) => ({ ...d, entries: [], total: 0 }));
        setError(loadErrorMessage(e));
      }
    } finally {
      if (guard.isCurrent(token)) setLoading(false);
    }
  }, [filters]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => { load(1); }, [load]);
  // The tenant filter is optional: without the list the log still works, unfiltered.
  useEffect(() => { api.tenants.list({ limit: 1000 }).then((d) => setTenants(d.tenants || [])).catch(() => setTenants([])); }, []);

  const f = (k, v) => setFilters((p) => ({ ...p, [k]: v }));
  const filtered = Object.values(filters).some(Boolean);
  const tenantName = (id) => tenants.find((t) => String(t.id) === String(id))?.name;

  return (
    <div className="space-y-6">
      <PageHeader title="Audit Log" description="Who changed, controlled or exported what, across all tenants. Times are shown in your browser's time zone." icon={ScrollText} />

      <div className="filter-bar" role="search" aria-label="Filter audit records">
        <div className="flex flex-col gap-1">
          <label className="label" htmlFor="audit-from">From</label>
          <input id="audit-from" type="date" className="input-sm" value={filters.from} max={filters.to || undefined} onChange={(e) => f('from', e.target.value)} />
        </div>
        <div className="flex flex-col gap-1">
          <label className="label" htmlFor="audit-to">To</label>
          <input id="audit-to" type="date" className="input-sm" value={filters.to} min={filters.from || undefined} onChange={(e) => f('to', e.target.value)} />
        </div>
        <div className="flex flex-col gap-1">
          <label className="label" htmlFor="audit-action">Action</label>
          <select id="audit-action" className="input-sm" value={filters.action} onChange={(e) => f('action', e.target.value)}>
            <option value="">All actions</option>
            {data.actions.map((a) => <option key={a} value={a}>{auditActionLabel(a)}</option>)}
          </select>
        </div>
        <div className="flex flex-col gap-1">
          <label className="label" htmlFor="audit-entity">Record type</label>
          <select id="audit-entity" className="input-sm" value={filters.entity_type} onChange={(e) => f('entity_type', e.target.value)}>
            <option value="">All types</option>
            {data.entity_types.map((t) => <option key={t} value={t}>{auditActionLabel(t)}</option>)}
          </select>
        </div>
        {tenants.length > 0 && (
          <div className="flex flex-col gap-1">
            <label className="label" htmlFor="audit-tenant">Tenant</label>
            <select id="audit-tenant" className="input-sm" value={filters.audit_tenant_id} onChange={(e) => f('audit_tenant_id', e.target.value)}>
              <option value="">All tenants</option>
              {tenants.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
            </select>
          </div>
        )}
        {filtered && (
          <button type="button" className="btn-ghost btn-sm" onClick={() => setFilters(EMPTY)}>
            <X size={13} aria-hidden="true" /> Clear filters
          </button>
        )}
        <p className="ml-auto self-center text-xs text-text-muted" aria-live="polite">
          {loading ? 'Loading…' : `${data.total.toLocaleString()} record${data.total === 1 ? '' : 's'}`}
        </p>
      </div>

      {error ? (
        <div className="card border-danger/40 text-sm text-danger" role="alert">
          The audit log could not be loaded: {error}
          <button type="button" className="btn-secondary btn-sm ml-3" onClick={() => load(page)}>Retry</button>
        </div>
      ) : loading && data.entries.length === 0 ? (
        <SkeletonTable rows={8} cols={5} />
      ) : (
        <Table>
          <thead><tr><Th>Time</Th><Th>User</Th><Th>Action</Th><Th>Target</Th><Th>Summary</Th></tr></thead>
          <tbody>
            {data.entries.length === 0
              ? <EmptyRow cols={5} message={filtered ? 'No records match these filters.' : 'No audit records yet.'} />
              : data.entries.map((a) => (
                <Tr key={a.id} onClick={() => setOpen(a)} selected={open?.id === a.id} label={`${auditActionLabel(a.action)} at ${new Date(a.created_at).toLocaleString()}`}>
                  <Td className="text-xs text-text-muted whitespace-nowrap tabular-nums">{new Date(a.created_at).toLocaleString()}</Td>
                  <Td className="text-xs">{a.user_email || (a.user_id ? `User ${a.user_id}` : 'System')}</Td>
                  <Td className="text-xs font-medium whitespace-nowrap">{auditActionLabel(a.action)}</Td>
                  <Td className="text-xs text-text-secondary">
                    {auditActionLabel(a.entity_type)}{a.entity_id ? <span className="font-mono text-text-muted"> {a.entity_id}</span> : ''}
                  </Td>
                  <Td className="text-xs text-text-muted max-w-md truncate">{auditSummary(a.details, tenantName)}</Td>
                </Tr>
              ))}
          </tbody>
        </Table>
      )}
      <Pagination page={page} totalPages={Math.max(1, Math.ceil(data.total / LIMIT))} onPage={load} total={data.total} limit={LIMIT} disabled={loading} />

      <Drawer open={!!open} onClose={() => setOpen(null)} title={open ? auditActionLabel(open.action) : ''}
              subtitle={open ? new Date(open.created_at).toLocaleString() : ''}>
        {open && (
          <dl className="divide-y divide-surface-border text-sm">
            {[
              ['User', open.user_email || (open.user_id ? `User ${open.user_id}` : 'System')],
              ['Action code', <span key="c" className="font-mono">{open.action}</span>],
              ['Record', `${auditActionLabel(open.entity_type) || '—'}${open.entity_id ? ` ${open.entity_id}` : ''}`],
              ...detailEntries(open.details, tenantName),
            ].map(([k, v]) => (
              <div key={k} className="grid grid-cols-3 gap-3 px-5 py-2.5">
                <dt className="text-xs font-semibold text-text-muted">{k}</dt>
                <dd className="col-span-2 break-words text-text-primary">{v}</dd>
              </div>
            ))}
          </dl>
        )}
      </Drawer>
    </div>
  );
}
