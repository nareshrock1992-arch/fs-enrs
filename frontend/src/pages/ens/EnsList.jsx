import { useEffect, useState, useMemo } from 'react';
import { Plus, Pencil, Trash2, ToggleLeft, ToggleRight, Users, User } from 'lucide-react';
import { api } from '../../api/client.js';
import Modal from '../../components/ui/Modal.jsx';
import { Table, Th, Td, Tr, EmptyRow } from '../../components/ui/Table.jsx';
import Badge from '../../components/ui/Badge.jsx';
import ContactPicker from '../../components/ui/ContactPicker.jsx';

const EMPTY = {
  organization_id: '', name: '',
  destination_number: '', blast_clid: '', reply_clid: '', pin: '',
  retry_count: 3, retry_delay_seconds: 60,
  recording_retention_hours: 24, max_concurrent: 50,
  group_ids: [], contact_ids: [],
};

export default function EnsList() {
  const [rows,     setRows]     = useState([]);
  const [orgs,     setOrgs]     = useState([]);
  const [groups,   setGroups]   = useState([]);
  const [contacts, setContacts] = useState([]);
  const [modal,    setModal]    = useState(null);
  const [form,     setForm]     = useState(EMPTY);
  const [saving,   setSaving]   = useState(false);
  const [error,    setError]    = useState('');

  async function load() {
    try {
      const [e, o, g, c] = await Promise.all([
        api.ens.list(),
        api.orgs.list(),
        api.groups.list(),
        api.contacts.list({ limit: 500 }),
      ]);
      setRows(e.configurations || []);
      setOrgs(o.organizations || []);
      setGroups(g.groups || []);
      setContacts(c.contacts || []);
    } catch {}
  }
  useEffect(() => { load(); }, []);

  const f = (k, v) => setForm(p => ({ ...p, [k]: v }));

  // Groups filtered to the selected org
  const orgGroups = useMemo(
    () => groups
      .filter(g => !form.organization_id || g.organization_id === Number(form.organization_id))
      .map(g => ({ ...g, member_count: g.member_count ?? g.members?.length ?? undefined })),
    [groups, form.organization_id]
  );

  const orgContacts = useMemo(
    () => contacts.filter(c => !form.organization_id || c.organization_id === Number(form.organization_id)),
    [contacts, form.organization_id]
  );

  async function handleSave() {
    setSaving(true); setError('');
    try {
      const payload = {
        ...form,
        organization_id:           Number(form.organization_id) || undefined,
        destination_number:        form.destination_number || null,
        blast_clid:                form.blast_clid         || null,
        reply_clid:                form.reply_clid         || null,
        pin:                       form.pin                || null,
        retry_count:               Number(form.retry_count),
        retry_delay_seconds:       Number(form.retry_delay_seconds),
        recording_retention_hours: Number(form.recording_retention_hours),
        max_concurrent:            Number(form.max_concurrent),
        group_ids:                 form.group_ids.map(Number),
        contact_ids:               form.contact_ids.map(Number),
      };
      if (!modal.id) await api.ens.create(payload);
      else           await api.ens.update(modal.id, payload);
      setModal(null); load();
    } catch (e) { setError(e.message); } finally { setSaving(false); }
  }

  function openCreate() { setForm(EMPTY); setModal({}); setError(''); }

  async function openEdit(r) {
    // Fetch full config (includes groups + contacts arrays)
    try {
      const full = await api.ens.get(r.id);
      setForm({
        organization_id:           full.organization_id,
        name:                      full.name,
        destination_number:        full.destination_number || '',
        blast_clid:                full.blast_clid || '',
        reply_clid:                full.reply_clid || '',
        pin:                       full.pin || '',
        retry_count:               full.retry_count ?? 3,
        retry_delay_seconds:       full.retry_delay_seconds ?? 60,
        recording_retention_hours: full.recording_retention_hours ?? 24,
        max_concurrent:            full.max_concurrent ?? 50,
        group_ids:                 (full.groups || []).map(g => g.id),
        contact_ids:               (full.contacts || []).map(c => c.id),
      });
    } catch {
      setForm({
        ...EMPTY,
        organization_id: r.organization_id,
        name: r.name,
      });
    }
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

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-bold text-text-primary">ENS Configurations</h1>
        <button onClick={openCreate} className="btn-primary flex items-center gap-1.5">
          <Plus size={15} /> Add ENS
        </button>
      </div>

      <Table>
        <thead><tr className="bg-surface-hover">
          <Th>Name</Th>
          <Th>Dest. Number</Th>
          <Th>Organization</Th>
          <Th>Contacts</Th>
          <Th>Status</Th>
          <Th></Th>
        </tr></thead>
        <tbody>
          {rows.length === 0 ? <EmptyRow cols={6} /> : rows.map(r => (
            <Tr key={r.id}>
              <Td className="font-medium">{r.name}</Td>
              <Td className="font-mono text-xs text-text-muted">{r.destination_number || '—'}</Td>
              <Td className="text-text-muted">{orgName(r.organization_id)}</Td>
              <Td>
                <div className="flex items-center gap-2 text-xs text-text-muted">
                  {r.group_count > 0 && (
                    <span className="flex items-center gap-1">
                      <Users size={11} /> {r.group_count} group{r.group_count !== 1 ? 's' : ''}
                    </span>
                  )}
                  {r.contact_count > 0 && (
                    <span className="flex items-center gap-1">
                      <User size={11} /> {r.contact_count}
                    </span>
                  )}
                  {!r.group_count && !r.contact_count && <span className="text-red-400">None mapped</span>}
                </div>
              </Td>
              <Td>
                <Badge variant={r.is_active ? 'success' : 'default'}>
                  {r.is_active ? 'Active' : 'Inactive'}
                </Badge>
              </Td>
              <Td>
                <div className="flex gap-1 justify-end">
                  <button onClick={() => toggle(r)} className="btn-ghost p-1.5" title="Toggle">
                    {r.is_active
                      ? <ToggleRight size={14} className="text-green-500" />
                      : <ToggleLeft  size={14} />}
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
        <Modal
          title={modal.id ? 'Edit ENS Configuration' : 'Create ENS Configuration'}
          size="xl"
          onClose={() => setModal(null)}
        >
          <div className="space-y-4">
            {/* Basic fields */}
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="label">Organization</label>
                <select className="input" value={form.organization_id}
                        onChange={e => { f('organization_id', Number(e.target.value) || ''); }}>
                  <option value="">Select…</option>
                  {orgs.map(o => <option key={o.id} value={o.id}>{o.name}</option>)}
                </select>
              </div>
              <div>
                <label className="label">Name</label>
                <input className="input" value={form.name} onChange={e => f('name', e.target.value)} />
              </div>
            </div>

            <div className="grid grid-cols-3 gap-3">
              <div>
                <label className="label">Destination Number</label>
                <input className="input" value={form.destination_number}
                       onChange={e => f('destination_number', e.target.value)}
                       placeholder="e.g. 1200" />
              </div>
              <div>
                <label className="label">Blast CLID</label>
                <input className="input" value={form.blast_clid}
                       onChange={e => f('blast_clid', e.target.value)}
                       placeholder="Caller ID for blast" />
              </div>
              <div>
                <label className="label">Reply CLID</label>
                <input className="input" value={form.reply_clid}
                       onChange={e => f('reply_clid', e.target.value)}
                       placeholder="Callback DID" />
              </div>
            </div>

            <div className="grid grid-cols-4 gap-3">
              <div>
                <label className="label">Retry Count</label>
                <input className="input" type="number" min="0" max="10"
                       value={form.retry_count} onChange={e => f('retry_count', e.target.value)} />
              </div>
              <div>
                <label className="label">Retry Delay (s)</label>
                <input className="input" type="number" min="0"
                       value={form.retry_delay_seconds} onChange={e => f('retry_delay_seconds', e.target.value)} />
              </div>
              <div>
                <label className="label">Retention (h)</label>
                <input className="input" type="number" min="1"
                       value={form.recording_retention_hours} onChange={e => f('recording_retention_hours', e.target.value)} />
              </div>
              <div>
                <label className="label">Max Concurrent</label>
                <input className="input" type="number" min="1"
                       value={form.max_concurrent} onChange={e => f('max_concurrent', e.target.value)} />
              </div>
            </div>

            <div>
              <label className="label">Auth PIN (optional)</label>
              <input className="input w-40" value={form.pin}
                     onChange={e => f('pin', e.target.value)}
                     placeholder="Leave blank to disable" type="password" maxLength={20} />
              <p className="text-[11px] text-text-muted mt-1">
                If set, callers must enter this PIN before recording a blast message.
              </p>
            </div>

            {/* Contact mapping */}
            <ContactPicker
              label="Blast Contacts"
              groups={orgGroups}
              contacts={orgContacts}
              selectedGroupIds={form.group_ids}
              selectedContactIds={form.contact_ids}
              onChange={({ group_ids, contact_ids }) => setForm(p => ({ ...p, group_ids, contact_ids }))}
            />

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
