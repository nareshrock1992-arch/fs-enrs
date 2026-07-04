import { useEffect, useState } from 'react';
import { Plus, Pencil, Trash2, Users } from 'lucide-react';
import { api } from '../../api/client.js';
import Modal from '../../components/ui/Modal.jsx';
import { Table, Th, Td, Tr, EmptyRow } from '../../components/ui/Table.jsx';

const EMPTY = { organization_id: '', name: '', description: '' };

export default function GroupList() {
  const [rows,  setRows]  = useState([]);
  const [orgs,  setOrgs]  = useState([]);
  const [modal, setModal] = useState(null);
  const [form,  setForm]  = useState(EMPTY);
  const [saving,setSaving]= useState(false);
  const [error, setError] = useState('');
  const [membersModal, setMembersModal] = useState(null); // group obj
  const [contacts, setContacts] = useState([]);
  const [members,  setMembers]  = useState([]);
  const [selIds,   setSelIds]   = useState([]);

  async function load() {
    try {
      const [g, o] = await Promise.all([api.groups.list(), api.orgs.list()]);
      setRows(g.groups || []);
      setOrgs(o.organizations || []);
    } catch {}
  }
  useEffect(() => { load(); }, []);

  const f = (k, v) => setForm(p => ({ ...p, [k]: v }));

  async function handleSave() {
    setSaving(true); setError('');
    try {
      const payload = {
        organization_id: Number(form.organization_id) || undefined,
        name:            form.name,
        description:     form.description || null,
      };
      if (!modal.id) await api.groups.create(payload);
      else           await api.groups.update(modal.id, payload);
      setModal(null); load();
    } catch (e) { setError(e.message); } finally { setSaving(false); }
  }

  function openCreate() { setForm(EMPTY); setModal({}); setError(''); }
  function openEdit(r) {
    setForm({ organization_id: r.organization_id, name: r.name, description: r.description || '' });
    setModal(r); setError('');
  }

  async function del(r) {
    if (!confirm(`Delete group "${r.name}"?`)) return;
    try { await api.groups.remove(r.id); load(); } catch (e) { alert(e.message); }
  }

  async function openMembers(g) {
    const [gr, c] = await Promise.all([api.groups.get(g.id), api.contacts.list({ organization_id: g.organization_id })]);
    setMembers(gr.members || []);
    setContacts(c.contacts || []);
    setSelIds([]);
    setMembersModal(g);
  }

  async function addMembers() {
    if (!selIds.length) return;
    await api.groups.addMembers(membersModal.id, selIds.map(Number));
    openMembers(membersModal);
  }

  async function removeMember(cid) {
    await api.groups.removeMember(membersModal.id, cid);
    openMembers(membersModal);
  }

  const orgName = id => orgs.find(o => o.id === id)?.name || '—';
  const memberIds = new Set(members.map(m => m.id));
  const nonMembers = contacts.filter(c => !memberIds.has(c.id));

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-bold text-text-primary">Responder Groups</h1>
        <button onClick={openCreate} className="btn-primary flex items-center gap-1.5"><Plus size={15} /> Add Group</button>
      </div>

      <Table>
        <thead><tr className="bg-surface-hover">
          <Th>Name</Th><Th>Organization</Th><Th>Members</Th><Th></Th>
        </tr></thead>
        <tbody>
          {rows.length === 0 ? <EmptyRow cols={4} /> : rows.map(r => (
            <Tr key={r.id}>
              <Td className="font-medium">{r.name}</Td>
              <Td className="text-text-muted">{orgName(r.organization_id)}</Td>
              <Td>{r.member_count ?? 0}</Td>
              <Td>
                <div className="flex gap-1 justify-end">
                  <button onClick={() => openMembers(r)} className="btn-ghost p-1.5" title="Manage members"><Users size={13} /></button>
                  <button onClick={() => openEdit(r)} className="btn-ghost p-1.5"><Pencil size={13} /></button>
                  <button onClick={() => del(r)} className="btn-ghost p-1.5 text-red-500"><Trash2 size={13} /></button>
                </div>
              </Td>
            </Tr>
          ))}
        </tbody>
      </Table>

      {modal && (
        <Modal title={modal.id ? 'Edit Group' : 'Create Group'} onClose={() => setModal(null)}>
          <div className="space-y-3">
            <div>
              <label className="label">Organization</label>
              <select className="input" value={form.organization_id} onChange={e => f('organization_id', Number(e.target.value) || '')}>
                <option value="">Select…</option>
                {orgs.map(o => <option key={o.id} value={o.id}>{o.name}</option>)}
              </select>
            </div>
            <div><label className="label">Name</label>
              <input className="input" value={form.name} onChange={e => f('name', e.target.value)} /></div>
            <div><label className="label">Description</label>
              <textarea className="input" rows={2} value={form.description} onChange={e => f('description', e.target.value)} /></div>
            {error && <p className="text-sm text-red-500">{error}</p>}
            <div className="flex gap-2 justify-end pt-2">
              <button onClick={() => setModal(null)} className="btn-secondary">Cancel</button>
              <button onClick={handleSave} disabled={saving} className="btn-primary">{saving ? 'Saving…' : 'Save'}</button>
            </div>
          </div>
        </Modal>
      )}

      {membersModal && (
        <Modal title={`Members — ${membersModal.name}`} size="lg" onClose={() => setMembersModal(null)}>
          <div className="grid grid-cols-2 gap-4">
            <div>
              <p className="text-xs font-semibold text-text-muted uppercase tracking-wide mb-2">Current Members</p>
              {members.length === 0
                ? <p className="text-xs text-text-muted">No members yet.</p>
                : members.map(m => (
                    <div key={m.id} className="flex items-center justify-between py-1.5 border-b border-surface-border last:border-0 text-sm">
                      <span>{m.first_name} {m.last_name}</span>
                      <button onClick={() => removeMember(m.id)} className="text-red-500 text-xs hover:underline">Remove</button>
                    </div>
                  ))
              }
            </div>
            <div>
              <p className="text-xs font-semibold text-text-muted uppercase tracking-wide mb-2">Add Members</p>
              <select multiple className="input h-40 text-sm" value={selIds}
                      onChange={e => setSelIds([...e.target.selectedOptions].map(o => o.value))}>
                {nonMembers.map(c => (
                  <option key={c.id} value={c.id}>{c.first_name} {c.last_name}</option>
                ))}
              </select>
              <button onClick={addMembers} disabled={!selIds.length} className="btn-primary mt-2 w-full text-sm">
                Add Selected
              </button>
            </div>
          </div>
        </Modal>
      )}
    </div>
  );
}
