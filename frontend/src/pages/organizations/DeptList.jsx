import { useEffect, useState } from 'react';
import { Plus, Pencil, Trash2 } from 'lucide-react';
import { api } from '../../api/client.js';
import Modal from '../../components/ui/Modal.jsx';
import { Table, Th, Td, Tr, EmptyRow } from '../../components/ui/Table.jsx';

const EMPTY = { organization_id: '', name: '', extension: '' };

export default function DeptList() {
  const [rows,  setRows]  = useState([]);
  const [orgs,  setOrgs]  = useState([]);
  const [modal, setModal] = useState(null);
  const [form,  setForm]  = useState(EMPTY);
  const [saving,setSaving]= useState(false);
  const [error, setError] = useState('');

  async function load() {
    try {
      const [d, o] = await Promise.all([api.departments.list(), api.orgs.list()]);
      setRows(d.departments || []);
      setOrgs(o.organizations || []);
    } catch {}
  }
  useEffect(() => { load(); }, []);

  const f = (k, v) => setForm(p => ({ ...p, [k]: v }));

  async function handleSave() {
    setSaving(true); setError('');
    try {
      if (!modal.id) await api.departments.create(form);
      else           await api.departments.update(modal.id, form);
      setModal(null); load();
    } catch (e) { setError(e.message); } finally { setSaving(false); }
  }

  function openCreate() { setForm(EMPTY); setModal({}); setError(''); }
  function openEdit(r)  {
    setForm({ organization_id: r.organization_id, name: r.name, extension: r.extension || '' });
    setModal(r); setError('');
  }

  async function del(r) {
    if (!confirm(`Delete department "${r.name}"?`)) return;
    try { await api.departments.remove(r.id); load(); } catch (e) { alert(e.message); }
  }

  const orgName = id => orgs.find(o => o.id === id)?.name || '—';

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-bold text-text-primary">Departments</h1>
        <button onClick={openCreate} className="btn-primary flex items-center gap-1.5"><Plus size={15} /> Add Department</button>
      </div>
      <Table>
        <thead><tr className="bg-surface-hover"><Th>Name</Th><Th>Organization</Th><Th>Extension</Th><Th></Th></tr></thead>
        <tbody>
          {rows.length === 0 ? <EmptyRow cols={4} /> : rows.map(r => (
            <Tr key={r.id}>
              <Td className="font-medium">{r.name}</Td>
              <Td className="text-text-muted">{orgName(r.organization_id)}</Td>
              <Td className="text-text-muted font-mono text-xs">{r.extension || '—'}</Td>
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

      {modal && (
        <Modal title={modal.id ? 'Edit Department' : 'Create Department'} onClose={() => setModal(null)}>
          <div className="space-y-3">
            <div>
              <label className="label">Organization</label>
              <select className="input" value={form.organization_id} onChange={e => f('organization_id', e.target.value)}>
                <option value="">Select…</option>
                {orgs.map(o => <option key={o.id} value={o.id}>{o.name}</option>)}
              </select>
            </div>
            <div><label className="label">Name</label>
              <input className="input" value={form.name} onChange={e => f('name', e.target.value)} /></div>
            <div><label className="label">Extension</label>
              <input className="input" value={form.extension} onChange={e => f('extension', e.target.value)} /></div>
            {error && <p className="text-sm text-red-500">{error}</p>}
            <div className="flex gap-2 justify-end pt-2">
              <button onClick={() => setModal(null)} className="btn-secondary">Cancel</button>
              <button onClick={handleSave} disabled={saving} className="btn-primary">{saving ? 'Saving…' : 'Save'}</button>
            </div>
          </div>
        </Modal>
      )}
    </div>
  );
}
