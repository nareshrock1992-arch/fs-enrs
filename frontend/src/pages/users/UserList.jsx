import { useEffect, useState } from 'react';
import { Plus, Pencil, Trash2 } from 'lucide-react';
import { api } from '../../api/client.js';
import Modal from '../../components/ui/Modal.jsx';
import { Table, Th, Td, Tr, EmptyRow } from '../../components/ui/Table.jsx';
import { StatusBadge } from '../../components/ui/Badge.jsx';

const ROLES = ['ADMIN', 'OPERATOR', 'VIEWER'];

const EMPTY = { email: '', full_name: '', password: '', role: 'VIEWER' };

export default function UserList() {
  const [users,   setUsers]   = useState([]);
  const [modal,   setModal]   = useState(null); // null | 'create' | user obj
  const [form,    setForm]    = useState(EMPTY);
  const [saving,  setSaving]  = useState(false);
  const [error,   setError]   = useState('');

  async function load() {
    try { setUsers((await api.users.list()).users || []); } catch {}
  }
  useEffect(() => { load(); }, []);

  function openCreate() { setForm(EMPTY); setModal('create'); setError(''); }
  function openEdit(u)  { setForm({ email: u.email, full_name: u.full_name || '', password: '', role: u.role }); setModal(u); setError(''); }

  async function handleSave() {
    setSaving(true); setError('');
    try {
      if (modal === 'create') {
        await api.users.create(form);
      } else {
        const d = { ...form };
        if (!d.password) delete d.password;
        await api.users.update(modal.id, d);
      }
      setModal(null);
      load();
    } catch (e) { setError(e.message); } finally { setSaving(false); }
  }

  async function handleDelete(u) {
    if (!confirm(`Delete user ${u.email}?`)) return;
    try { await api.users.remove(u.id); load(); } catch (e) { alert(e.message); }
  }

  const f = (k, v) => setForm(p => ({ ...p, [k]: v }));

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-bold text-text-primary">User Management</h1>
        <button onClick={openCreate} className="btn-primary flex items-center gap-1.5">
          <Plus size={15} /> Add User
        </button>
      </div>

      <Table>
        <thead>
          <tr className="bg-surface-hover">
            <Th>Email</Th><Th>Name</Th><Th>Role</Th><Th>Last Login</Th><Th></Th>
          </tr>
        </thead>
        <tbody>
          {users.length === 0 ? <EmptyRow cols={5} /> : users.map(u => (
            <Tr key={u.id}>
              <Td>{u.email}</Td>
              <Td className="text-text-muted">{u.full_name || '—'}</Td>
              <Td><StatusBadge status={u.role} /></Td>
              <Td className="text-text-muted text-xs">
                {u.last_login_at ? new Date(u.last_login_at).toLocaleDateString() : 'Never'}
              </Td>
              <Td>
                <div className="flex items-center gap-1 justify-end">
                  <button onClick={() => openEdit(u)} className="btn-ghost p-1.5"><Pencil size={13} /></button>
                  <button onClick={() => handleDelete(u)} className="btn-ghost p-1.5 text-red-500"><Trash2 size={13} /></button>
                </div>
              </Td>
            </Tr>
          ))}
        </tbody>
      </Table>

      {modal && (
        <Modal title={modal === 'create' ? 'Create User' : 'Edit User'} onClose={() => setModal(null)}>
          <div className="space-y-3">
            <div>
              <label className="label">Email</label>
              <input className="input" type="email" value={form.email}
                     onChange={e => f('email', e.target.value)} />
            </div>
            <div>
              <label className="label">Full Name</label>
              <input className="input" value={form.full_name}
                     onChange={e => f('full_name', e.target.value)} />
            </div>
            <div>
              <label className="label">{modal === 'create' ? 'Password' : 'New Password (leave blank to keep)'}</label>
              <input className="input" type="password" value={form.password}
                     onChange={e => f('password', e.target.value)} />
            </div>
            <div>
              <label className="label">Role</label>
              <select className="input" value={form.role} onChange={e => f('role', e.target.value)}>
                {ROLES.map(r => <option key={r}>{r}</option>)}
              </select>
            </div>
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
