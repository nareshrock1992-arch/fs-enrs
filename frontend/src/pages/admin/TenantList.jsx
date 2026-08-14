import { useEffect, useState } from 'react';
import { api } from '../../api/client.js';

const EMPTY = { name: '', code: '', is_active: true };

export default function TenantList() {
  const [tenants, setTenants] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError]     = useState(null);
  const [modal, setModal]     = useState(null); // null | { mode: 'create'|'edit', data }
  const [saving, setSaving]   = useState(false);

  async function load() {
    try {
      setLoading(true);
      const d = await api.tenants.list();
      setTenants(d.tenants || []);
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { load(); }, []);

  async function save(form) {
    setSaving(true);
    try {
      if (modal.mode === 'create') {
        await api.tenants.create(form);
      } else {
        await api.tenants.update(modal.data.id, form);
      }
      setModal(null);
      await load();
    } catch (e) {
      alert(e.message);
    } finally {
      setSaving(false);
    }
  }

  async function toggle(tenant) {
    try {
      await api.tenants.update(tenant.id, { is_active: !tenant.is_active });
      await load();
    } catch (e) {
      alert(e.message);
    }
  }

  if (loading) return <div className="p-6 text-text-secondary">Loading…</div>;
  if (error)   return <div className="p-6 text-red-500">{error}</div>;

  return (
    <div className="p-6">
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-xl font-semibold text-text-primary">Tenant Management</h1>
        <button
          onClick={() => setModal({ mode: 'create', data: { ...EMPTY } })}
          className="btn-primary px-4 py-2 text-sm"
        >
          + New Tenant
        </button>
      </div>

      <div className="overflow-x-auto rounded-lg border border-surface-border">
        <table className="w-full text-sm">
          <thead className="bg-surface-panel border-b border-surface-border">
            <tr>
              {['Name', 'Code', 'Users', 'Orgs', 'Status', 'Actions'].map(h => (
                <th key={h} className="px-4 py-3 text-left text-xs font-semibold text-text-secondary uppercase tracking-wide">{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {tenants.map(t => (
              <tr key={t.id} className="border-b border-surface-border hover:bg-surface-panel/50">
                <td className="px-4 py-3 font-medium text-text-primary">{t.name}</td>
                <td className="px-4 py-3 font-mono text-text-secondary">{t.code}</td>
                <td className="px-4 py-3 tabular-nums text-text-secondary">{t.user_count ?? 0}</td>
                <td className="px-4 py-3 tabular-nums text-text-secondary">{t.org_count ?? 0}</td>
                <td className="px-4 py-3">
                  <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium ${
                    t.is_active ? 'bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-400'
                                : 'bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-400'
                  }`}>
                    {t.is_active ? 'Active' : 'Inactive'}
                  </span>
                </td>
                <td className="px-4 py-3">
                  <div className="flex gap-2">
                    <button
                      onClick={() => setModal({ mode: 'edit', data: { ...t } })}
                      className="text-xs text-brand hover:underline"
                    >Edit</button>
                    <button
                      onClick={() => toggle(t)}
                      className="text-xs text-text-secondary hover:underline"
                    >{t.is_active ? 'Deactivate' : 'Activate'}</button>
                  </div>
                </td>
              </tr>
            ))}
            {tenants.length === 0 && (
              <tr>
                <td colSpan={6} className="px-4 py-8 text-center text-text-secondary">No tenants yet.</td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {modal && (
        <TenantModal
          mode={modal.mode}
          initial={modal.data}
          onSave={save}
          onClose={() => setModal(null)}
          saving={saving}
        />
      )}
    </div>
  );
}

function TenantModal({ mode, initial, onSave, onClose, saving }) {
  const [form, setForm] = useState({ ...initial });
  const set = (k, v) => setForm(f => ({ ...f, [k]: v }));

  return (
    <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50">
      <div className="bg-surface rounded-xl shadow-xl w-full max-w-md p-6">
        <h2 className="text-lg font-semibold text-text-primary mb-4">
          {mode === 'create' ? 'New Tenant' : 'Edit Tenant'}
        </h2>

        <div className="space-y-4">
          <Field label="Name" required>
            <input className="form-input w-full" value={form.name || ''} onChange={e => set('name', e.target.value)} />
          </Field>
          <Field label="Code" required hint="Unique short identifier (e.g. ACME)">
            <input className="form-input w-full font-mono" value={form.code || ''} onChange={e => set('code', e.target.value.toUpperCase())} disabled={mode === 'edit'} />
          </Field>
          {mode === 'edit' && (
            <label className="flex items-center gap-2 cursor-pointer">
              <input type="checkbox" checked={!!form.is_active} onChange={e => set('is_active', e.target.checked)} />
              <span className="text-sm text-text-primary">Active</span>
            </label>
          )}
        </div>

        <div className="flex justify-end gap-3 mt-6">
          <button onClick={onClose} className="btn-secondary px-4 py-2 text-sm" disabled={saving}>Cancel</button>
          <button onClick={() => onSave(form)} className="btn-primary px-4 py-2 text-sm" disabled={saving}>
            {saving ? 'Saving…' : 'Save'}
          </button>
        </div>
      </div>
    </div>
  );
}

function Field({ label, required, hint, children }) {
  return (
    <div>
      <label className="block text-sm font-medium text-text-primary mb-1">
        {label}{required && <span className="text-red-500 ml-0.5">*</span>}
      </label>
      {children}
      {hint && <p className="text-xs text-text-secondary mt-1">{hint}</p>}
    </div>
  );
}
