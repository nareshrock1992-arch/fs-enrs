import { useEffect, useState, useMemo } from 'react';
import { Plus, Pencil, Trash2, ToggleLeft, ToggleRight, Users, Shield, ChevronDown, ChevronRight } from 'lucide-react';
import { api } from '../../api/client.js';
import Modal from '../../components/ui/Modal.jsx';
import { Table, Th, Td, Tr, EmptyRow } from '../../components/ui/Table.jsx';
import Badge from '../../components/ui/Badge.jsx';
import ContactPicker from '../../components/ui/ContactPicker.jsx';

const EMPTY = {
  organization_id: '', name: '', pin: '',
  max_concurrent_conferences: 2, queue_enabled: true,
  record_conferences: false, queue_hold_audio: '',
  primary_group_ids: [],
  secondary_group_ids: [],
};

function TierBadge({ groups, tier }) {
  if (!groups || groups.length === 0) {
    return <span className="text-xs text-red-400">None mapped</span>;
  }
  return (
    <div className="flex flex-wrap gap-1">
      {groups.map(g => (
        <span key={g.group_id}
          className={`text-[10px] px-1.5 py-0.5 rounded font-medium
            ${tier === 'primary'
              ? 'bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-300'
              : 'bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-300'
            }`}>
          {g.group_name}
          {g.member_count != null && <span className="opacity-60 ml-1">({g.member_count})</span>}
        </span>
      ))}
    </div>
  );
}

function TierSection({ label, tier, description, color, groups, allGroups, selectedIds, onChange }) {
  const [open, setOpen] = useState(true);

  return (
    <div className={`border rounded-lg overflow-hidden ${
      tier === 'primary'
        ? 'border-blue-200 dark:border-blue-800'
        : 'border-amber-200 dark:border-amber-800'
    }`}>
      <button
        type="button"
        onClick={() => setOpen(o => !o)}
        className={`w-full flex items-center gap-2 px-3 py-2.5 text-left
          ${tier === 'primary'
            ? 'bg-blue-50 dark:bg-blue-900/20'
            : 'bg-amber-50 dark:bg-amber-900/20'
          }`}
      >
        <Shield size={13} className={tier === 'primary' ? 'text-blue-600 dark:text-blue-400' : 'text-amber-600 dark:text-amber-400'} />
        <div className="flex-1 min-w-0">
          <span className={`text-xs font-bold ${tier === 'primary' ? 'text-blue-700 dark:text-blue-300' : 'text-amber-700 dark:text-amber-300'}`}>
            {label}
          </span>
          <span className="text-[10px] text-text-muted ml-2">{description}</span>
        </div>
        <span className="text-[10px] text-text-muted mr-1">
          {selectedIds.length > 0 ? `${selectedIds.length} group${selectedIds.length > 1 ? 's' : ''}` : 'None'}
        </span>
        {open ? <ChevronDown size={12} className="text-text-muted" /> : <ChevronRight size={12} className="text-text-muted" />}
      </button>

      {open && (
        <div className="p-3">
          <ContactPicker
            groups={allGroups}
            contacts={[]}
            selectedGroupIds={selectedIds}
            selectedContactIds={[]}
            hideContacts={true}
            onChange={({ group_ids }) => onChange(group_ids)}
          />
        </div>
      )}
    </div>
  );
}

export default function ErsConfigList() {
  const [rows,   setRows]   = useState([]);
  const [orgs,   setOrgs]   = useState([]);
  const [groups, setGroups] = useState([]);
  const [modal,  setModal]  = useState(null);
  const [form,   setForm]   = useState(EMPTY);
  const [saving, setSaving] = useState(false);
  const [error,  setError]  = useState('');

  async function load() {
    try {
      const [e, o, g] = await Promise.all([
        api.ers.list(),
        api.orgs.list(),
        api.groups.list(),
      ]);
      setRows(e.configurations || []);
      setOrgs(o.organizations || []);
      setGroups(g.groups || []);
    } catch {}
  }
  useEffect(() => { load(); }, []);

  const f = (k, v) => setForm(p => ({ ...p, [k]: v }));

  const orgGroups = useMemo(
    () => groups
      .filter(g => !form.organization_id || g.organization_id === Number(form.organization_id))
      .map(g => ({ ...g, member_count: g.member_count ?? g.members?.length ?? undefined })),
    [groups, form.organization_id]
  );

  async function handleSave() {
    setSaving(true); setError('');
    try {
      const payload = {
        organization_id:            Number(form.organization_id) || undefined,
        name:                       form.name,
        pin:                        form.pin || undefined,
        max_concurrent_conferences: Number(form.max_concurrent_conferences),
        queue_enabled:              form.queue_enabled,
        record_conferences:         form.record_conferences,
        queue_hold_audio:           form.queue_hold_audio || null,
        primary_group_ids:          form.primary_group_ids.map(Number),
        secondary_group_ids:        form.secondary_group_ids.map(Number),
      };
      if (!modal.id) await api.ers.create(payload);
      else           await api.ers.update(modal.id, payload);
      setModal(null); load();
    } catch (e) { setError(e.message); } finally { setSaving(false); }
  }

  function openCreate() { setForm(EMPTY); setModal({}); setError(''); }

  async function openEdit(r) {
    try {
      const [full, tiers] = await Promise.all([
        api.ers.get(r.id),
        api.ers.tierGroups(r.id),
      ]);
      setForm({
        organization_id:            full.organization_id,
        name:                       full.name,
        pin:                        full.pin || '',
        max_concurrent_conferences: full.max_concurrent_conferences ?? 2,
        queue_enabled:              full.queue_enabled ?? true,
        record_conferences:         full.record_conferences ?? false,
        queue_hold_audio:           full.queue_hold_audio || '',
        primary_group_ids:          (tiers.primary_groups   || []).map(g => g.group_id),
        secondary_group_ids:        (tiers.secondary_groups || []).map(g => g.group_id),
      });
    } catch {
      setForm({ ...EMPTY, organization_id: r.organization_id, name: r.name });
    }
    setModal(r); setError('');
  }

  async function del(r) {
    if (!confirm(`Delete ERS configuration "${r.name}"?`)) return;
    try { await api.ers.remove(r.id); load(); } catch (e) { alert(e.message); }
  }

  async function toggle(r) {
    try { await api.ers.toggle(r.id); load(); } catch (e) { alert(e.message); }
  }

  const orgName = id => orgs.find(o => o.id === id)?.name || '—';

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-bold text-text-primary">ERS Configurations</h1>
        <button onClick={openCreate} className="btn-primary flex items-center gap-1.5">
          <Plus size={15} /> Add ERS
        </button>
      </div>

      <Table>
        <thead><tr className="bg-surface-hover">
          <Th>Name</Th>
          <Th>Organization</Th>
          <Th>Primary Tier</Th>
          <Th>Secondary Tier</Th>
          <Th>Max Conf.</Th>
          <Th>Queue</Th>
          <Th>Status</Th>
          <Th></Th>
        </tr></thead>
        <tbody>
          {rows.length === 0 ? <EmptyRow cols={8} /> : rows.map(r => (
            <Tr key={r.id}>
              <Td className="font-medium">{r.name}</Td>
              <Td className="text-text-muted">{orgName(r.organization_id)}</Td>
              <Td>
                <div className="flex items-center gap-1 text-xs">
                  <Users size={11} className="text-blue-500" />
                  <span className="text-text-muted">
                    {r.primary_group_count > 0
                      ? `${r.primary_group_count} group${r.primary_group_count > 1 ? 's' : ''}`
                      : <span className="text-red-400">None</span>}
                  </span>
                </div>
              </Td>
              <Td>
                <div className="flex items-center gap-1 text-xs">
                  <Users size={11} className="text-amber-500" />
                  <span className="text-text-muted">
                    {r.secondary_group_count > 0
                      ? `${r.secondary_group_count} group${r.secondary_group_count > 1 ? 's' : ''}`
                      : <span className="text-text-muted">None</span>}
                  </span>
                </div>
              </Td>
              <Td>{r.max_concurrent_conferences}</Td>
              <Td>
                <Badge variant={r.queue_enabled ? 'success' : 'default'}>
                  {r.queue_enabled ? 'On' : 'Off'}
                </Badge>
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
          title={modal.id ? 'Edit ERS Configuration' : 'Create ERS Configuration'}
          size="xl"
          onClose={() => setModal(null)}
        >
          <div className="space-y-4">
            {/* Basic */}
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="label">Organization</label>
                <select className="input" value={form.organization_id}
                        onChange={e => f('organization_id', Number(e.target.value) || '')}>
                  <option value="">Select…</option>
                  {orgs.map(o => <option key={o.id} value={o.id}>{o.name}</option>)}
                </select>
              </div>
              <div>
                <label className="label">Name</label>
                <input className="input" value={form.name} onChange={e => f('name', e.target.value)} />
              </div>
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="label">Max Concurrent Conferences</label>
                <input className="input" type="number" min="1" max="10"
                       value={form.max_concurrent_conferences}
                       onChange={e => f('max_concurrent_conferences', e.target.value)} />
                <p className="text-[11px] text-text-muted mt-1">
                  Set to 2 for two bridges (primary + secondary). Third call enters queue.
                </p>
              </div>
              <div>
                <label className="label">PIN (optional)</label>
                <input className="input" value={form.pin}
                       onChange={e => f('pin', e.target.value)}
                       placeholder="Leave blank for CLID-based auth" type="password" />
              </div>
            </div>

            {/* Queue settings */}
            <div className="grid grid-cols-2 gap-3 items-start">
              <div>
                <div className="flex items-center gap-2 mb-2">
                  <input type="checkbox" id="qEnabled" checked={form.queue_enabled}
                         onChange={e => f('queue_enabled', e.target.checked)} />
                  <label htmlFor="qEnabled" className="text-sm font-medium text-text-primary cursor-pointer">
                    Enable Queue
                  </label>
                </div>
                <p className="text-[11px] text-text-muted">
                  When all bridges are busy, callers hear hold audio and auto-join when a bridge frees.
                </p>
              </div>
              <div>
                <label className="label">Queue Hold Audio (path on FS)</label>
                <input className="input font-mono text-xs" value={form.queue_hold_audio}
                       onChange={e => f('queue_hold_audio', e.target.value)}
                       placeholder="e.g. /opt/freeswitch/sounds/en/us/callie/ivr/8000/ivr-hold_music.wav" />
                <p className="text-[11px] text-text-muted mt-1">
                  Played in a loop while caller waits in queue. Leave blank for default MOH.
                </p>
              </div>
            </div>

            <div className="flex items-center gap-2">
              <input type="checkbox" id="recConf" checked={form.record_conferences}
                     onChange={e => f('record_conferences', e.target.checked)} />
              <label htmlFor="recConf" className="text-sm text-text-primary cursor-pointer">
                Record conferences
              </label>
            </div>

            {/* Tier group mappings */}
            <div className="space-y-2">
              <p className="text-xs font-bold text-text-primary uppercase tracking-wider">
                Responder Tiers
              </p>

              <TierSection
                label="Tier 1 — Primary Responders"
                tier="primary"
                description="Dialed when the first call arrives"
                allGroups={orgGroups}
                selectedIds={form.primary_group_ids}
                onChange={ids => f('primary_group_ids', ids)}
              />

              <TierSection
                label="Tier 2 — Secondary Responders"
                tier="secondary"
                description="Dialed when a second call arrives (second bridge)"
                allGroups={orgGroups}
                selectedIds={form.secondary_group_ids}
                onChange={ids => f('secondary_group_ids', ids)}
              />

              <div className="rounded-lg bg-surface-hover border border-surface-border px-3 py-2.5 text-xs text-text-muted">
                <strong className="text-text-primary">How bridges work:</strong>
                {' '}Call 1 → opens Bridge 1 → dials Tier 1 groups.
                Call 2 → opens Bridge 2 → dials Tier 2 groups.
                Call 3+ → held in queue (if enabled) → plays hold audio → joins when a bridge frees.
              </div>
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
