import { useEffect, useState } from 'react';
import { Plus, Pencil, Trash2 } from 'lucide-react';
import { api } from '../../api/client.js';
import Modal from '../../components/ui/Modal.jsx';
import { Table, Th, Td, Tr, EmptyRow } from '../../components/ui/Table.jsx';

const EMPTY = { name: '', code: '', address: '', phone: '', email: '' };

export default function OrgList() {
  const [rows,   setRows]   = useState([]);
  const [modal,  setModal]  = useState(null);
  const [form,   setForm]   = useState(EMPTY);
  const [saving, setSaving] = useState(false);
  const [error,  setError]  = useState('');

  async function load() {
    try { setRows((await api.orgs.list()).organizations || []); } catch {}
  }
  useEffect(() => { load(); }, []);

  const f = (k, v) => setForm(p => ({ ...p, [k]: v }));

  async function handleSave() {
    setSaving(true); setError('');
    try {
      if (!modal.id) await api.orgs.create(form);
      else           await api.orgs.update(modal.id, form);
      setModal(null); load();
    } catch (e) { setError(e.message); } finally { setSaving(false); }
  }

  function openCreate() { setForm(EMPTY); setModal({}); setError(''); }
  function openEdit(r)  { setForm({ name: r.name, code: r.code || '', address: r.address || '', phone: r.phone || '', email: r.email || '' }); setModal(r); setError(''); }

  async function del(r) {
    if (!confirm(`Delete org "${r.name}"?`)) return;
    try { await api.orgs.remove(r.id); load(); } catch (e) { alert(e.message); }
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-bold text-text-primary">Organizations</h1>
        <button onClick={openCreate} className="btn-primary flex items-center gap-1.5">
          <Plus size={15} /> Add Organization
        </button>
      </div>

      <Table>
        <thead><tr className="bg-surface-hover">
          <Th>Name</Th><Th>Code</Th><Th>Phone</Th><Th>Contacts</Th><Th></Th>
        </tr></thead>
        <tbody>
          {rows.length === 0 ? <EmptyRow cols={5} /> : rows.map(r => (
            <Tr key={r.id}>
              <Td className="font-medium">{r.name}</Td>
              <Td className="text-text-muted font-mono text-xs">{r.code || '—'}</Td>
              <Td className="text-text-muted">{r.phone || '—'}</Td>
              <Td>{r.contact_count ?? 0}</Td>
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
        <Modal title={modal.id ? 'Edit Organization' : 'Create Organization'} onClose={() => setModal(null)}>
          <div className="space-y-3">
            {[['name','Name','text'],['code','Code','text'],['address','Address','text'],['phone','Phone','tel'],['email','Email','email']].map(([k,l,t]) => (
              <div key={k}>
                <label className="label">{l}</label>
                <input className="input" type={t} value={form[k]} onChange={e => f(k, e.target.value)} />
              </div>
            ))}
            {error && <p className="text-sm text-red-500">{error}</p>}
            <div className="flex gap-2 justify-end pt-2">
              <button onClick={() => setModal(null)} className="btn-secondary">Cancel</button>
              <button onClick={handleSave} disabled={saving} className="btn-primary">
                {saving ? 'Saving…' : 'Save'}
              </button>
            </div>
          </div>
        </Modal>
      )}
    </div>
  );
}
