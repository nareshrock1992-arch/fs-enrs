import { useEffect, useState } from 'react';
import { Plus, Pencil, Trash2 } from 'lucide-react';
import { api } from '../../api/client.js';
import { useAuthStore } from '../../store/authStore.js';
import Modal from '../../components/ui/Modal.jsx';
import { Table, Th, Td, Tr, EmptyRow } from '../../components/ui/Table.jsx';
import { StatusBadge } from '../../components/ui/Badge.jsx';
import PageHeader from '../../components/ui/PageHeader.jsx';

const TENANT_ROLES = ['ADMIN', 'SUPERVISOR', 'OPERATOR', 'VIEWER'];
const ALL_ROLES    = ['SUPER_ADMIN', ...TENANT_ROLES];

const EMPTY = { email: '', full_name: '', password: '', role: 'VIEWER', tenant_id: '' };

export default function UserList() {
  const currentUser    = useAuthStore(s => s.user);
  const activeTenantId = useAuthStore(s => s.activeTenantId);
  const isSuperAdmin = currentUser?.role === 'SUPER_ADMIN';

  const [users,    setUsers]   = useState([]);
  const [tenants,  setTenants] = useState([]);
  const [filter,   setFilter]  = useState('');  // tenant_id filter for SUPER_ADMIN
  const [modal,    setModal]   = useState(null);
  const [form,     setForm]    = useState(EMPTY);
  const [saving,   setSaving]  = useState(false);
  const [error,    setError]   = useState('');

  async function load() {
    try {
      const params = isSuperAdmin && filter ? { tenant_id: filter } : {};
      setUsers((await api.users.list(params)).users || []);
    } catch {}
  }

  useEffect(() => {
    setModal(null); setFilter('');
    load();
    if (isSuperAdmin) {
      api.tenants.list().then(d => setTenants(d.tenants || [])).catch(() => {});
    }
  }, [activeTenantId]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => { load(); }, [filter]); // eslint-disable-line react-hooks/exhaustive-deps

  function openCreate() { setForm({ ...EMPTY }); setModal('create'); setError(''); }
  function openEdit(u)  {
    setForm({
      email:     u.email,
      full_name: u.full_name || '',
      password:  '',
      role:      u.role,
      tenant_id: u.tenant_id || '',
    });
    setModal(u);
    setError('');
  }

  async function handleSave() {
    setSaving(true); setError('');
    try {
      const d = { ...form };
      if (!d.password) delete d.password;
      if (!isSuperAdmin) delete d.tenant_id;
      if (d.tenant_id === '' || d.tenant_id == null) delete d.tenant_id;

      if (modal === 'create') {
        await api.users.create(d);
      } else {
        await api.users.update(modal.id, d);
      }
      setModal(null);
      load();
    } catch (e) {
      const issues = e.data?.issues;
      if (issues?.length) {
        setError(issues.map(i => (i.path ? `${i.path}: ` : '') + i.message).join(' · '));
      } else {
        setError(e.message);
      }
    } finally { setSaving(false); }
  }

  async function handleDelete(u) {
    if (!confirm(`Delete user ${u.email}?`)) return;
    try { await api.users.remove(u.id); load(); } catch (e) { alert(e.message); }
  }

  const f = (k, v) => setForm(p => ({ ...p, [k]: v }));
  const roles = isSuperAdmin ? ALL_ROLES : TENANT_ROLES;

  const tenantName = (id) => tenants.find(t => t.id === id)?.name || id;

  return (
    <div className="space-y-6">
      <PageHeader title="User Management">
        {isSuperAdmin && (
          <select
            className="input text-sm mr-2"
            value={filter}
            onChange={e => setFilter(e.target.value)}
          >
            <option value="">All Tenants</option>
            {tenants.map(t => <option key={t.id} value={t.id}>{t.name}</option>)}
          </select>
        )}
        <button onClick={openCreate} className="btn-primary">
          <Plus size={15} /> Add User
        </button>
      </PageHeader>

      <Table>
        <thead>
          <tr>
            <Th>Email</Th>
            <Th>Name</Th>
            <Th>Role</Th>
            {isSuperAdmin && <Th>Tenant</Th>}
            <Th>Last Login</Th>
            <Th></Th>
          </tr>
        </thead>
        <tbody>
          {users.length === 0 ? <EmptyRow cols={isSuperAdmin ? 6 : 5} /> : users.map(u => (
            <Tr key={u.id}>
              <Td>{u.email}</Td>
              <Td className="text-text-muted">{u.full_name || '—'}</Td>
              <Td><StatusBadge status={u.role} /></Td>
              {isSuperAdmin && (
                <Td className="text-text-muted text-xs">
                  {u.tenant_id ? (u.tenant_name || tenantName(u.tenant_id)) : <span className="italic">Platform</span>}
                </Td>
              )}
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
                {roles.map(r => <option key={r}>{r}</option>)}
              </select>
            </div>
            {isSuperAdmin && form.role !== 'SUPER_ADMIN' && (
              <div>
                <label className="label">Tenant</label>
                <select className="input" value={form.tenant_id || ''} onChange={e => f('tenant_id', e.target.value)}>
                  <option value="">— Select tenant —</option>
                  {tenants.map(t => <option key={t.id} value={t.id}>{t.name}</option>)}
                </select>
              </div>
            )}
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
