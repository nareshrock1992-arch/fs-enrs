import { useEffect, useState, useRef } from 'react';
import { Plus, Pencil, Trash2, Upload, CheckCircle2, XCircle } from 'lucide-react';
import { api } from '../../api/client.js';
import Modal from '../../components/ui/Modal.jsx';
import { Table, Th, Td, Tr, EmptyRow } from '../../components/ui/Table.jsx';

const EMPTY = { organization_id: '', first_name: '', last_name: '', mobile_number: '', extension_number: '', email: '', role: '', department_id: '' };

export default function ContactList() {
  const [rows,     setRows]     = useState([]);
  const [orgs,     setOrgs]     = useState([]);
  const [orgFilter,setOrgFilter]= useState('');
  const [modal,    setModal]    = useState(null);
  const [form,     setForm]     = useState(EMPTY);
  const [saving,   setSaving]   = useState(false);
  const [error,    setError]    = useState('');
  const [csvModal, setCsvModal] = useState(false);
  const [csvOrg,   setCsvOrg]   = useState('');
  const [csvResult,setCsvResult]= useState(null);
  const [uploading,setUploading]= useState(false);
  const fileRef = useRef();

  async function load() {
    try {
      const [c, o] = await Promise.all([
        api.contacts.list(orgFilter ? { organization_id: orgFilter } : {}),
        api.orgs.list(),
      ]);
      setRows(c.contacts || []);
      setOrgs(o.organizations || []);
    } catch {}
  }
  useEffect(() => { load(); }, [orgFilter]);

  const f = (k, v) => setForm(p => ({ ...p, [k]: v }));

  async function handleSave() {
    setSaving(true); setError('');
    try {
      const payload = {
        organization_id:  Number(form.organization_id) || undefined,
        first_name:       form.first_name,
        last_name:        form.last_name,
        mobile_number:    form.mobile_number,
        extension_number: form.extension_number || null,
        email:            form.email            || null,
        role:             form.role             || null,
        department_id:    form.department_id ? Number(form.department_id) : null,
      };
      if (!modal.id) await api.contacts.create(payload);
      else           await api.contacts.update(modal.id, payload);
      setModal(null); load();
    } catch (e) { setError(e.message); } finally { setSaving(false); }
  }

  function openCreate() { setForm(EMPTY); setModal({}); setError(''); }
  function openEdit(r) {
    setForm({
      organization_id: r.organization_id, first_name: r.first_name || '',
      last_name: r.last_name || '', mobile_number: r.mobile_number || '',
      extension_number: r.extension_number || '',
      email: r.email || '', role: r.role || '', department_id: r.department_id || '',
    });
    setModal(r); setError('');
  }

  async function del(r) {
    if (!confirm(`Delete contact "${r.first_name} ${r.last_name}"?`)) return;
    try { await api.contacts.remove(r.id); load(); } catch (e) { alert(e.message); }
  }

  async function handleCsvUpload() {
    const file = fileRef.current?.files?.[0];
    if (!file || !csvOrg) return;
    setUploading(true); setCsvResult(null);
    try {
      const result = await api.contacts.bulkUpload(csvOrg, file);
      setCsvResult(result);
      load();
    } catch (e) { setCsvResult({ error: e.message }); } finally { setUploading(false); }
  }

  const orgName = id => orgs.find(o => o.id === id)?.name || '—';

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2 justify-between">
        <h1 className="text-xl font-bold text-text-primary">Emergency Contacts</h1>
        <div className="flex items-center gap-2">
          <select className="input py-1.5 text-sm w-44" value={orgFilter}
                  onChange={e => setOrgFilter(e.target.value)}>
            <option value="">All Organizations</option>
            {orgs.map(o => <option key={o.id} value={o.id}>{o.name}</option>)}
          </select>
          <button onClick={() => { setCsvModal(true); setCsvResult(null); setCsvOrg(''); }}
                  className="btn-secondary flex items-center gap-1.5">
            <Upload size={14} /> CSV Upload
          </button>
          <button onClick={openCreate} className="btn-primary flex items-center gap-1.5">
            <Plus size={15} /> Add Contact
          </button>
        </div>
      </div>

      <Table>
        <thead><tr className="bg-surface-hover">
          <Th>Name</Th><Th>Mobile</Th><Th>Role</Th><Th>Organization</Th><Th></Th>
        </tr></thead>
        <tbody>
          {rows.length === 0 ? <EmptyRow cols={5} /> : rows.map(r => (
            <Tr key={r.id}>
              <Td className="font-medium">{r.first_name} {r.last_name}</Td>
              <Td className="text-text-muted font-mono text-xs">{r.mobile_number || '—'}</Td>
              <Td className="text-text-muted text-xs">{r.role || '—'}</Td>
              <Td className="text-text-muted">{orgName(r.organization_id)}</Td>
              <Td>
                <div className="flex gap-1 justify-end">
                  <button onClick={() => openEdit(r)} className="btn-ghost p-1.5"><Pencil size={13} /></button>
                  <button onClick={() => del(r)} className="btn-ghost p-1.5 text-red-500"><Trash2 size={13} /></button>
                </div>
              </Td>
            </Tr>
          ))}
        </tbody>
      </Table>

      {/* Add/Edit Modal */}
      {modal && (
        <Modal title={modal.id ? 'Edit Contact' : 'Add Contact'} onClose={() => setModal(null)}>
          <div className="space-y-3">
            <div>
              <label className="label">Organization</label>
              <select className="input" value={form.organization_id} onChange={e => f('organization_id', Number(e.target.value) || '')}>
                <option value="">Select…</option>
                {orgs.map(o => <option key={o.id} value={o.id}>{o.name}</option>)}
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
            {error && <p className="text-sm text-red-500">{error}</p>}
            <div className="flex gap-2 justify-end pt-2">
              <button onClick={() => setModal(null)} className="btn-secondary">Cancel</button>
              <button onClick={handleSave} disabled={saving} className="btn-primary">{saving ? 'Saving…' : 'Save'}</button>
            </div>
          </div>
        </Modal>
      )}

      {/* CSV Upload Modal */}
      {csvModal && (
        <Modal title="Bulk Upload Contacts" onClose={() => setCsvModal(false)}>
          <div className="space-y-4">
            <p className="text-sm text-text-muted">
              Upload a CSV with columns: <code className="bg-surface-hover px-1 rounded text-xs">
              first_name, last_name, phone, email, pin</code>
            </p>
            <div>
              <label className="label">Organization</label>
              <select className="input" value={csvOrg} onChange={e => setCsvOrg(e.target.value)}>
                <option value="">Select…</option>
                {orgs.map(o => <option key={o.id} value={o.id}>{o.name}</option>)}
              </select>
            </div>
            <div>
              <label className="label">CSV File</label>
              <input ref={fileRef} type="file" accept=".csv" className="input" />
            </div>

            {csvResult && !csvResult.error && (
              <div className="rounded-lg border border-surface-border p-3 text-sm space-y-1">
                <p className="flex items-center gap-2 text-green-500">
                  <CheckCircle2 size={14} /> {csvResult.inserted} of {csvResult.total} rows inserted
                </p>
                {csvResult.errors?.length > 0 && (
                  <details className="text-xs text-text-muted mt-2">
                    <summary className="cursor-pointer">{csvResult.errors.length} errors</summary>
                    <ul className="mt-1 space-y-0.5 list-disc list-inside">
                      {csvResult.errors.map((e, i) => <li key={i}>{e}</li>)}
                    </ul>
                  </details>
                )}
              </div>
            )}
            {csvResult?.error && (
              <p className="text-sm text-red-500 flex items-center gap-2">
                <XCircle size={14} /> {csvResult.error}
              </p>
            )}

            <div className="flex gap-2 justify-end">
              <button onClick={() => setCsvModal(false)} className="btn-secondary">Close</button>
              <button onClick={handleCsvUpload} disabled={uploading || !csvOrg} className="btn-primary">
                {uploading ? 'Uploading…' : 'Upload'}
              </button>
            </div>
          </div>
        </Modal>
      )}
    </div>
  );
}
