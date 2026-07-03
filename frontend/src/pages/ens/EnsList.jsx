import { useEffect, useState } from 'react';
import { Plus, Pencil, Trash2, ToggleLeft, ToggleRight, Bell } from 'lucide-react';
import { api } from '../../api/client.js';
import Modal from '../../components/ui/Modal.jsx';
import { Table, Th, Td, Tr, EmptyRow } from '../../components/ui/Table.jsx';
import Badge from '../../components/ui/Badge.jsx';

const EMPTY = { organization_id: '', name: '', pin: '', conference_profile: 'default', audio_file: '', max_duration: 3600, group_ids: [], contact_ids: [] };

export default function EnsList() {
  const [rows,  setRows]  = useState([]);
  const [orgs,  setOrgs]  = useState([]);
  const [groups,setGroups]= useState([]);
  const [modal, setModal] = useState(null);
  const [form,  setForm]  = useState(EMPTY);
  const [saving,setSaving]= useState(false);
  const [error, setError] = useState('');

  async function load() {
    try {
      const [e, o, g] = await Promise.all([api.ens.list(), api.orgs.list(), api.groups.list()]);
      setRows(e.configurations || []);
      setOrgs(o.organizations || []);
      setGroups(g.groups || []);
    } catch {}
  }
  useEffect(() => { load(); }, []);

  const f = (k, v) => setForm(p => ({ ...p, [k]: v }));

  async function handleSave() {
    setSaving(true); setError('');
    try {
      const payload = { ...form, max_duration: Number(form.max_duration) };
      if (!modal.id) await api.ens.create(payload);
      else           await api.ens.update(modal.id, payload);
      setModal(null); load();
    } catch (e) { setError(e.message); } finally { setSaving(false); }
  }

  function openCreate() { setForm(EMPTY); setModal({}); setError(''); }
  function openEdit(r) {
    setForm({
      organization_id: r.organization_id, name: r.name, pin: r.pin || '',
      conference_profile: r.conference_profile || 'default',
      audio_file: r.audio_file || '', max_duration: r.max_duration || 3600,
      group_ids: (r.groups || []).map(g => g.id),
      contact_ids: (r.contacts || []).map(c => c.id),
    });
    setModal(r); setError('');
  }

  async function del(r) {
    if (!confirm(`Delete ENS configuration "${r.name}"?`)) return;
    try { await api.ens.remove(r.id); load(); } catch (e) { alert(e.message); }
  }

  async function toggle(r) {
    try { await api.ens.toggle(r.id); load(); } catch (e) { alert(e.message); }
  }

  const orgName = id => orgs.find(o => o.id === id)?.name || '—';
  const orgGroups = oid => groups.filter(g => g.organization_id === oid);

  const selGroup = e => {
    const vals = [...e.target.selectedOptions].map(o => o.value);
    f('group_ids', vals);
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-bold text-text-primary">ENS Configurations</h1>
        <button onClick={openCreate} className="btn-primary flex items-center gap-1.5"><Plus size={15} /> Add ENS</button>
      </div>

      <Table>
        <thead><tr className="bg-surface-hover">
          <Th>Name</Th><Th>PIN</Th><Th>Organization</Th><Th>Status</Th><Th></Th>
        </tr></thead>
        <tbody>
          {rows.length === 0 ? <EmptyRow cols={5} /> : rows.map(r => (
            <Tr key={r.id}>
              <Td className="font-medium">{r.name}</Td>
              <Td className="font-mono text-xs text-text-muted">{r.pin || '—'}</Td>
              <Td className="text-text-muted">{orgName(r.organization_id)}</Td>
              <Td><Badge variant={r.is_active ? 'success' : 'default'}>{r.is_active ? 'Active' : 'Inactive'}</Badge></Td>
              <Td>
                <div className="flex gap-1 justify-end">
                  <button onClick={() => toggle(r)} className="btn-ghost p-1.5" title="Toggle">
                    {r.is_active ? <ToggleRight size={14} className="text-green-500" /> : <ToggleLeft size={14} />}
                  </button>
                  <button onClick={() => openEdit(r)} className="btn-ghost p-1.5"><Pencil size={13} /></button>
                  <button onClick={() => del(r)} className="btn-ghost p-1.5 text-red-500"><Trash2 size={13} /></button>
                </div>
              </Td>
            </Tr>
          ))}
        </tbody>
      </Table>

      {modal && (
        <Modal title={modal.id ? 'Edit ENS Configuration' : 'Create ENS Configuration'} size="lg" onClose={() => setModal(null)}>
          <div className="space-y-3">
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="label">Organization</label>
                <select className="input" value={form.organization_id} onChange={e => f('organization_id', e.target.value)}>
                  <option value="">Select…</option>
                  {orgs.map(o => <option key={o.id} value={o.id}>{o.name}</option>)}
                </select>
              </div>
              <div><label className="label">PIN</label>
                <input className="input" value={form.pin} onChange={e => f('pin', e.target.value)} placeholder="e.g. 1234" /></div>
            </div>
            <div><label className="label">Name</label>
              <input className="input" value={form.name} onChange={e => f('name', e.target.value)} /></div>
            <div className="grid grid-cols-2 gap-3">
              <div><label className="label">Conference Profile</label>
                <input className="input" value={form.conference_profile} onChange={e => f('conference_profile', e.target.value)} placeholder="default" /></div>
              <div><label className="label">Max Duration (s)</label>
                <input className="input" type="number" value={form.max_duration} onChange={e => f('max_duration', e.target.value)} /></div>
            </div>
            <div><label className="label">Audio File Path</label>
              <input className="input" value={form.audio_file} onChange={e => f('audio_file', e.target.value)} placeholder="/var/lib/freeswitch/sounds/…" /></div>
            <div>
              <label className="label">Responder Groups (multi-select)</label>
              <select multiple className="input h-28 text-sm" value={form.group_ids} onChange={selGroup}>
                {orgGroups(form.organization_id).map(g => (
                  <option key={g.id} value={g.id}>{g.name}</option>
                ))}
              </select>
            </div>
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
