import { notify } from '../../components/ui/Toast.jsx';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Plus, Pencil, Trash2, Upload, CheckCircle2, XCircle, Search, ArrowUp, ArrowDown, ChevronsUpDown, Users } from 'lucide-react';
import PageHeader from '../../components/ui/PageHeader.jsx';
import { api } from '../../api/client.js';
import { useAuthStore } from '../../store/authStore.js';
import Modal from '../../components/ui/Modal.jsx';
import { Table, Th, Td, Tr, EmptyRow } from '../../components/ui/Table.jsx';
import Pagination from '../../components/ui/Pagination.jsx';
import ExportButton from '../../components/ui/ExportButton.jsx';
import EmptyState from '../../components/ui/EmptyState.jsx';
import { confirmAction } from '../../components/ui/ConfirmDialog.jsx';
import { can, needsTenantSelection } from '../../auth/permissions.js';
import ColumnChooser from './ColumnChooser.jsx';
import {
  PAGE_SIZES, DEFAULT_PREFS, EMPTY_FILTERS, TEMPLATE_COLUMNS, IMPORT_ACCEPT,
  loadPrefs, savePrefs, choosableColumns, visibleColumns, toggleColumn,
  nextSort, ariaSort, hasActiveFilters, buildQuery, cellText, importIssueText, orgLabel,
  checkImportFile, importCounts, contactPayload, identityHint, savedNotice,
} from './contactTable.js';

const EMPTY = { organization_id: '', first_name: '', last_name: '', mobile_number: '', extension_number: '', email: '', role: '', department_id: '', location_id: '' };
const storage = () => { try { return window.localStorage; } catch { return null; } };

function SortIcon({ dir }) {
  if (dir === 'ascending')  return <ArrowUp size={11} aria-hidden="true" />;
  if (dir === 'descending') return <ArrowDown size={11} aria-hidden="true" />;
  return <ChevronsUpDown size={11} className="opacity-40" aria-hidden="true" />;
}

const XLSX_TEMPLATE = 'emergency-contacts-template.xlsx';
const CSV_TEMPLATE = 'emergency-contacts-template.csv';

// Counts and row messages of an import check (preview) or of a finished import.
function ImportReport({ result }) {
  const c = importCounts(result);
  const preview = !!result.preview;
  const cell = (label, value, tone = '') => (
    <div className="rounded-lg bg-surface-hover px-2 py-1.5">
      <dt className="text-[10px] uppercase tracking-wide text-text-muted">{label}</dt>
      <dd className={`text-base font-semibold tabular-nums ${tone}`}>{value}</dd>
    </div>
  );
  return (
    <div className="rounded-lg border border-surface-border p-3 text-sm space-y-2" aria-live="polite">
      <p className={`flex items-center gap-2 font-medium ${preview ? 'text-text-primary' : 'text-green-500'}`}>
        {preview ? 'File checked — nothing has been imported yet.'
          : <><CheckCircle2 size={14} aria-hidden="true" /> {c.created} created, {c.updated} updated of {c.total} rows</>}
      </p>
      <dl className="grid grid-cols-3 sm:grid-cols-6 gap-2 text-center">
        {cell('Rows', c.total)}
        {cell(preview ? 'New' : 'Created', c.created, 'text-green-500')}
        {cell(preview ? 'Will update' : 'Updated', c.updated, 'text-green-500')}
        {cell('Duplicates prevented', c.duplicatesPrevented)}
        {cell('Conflicts', c.conflicts, c.conflicts ? 'text-red-500' : '')}
        {cell('Invalid', c.otherInvalid, c.otherInvalid ? 'text-red-500' : '')}
      </dl>
      <p className="text-xs text-text-muted">
        A row whose mobile or extension number already belongs to a contact of the organization updates that
        contact (blank cells keep the current values) instead of creating a duplicate.
        {preview && (c.invalid > 0) && ' Rows with errors or conflicts are not imported. Fix the file and check it again, or import only the valid rows.'}
      </p>
      {result.updates?.length > 0 && (
        <details className="text-xs mt-1">
          <summary className="cursor-pointer text-text-muted">{result.updates.length} row{result.updates.length === 1 ? '' : 's'} {preview ? 'will update' : 'updated'} an existing contact</summary>
          <ul className="mt-1 space-y-0.5 list-disc list-inside max-h-40 overflow-y-auto text-text-muted">
            {result.updates.map((d, i) => <li key={i}>{importIssueText(d)}</li>)}
          </ul>
        </details>
      )}
      {result.errors?.length > 0 && (
        <details className="text-xs mt-1" open>
          <summary className="cursor-pointer text-red-500">{result.errors.length} row{result.errors.length === 1 ? '' : 's'} with errors</summary>
          <ul className="mt-1 space-y-0.5 list-disc list-inside max-h-48 overflow-y-auto text-text-muted">
            {result.errors.map((e, i) => <li key={i}>{importIssueText(e)}</li>)}
          </ul>
        </details>
      )}
      {result.duplicates?.length > 0 && (
        <details className="text-xs mt-1">
          <summary className="cursor-pointer text-text-muted">{result.duplicates.length} row{result.duplicates.length === 1 ? '' : 's'} already up to date (nothing to change)</summary>
          <ul className="mt-1 space-y-0.5 list-disc list-inside max-h-40 overflow-y-auto text-text-muted">
            {result.duplicates.map((d, i) => <li key={i}>{importIssueText(d)}</li>)}
          </ul>
        </details>
      )}
    </div>
  );
}

// Import dialog: choose (target tenant and) file → "Check file" (nothing written) → confirm.
function ImportDialog({ orgs, allTenants, initialOrg, onClose, onImported }) {
  const [file, setFile] = useState(null);
  const [fileError, setFileError] = useState('');
  const [orgId, setOrgId] = useState(initialOrg || '');
  const [tenants, setTenants] = useState([]);
  const [tenantId, setTenantId] = useState('');
  const [preview, setPreview] = useState(null);
  const [result, setResult] = useState(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState('');

  useEffect(() => {
    if (!allTenants) return;
    api.tenants.list().then((d) => setTenants(d.tenants || [])).catch((e) => setError(`Tenants could not be loaded: ${e.message}`));
  }, [allTenants]);

  const reset = () => { setPreview(null); setResult(null); setError(''); };
  const missingTenant = allTenants && !tenantId;
  const tenantOrgs = allTenants ? orgs.filter((o) => tenantId && String(o.tenant_id) === String(tenantId)) : orgs;
  const counts = importCounts(preview);

  function chooseFile(e) {
    const f = e.target.files?.[0] || null;
    setFile(f);
    setFileError(f ? (checkImportFile(f) || '') : '');
    reset();
  }

  async function send(mode) {
    const problem = checkImportFile(file);
    if (problem) { setFileError(problem); return; }
    if (missingTenant) { setError('Select the target tenant first.'); return; }
    setBusy(mode); setError('');
    try {
      const res = await api.contacts.bulkUpload(orgId || undefined, file, { mode, tenantId: allTenants ? tenantId : undefined });
      if (mode === 'preview') { setPreview(res); setResult(null); } else { setResult(res); setPreview(null); onImported(); }
    } catch (e) { setError(e.message); } finally { setBusy(''); }
  }

  return (
    <Modal title="Import Contacts" onClose={onClose} size="lg">
      <div className="space-y-4">
        <div className="text-sm text-text-muted space-y-2">
          <p>
            Download a template, enter one contact per row, save it as an Excel Workbook (.xlsx) or CSV,
            then upload it here. The file is checked first; nothing is imported until you confirm.
          </p>
          <p className="text-xs">
            Columns: <code className="bg-surface-hover px-1 rounded">{TEMPLATE_COLUMNS.join(', ')}</code>.
            first_name, last_name, organization and a mobile or extension number are required.
            At most 10,000 rows and 5 MB per file.
          </p>
          <div className="flex flex-wrap gap-2">
            <ExportButton run={() => api.contacts.importTemplate('xlsx')} filename={XLSX_TEMPLATE} label="Excel template (.xlsx)" />
            <ExportButton run={() => api.contacts.importTemplate('csv')} filename={CSV_TEMPLATE} label="CSV template" />
          </div>
        </div>

        {allTenants && (
          <div>
            <label className="label" htmlFor="import-tenant">Target tenant</label>
            <select id="import-tenant" className="input" value={tenantId}
                    onChange={(e) => { setTenantId(e.target.value); setOrgId(''); reset(); }}>
              <option value="">Select…</option>
              {tenants.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
            </select>
          </div>
        )}
        <div>
          <label className="label" htmlFor="import-org">
            Organization <span className="font-normal text-text-muted">(only for files without an organization column)</span>
          </label>
          <select id="import-org" className="input" value={orgId} disabled={missingTenant}
                  onChange={(e) => { setOrgId(e.target.value); reset(); }}>
            <option value="">None — use the organization column</option>
            {tenantOrgs.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}
          </select>
        </div>
        <div>
          <label className="label" htmlFor="import-file">File (.xlsx or .csv)</label>
          <input id="import-file" type="file" accept={IMPORT_ACCEPT} className="input" onChange={chooseFile} />
          {fileError && <p className="text-xs text-red-500 mt-1" role="alert">{fileError}</p>}
        </div>

        {preview && <ImportReport result={preview} />}
        {result && <ImportReport result={result} />}
        {error && (
          <p className="text-sm text-red-500 flex items-center gap-2" role="alert">
            <XCircle size={14} aria-hidden="true" /> {error}
          </p>
        )}

        <div className="flex flex-wrap gap-2 justify-end">
          <button type="button" onClick={onClose} className="btn-secondary">{result ? 'Close' : 'Cancel'}</button>
          {!preview && !result && (
            <button type="button" onClick={() => send('preview')} className="btn-primary"
                    disabled={!file || !!fileError || missingTenant || !!busy}>
              {busy === 'preview' ? 'Checking…' : 'Check file'}
            </button>
          )}
          {preview && (
            <button type="button" onClick={() => send('commit')} className="btn-primary" disabled={!counts.valid || !!busy}>
              {busy === 'commit' ? 'Importing…'
                : counts.updated ? `Import ${counts.valid} row${counts.valid === 1 ? '' : 's'} (${counts.created} new, ${counts.updated} update${counts.updated === 1 ? '' : 's'})`
                : `Import ${counts.valid} valid contact${counts.valid === 1 ? '' : 's'}`}
            </button>
          )}
        </div>
      </div>
    </Modal>
  );
}

export default function ContactList() {
  const user           = useAuthStore(s => s.user);
  const activeTenantId = useAuthStore(s => s.activeTenantId);
  const canView = can(user, 'contacts.view');
  const canEdit = can(user, 'contacts.edit');
  const showTenant = user?.role === 'SUPER_ADMIN' && !activeTenantId;

  // ── Preferences (columns, page size) — per user, per browser ──
  const [prefs, setPrefs] = useState(() => loadPrefs(storage(), user?.id));
  useEffect(() => { setPrefs(loadPrefs(storage(), user?.id)); }, [user?.id]);
  const updatePrefs = (p) => { setPrefs(p); savePrefs(storage(), user?.id, p); };
  const columns = visibleColumns(prefs, showTenant);

  // ── Query state ──
  const [searchInput, setSearchInput] = useState('');
  const [search,      setSearch]      = useState('');
  const [filters,     setFilters]     = useState(EMPTY_FILTERS);
  const [sort,        setSort]        = useState(null);
  const [page,        setPage]        = useState(1);
  const [reloadTick,  setReloadTick]  = useState(0);
  const pageSize = prefs.pageSize;

  // ── Data ──
  const [rows,     setRows]     = useState([]);
  const [total,    setTotal]    = useState(0);
  const [loading,  setLoading]  = useState(true);
  const [loadErr,  setLoadErr]  = useState('');
  const [orgs,     setOrgs]     = useState([]);
  const [depts,    setDepts]    = useState([]);
  const [locs,     setLocs]     = useState([]);
  const [roles,    setRoles]    = useState([]);
  const [selected, setSelected] = useState(() => new Set());
  const requestSeq = useRef(0);

  // ── Dialogs ──
  const [modal,    setModal]    = useState(null);
  const [form,     setForm]     = useState(EMPTY);
  const [saving,   setSaving]   = useState(false);
  const [error,    setError]    = useState('');
  const [importOpen, setImportOpen] = useState(false);
  const [deleting, setDeleting] = useState(false);

  const reload = () => setReloadTick(t => t + 1);

  // Lookups (organizations, departments, locations, roles) — on open and on tenant switch.
  // Only the newest call may apply its result (a fast tenant switch must not show stale lookups).
  const lookupSeq = useRef(0);
  async function loadLookups() {
    const seq = ++lookupSeq.current;
    try {
      const [o, d, l, r] = await Promise.all([
        api.orgs.list(), api.departments.list(''), api.locations.list(''), api.contacts.roles(),
      ]);
      if (seq !== lookupSeq.current) return;
      setOrgs(o.organizations || []);
      setDepts(d.departments || []);
      setLocs(l.locations || []);
      setRoles(r.roles || []);
    } catch (e) { notify(e.message); }
  }

  // Tenant switch: start over. The previous tenant's rows, selection and lookups are cleared at
  // once, so nothing of that tenant is shown (or selectable) while the new page loads.
  useEffect(() => {
    setModal(null); setImportOpen(false);
    setRows([]); setTotal(0); setSelected(new Set());
    setOrgs([]); setDepts([]); setLocs([]); setRoles([]);
    setFilters(EMPTY_FILTERS); setSearchInput(''); setSearch(''); setSort(null); setPage(1);
    if (canView) loadLookups();
  }, [activeTenantId, canView]);

  // Debounced search.
  useEffect(() => {
    if (searchInput === search) return undefined;
    const t = setTimeout(() => { setSearch(searchInput); setPage(1); }, 300);
    return () => clearTimeout(t);
  }, [searchInput, search]);

  const query = useMemo(() => buildQuery({ filters, search, sort }), [filters, search, sort]);

  // Contacts page. Any change of page, size, filters, search, sort or tenant clears the selection.
  useEffect(() => {
    if (!canView) return;
    setSelected(new Set());
    const seq = ++requestSeq.current;
    setLoading(true); setLoadErr('');
    api.contacts.page({ ...query, page, limit: pageSize })
      .then(res => {
        if (seq !== requestSeq.current) return;           // a newer request is on its way
        const list = res.contacts || [];
        if (list.length === 0 && res.total > 0 && page > 1) {   // e.g. the last page was deleted
          setPage(Math.max(1, Math.ceil(res.total / pageSize)));
          return;
        }
        setRows(list); setTotal(res.total || 0);
      })
      .catch(e => { if (seq === requestSeq.current) { setRows([]); setTotal(0); setLoadErr(e.message); } })
      .finally(() => { if (seq === requestSeq.current) setLoading(false); });
  }, [query, page, pageSize, activeTenantId, reloadTick, canView]);

  const setFilter = (k, v) => {
    setFilters(prev => {
      const next = { ...prev, [k]: v };
      // A department / location of another organization no longer applies.
      if (k === 'organization_id' && v) {
        if (next.department_id && !depts.some(d => String(d.id) === String(next.department_id) && String(d.organization_id) === String(v))) next.department_id = '';
        if (next.location_id && !locs.some(l => String(l.id) === String(next.location_id) && String(l.organization_id) === String(v))) next.location_id = '';
      }
      return next;
    });
    setPage(1);
  };
  const clearFilters = () => { setFilters(EMPTY_FILTERS); setSearchInput(''); setSearch(''); setPage(1); };
  const onSort = (key) => { setSort(s => nextSort(s, key)); setPage(1); };
  const setPageSize = (n) => { updatePrefs({ ...prefs, pageSize: n }); setPage(1); };

  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const filtering  = hasActiveFilters(filters, search);
  const byOrg = (list, orgId) => (orgId ? list.filter(x => String(x.organization_id) === String(orgId)) : list);

  // ── Selection (current page only) ──
  const pageIds = rows.map(r => r.id);
  const allOnPage = pageIds.length > 0 && pageIds.every(id => selected.has(id));
  const toggleOne = (id) => setSelected(prev => { const n = new Set(prev); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  const toggleAll = () => setSelected(allOnPage ? new Set() : new Set(pageIds));

  // ── Add / edit ──
  const f = (k, v) => setForm(p => ({ ...p, [k]: v }));
  function setFormOrg(v) {
    setForm(p => ({
      ...p, organization_id: v,
      department_id: depts.some(d => String(d.id) === String(p.department_id) && String(d.organization_id) === String(v)) ? p.department_id : '',
      location_id:   locs.some(l => String(l.id) === String(p.location_id) && String(l.organization_id) === String(v)) ? p.location_id : '',
    }));
  }

  // Identity feedback while typing (one extension / mobile number = one contact). The
  // server checks again on save; this only tells the user before they submit.
  const [idCheck, setIdCheck] = useState(null);
  const idSeq = useRef(0);
  useEffect(() => {
    const seq = ++idSeq.current;
    setIdCheck(null);
    if (!modal || !form.organization_id || !(form.mobile_number?.trim() || form.extension_number?.trim())) return undefined;
    const t = setTimeout(() => {
      api.contacts.identityCheck({
        organization_id: form.organization_id,
        mobile_number: form.mobile_number?.trim() || undefined,
        extension_number: form.extension_number?.trim() || undefined,
        exclude_id: modal.id || undefined,
      }).then((r) => { if (seq === idSeq.current) setIdCheck(r); })
        .catch(() => { /* no hint; the save still validates */ });
    }, 400);
    return () => clearTimeout(t);
  }, [modal, form.organization_id, form.mobile_number, form.extension_number]);
  const hint = identityHint(idCheck, !!modal?.id);

  async function handleSave() {
    setSaving(true); setError('');
    try {
      const payload = contactPayload(form, !!modal.id);
      const res = modal.id ? await api.contacts.update(modal.id, payload) : await api.contacts.create(payload);
      if (res?.upserted) notify(savedNotice(res, false), 'success');
      setModal(null); reload(); loadRoles();
    } catch (e) { setError(e.message); } finally { setSaving(false); }
  }

  async function loadRoles() {
    try { setRoles((await api.contacts.roles()).roles || []); } catch { /* the filter keeps the previous list */ }
  }

  function openCreate() {
    setForm({ ...EMPTY, organization_id: filters.organization_id ? Number(filters.organization_id) : '' });
    setModal({}); setError('');
  }
  function openEdit(r) {
    setForm({
      organization_id: r.organization_id, first_name: r.first_name || '',
      last_name: r.last_name || '', mobile_number: r.mobile_number || '',
      extension_number: r.extension_number || '',
      email: r.email || '', role: r.role || '',
      department_id: r.department_id || '', location_id: r.location_id || '',
    });
    setModal(r); setError('');
  }

  async function del(r) {
    if (!(await confirmAction({ title: 'Delete contact', message: `Delete contact "${r.first_name} ${r.last_name}"?`, confirmLabel: 'Delete' }))) return;
    try { await api.contacts.remove(r.id); reload(); } catch (e) { notify(e.message); }
  }

  async function deleteSelected() {
    const ids = [...selected];
    if (!ids.length) return;
    const ok = await confirmAction({
      title: 'Delete contacts',
      message: `Delete ${ids.length} selected contact${ids.length === 1 ? '' : 's'}? They are removed from responder groups and configurations that use them.`,
      confirmLabel: `Delete ${ids.length}`,
    });
    if (!ok) return;
    setDeleting(true);
    try {
      const res = await api.contacts.bulkDelete(ids);
      const missed = res.not_found?.length || 0;
      notify(`${res.deleted} contact${res.deleted === 1 ? '' : 's'} deleted${missed ? `; ${missed} could not be deleted (already removed or not accessible)` : ''}.`,
             missed ? 'error' : 'success');
      reload();
    } catch (e) { notify(e.message); } finally { setDeleting(false); }
  }

  if (!canView) {
    return (
      <div className="space-y-6">
        <PageHeader title="Emergency Contacts" />
        <EmptyState icon={Users} title="No access" description="Your role cannot view emergency contacts." />
      </div>
    );
  }

  const colCount = columns.length + (canEdit ? 2 : 0);
  const exportName = `contacts-${new Date().toISOString().slice(0, 10)}.csv`;

  return (
    <div className="space-y-4">
      <PageHeader title="Emergency Contacts">
        <ExportButton run={() => api.contacts.exportCsv(query)} filename={exportName}
                      label="Export CSV" disabled={loading || total === 0} />
        {canEdit && (
          <>
            <ExportButton run={() => api.contacts.importTemplate('xlsx')} filename={XLSX_TEMPLATE} label="Download Excel Template (.xlsx)" />
            <ExportButton run={() => api.contacts.importTemplate('csv')} filename={CSV_TEMPLATE} label="Download CSV Template" />
            <button onClick={() => setImportOpen(true)} className="btn-secondary">
              <Upload size={14} /> Import Contacts
            </button>
            <button onClick={openCreate} className="btn-primary">
              <Plus size={15} /> Add Contact
            </button>
          </>
        )}
      </PageHeader>

      {/* Search and filters */}
      <div className="filter-bar">
        <div className="flex flex-col gap-1 grow min-w-[12rem] max-w-xs">
          <label className="label" htmlFor="contact-search">Search</label>
          <div className="relative">
            <Search size={13} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-text-muted" aria-hidden="true" />
            <input id="contact-search" type="search" className="input-sm w-full pl-8" value={searchInput}
                   placeholder="Name, number, email or role" onChange={e => setSearchInput(e.target.value)} />
          </div>
        </div>
        <div className="flex flex-col gap-1">
          <label className="label" htmlFor="f-org">Organization</label>
          <select id="f-org" className="input-sm w-44" value={filters.organization_id} onChange={e => setFilter('organization_id', e.target.value)}>
            <option value="">All organizations</option>
            {orgs.map(o => <option key={o.id} value={o.id}>{orgLabel(o, showTenant)}</option>)}
          </select>
        </div>
        <div className="flex flex-col gap-1">
          <label className="label" htmlFor="f-dept">Department</label>
          <select id="f-dept" className="input-sm w-40" value={filters.department_id} onChange={e => setFilter('department_id', e.target.value)}>
            <option value="">All departments</option>
            {byOrg(depts, filters.organization_id).map(d => <option key={d.id} value={d.id}>{d.name}</option>)}
          </select>
        </div>
        <div className="flex flex-col gap-1">
          <label className="label" htmlFor="f-loc">Location</label>
          <select id="f-loc" className="input-sm w-40" value={filters.location_id} onChange={e => setFilter('location_id', e.target.value)}>
            <option value="">All locations</option>
            {byOrg(locs, filters.organization_id).map(l => <option key={l.id} value={l.id}>{l.name}</option>)}
          </select>
        </div>
        <div className="flex flex-col gap-1">
          <label className="label" htmlFor="f-role">Role</label>
          <select id="f-role" className="input-sm w-36" value={filters.role} onChange={e => setFilter('role', e.target.value)}>
            <option value="">All roles</option>
            {roles.map(r => <option key={r} value={r}>{r}</option>)}
          </select>
        </div>
        <div className="flex flex-col gap-1">
          <label className="label" htmlFor="f-status">Status</label>
          <select id="f-status" className="input-sm w-28" value={filters.is_active} onChange={e => setFilter('is_active', e.target.value)}>
            <option value="">All</option>
            <option value="true">Active</option>
            <option value="false">Inactive</option>
          </select>
        </div>
        {filtering && (
          <button type="button" className="btn-ghost btn-sm" onClick={clearFilters}>Clear filters</button>
        )}
        <div className="ml-auto flex items-end gap-2">
          <ColumnChooser columns={choosableColumns(showTenant)} selected={prefs.columns}
                         onToggle={k => updatePrefs(toggleColumn(prefs, k))}
                         onReset={() => updatePrefs({ ...DEFAULT_PREFS, pageSize: prefs.pageSize })} />
          <label className="sr-only" htmlFor="page-size">Rows per page</label>
          <select id="page-size" className="input-sm w-24" value={pageSize} onChange={e => setPageSize(Number(e.target.value))}>
            {PAGE_SIZES.map(n => <option key={n} value={n}>{n} / page</option>)}
          </select>
        </div>
      </div>

      {/* Count and selection bar */}
      <div className="flex items-center gap-3 min-h-[2rem] text-xs text-text-muted" aria-live="polite">
        <span>{loading ? 'Loading…' : `${total} contact${total === 1 ? '' : 's'}${filtering ? ' match' : ''}`}</span>
        {canEdit && selected.size > 0 && (
          <span className="flex items-center gap-2 text-text-primary">
            <span className="font-semibold">{selected.size} selected on this page</span>
            <button type="button" className="btn-secondary btn-sm text-red-500" disabled={deleting} onClick={deleteSelected}>
              <Trash2 size={12} aria-hidden="true" /> {deleting ? 'Deleting…' : 'Delete selected'}
            </button>
            <button type="button" className="btn-ghost btn-sm" onClick={() => setSelected(new Set())}>Clear selection</button>
          </span>
        )}
      </div>

      <Table className={loading && rows.length ? 'opacity-60' : ''}>
        <thead><tr>
          {canEdit && (
            <Th className="w-8">
              <input type="checkbox" aria-label="Select all contacts on this page" checked={allOnPage}
                     disabled={!rows.length} onChange={toggleAll} />
            </Th>
          )}
          {columns.map(col => {
            const dir = ariaSort(sort, col.sort);
            return (
              <Th key={col.key} aria-sort={dir}>
                <button type="button" onClick={() => onSort(col.sort)}
                        className="inline-flex items-center gap-1 hover:text-text-primary focus-visible:underline"
                        title={`Sort by ${col.label}`}>
                  {col.label} <SortIcon dir={dir} />
                </button>
              </Th>
            );
          })}
          {canEdit && <Th><span className="sr-only">Actions</span></Th>}
        </tr></thead>
        <tbody>
          {loadErr ? (
            <tr><td colSpan={colCount} className="py-10 text-center text-sm">
              <p className="text-red-500 mb-2">{loadErr}</p>
              <button type="button" className="btn-secondary btn-sm" onClick={reload}>Retry</button>
            </td></tr>
          ) : loading && rows.length === 0 ? (
            <EmptyRow cols={colCount} message="Loading contacts…" />
          ) : rows.length === 0 ? (
            <EmptyRow cols={colCount} message={filtering ? 'No contacts match the search or filters.' : 'No contacts yet.'} />
          ) : rows.map(r => {
            const name = cellText('name', r);
            return (
              <Tr key={r.id} selected={selected.has(r.id)}>
                {canEdit && (
                  <Td className="w-8">
                    <input type="checkbox" aria-label={`Select ${name}`} checked={selected.has(r.id)} onChange={() => toggleOne(r.id)} />
                  </Td>
                )}
                {columns.map(col => {
                  const text = cellText(col.key, r);
                  if (col.key === 'name') return <Td key={col.key} className="font-medium whitespace-nowrap">{name}</Td>;
                  if (col.key === 'status') {
                    return <Td key={col.key} className={`text-xs ${r.is_active === false ? 'text-text-muted' : 'text-green-500'}`}>{text}</Td>;
                  }
                  const mono = col.key === 'mobile' || col.key === 'extension';
                  return (
                    <Td key={col.key} className={`text-text-muted ${mono ? 'font-mono text-xs whitespace-nowrap' : 'text-xs'} max-w-[14rem] truncate`} title={text || undefined}>
                      {text || '—'}
                    </Td>
                  );
                })}
                {canEdit && (
                  <Td>
                    <div className="flex gap-1 justify-end">
                      <button type="button" onClick={() => openEdit(r)} className="btn-ghost p-1.5" aria-label={`Edit ${name}`} title="Edit"><Pencil size={13} aria-hidden="true" /></button>
                      <button type="button" onClick={() => del(r)} className="btn-ghost p-1.5 text-red-500" aria-label={`Delete ${name}`} title="Delete"><Trash2 size={13} aria-hidden="true" /></button>
                    </div>
                  </Td>
                )}
              </Tr>
            );
          })}
        </tbody>
      </Table>

      <Pagination page={page} totalPages={totalPages} onPage={setPage} total={total} limit={pageSize} disabled={loading} />

      {/* Add/Edit Modal */}
      {modal && (
        <Modal title={modal.id ? 'Edit Contact' : 'Add Contact'} onClose={() => setModal(null)}>
          <div className="space-y-3">
            <div>
              <label className="label">Organization</label>
              <select className="input" value={form.organization_id} onChange={e => setFormOrg(Number(e.target.value) || '')}>
                <option value="">Select…</option>
                {orgs.map(o => <option key={o.id} value={o.id}>{orgLabel(o, showTenant)}</option>)}
              </select>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div><label className="label">First Name</label>
                <input className="input" value={form.first_name} onChange={e => f('first_name', e.target.value)} /></div>
              <div><label className="label">Last Name</label>
                <input className="input" value={form.last_name} onChange={e => f('last_name', e.target.value)} /></div>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div><label className="label">Mobile Number</label>
                <input className="input" value={form.mobile_number} onChange={e => f('mobile_number', e.target.value)} /></div>
              <div><label className="label">Extension</label>
                <input className="input" value={form.extension_number} onChange={e => f('extension_number', e.target.value)} /></div>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div><label className="label">Email</label>
                <input className="input" type="email" value={form.email} onChange={e => f('email', e.target.value)} /></div>
              <div><label className="label">Role</label>
                <input className="input" value={form.role} onChange={e => f('role', e.target.value)} placeholder="e.g. Security, Manager" /></div>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="label">Department</label>
                <select className="input" value={form.department_id} onChange={e => f('department_id', e.target.value)}>
                  <option value="">None</option>
                  {depts
                    .filter(d => !form.organization_id || d.organization_id === Number(form.organization_id))
                    .map(d => <option key={d.id} value={d.id}>{d.name}</option>)}
                </select>
              </div>
              <div>
                <label className="label">Location</label>
                <select className="input" value={form.location_id} onChange={e => f('location_id', e.target.value)}>
                  <option value="">None</option>
                  {locs
                    .filter(l => !form.organization_id || l.organization_id === Number(form.organization_id))
                    .map(l => <option key={l.id} value={l.id}>{l.name}</option>)}
                </select>
              </div>
            </div>
            {hint && (
              <p className={`text-xs ${hint.tone === 'error' ? 'text-red-500' : 'text-amber-500'}`} role={hint.blocks ? 'alert' : 'status'}>
                {hint.text}
              </p>
            )}
            {error && <p className="text-sm text-red-500">{error}</p>}
            <div className="flex gap-2 justify-end pt-2">
              <button onClick={() => setModal(null)} className="btn-secondary">Cancel</button>
              <button onClick={handleSave} disabled={saving || !!hint?.blocks} className="btn-primary">
                {saving ? 'Saving…' : hint && !hint.blocks ? 'Update existing contact' : 'Save'}
              </button>
            </div>
          </div>
        </Modal>
      )}

      {/* Import dialog (CSV or Excel): check first, then confirm */}
      {importOpen && (
        <ImportDialog
          orgs={orgs}
          allTenants={needsTenantSelection(user, activeTenantId)}
          initialOrg={filters.organization_id || ''}
          onClose={() => setImportOpen(false)}
          onImported={() => { reload(); loadRoles(); }}
        />
      )}
    </div>
  );
}
