import { useEffect, useState, useMemo } from 'react';
import { Plus, Pencil, Trash2, ToggleLeft, ToggleRight, Users, User } from 'lucide-react';
import { api } from '../../api/client.js';
import Modal from '../../components/ui/Modal.jsx';
import { Table, Th, Td, Tr, EmptyRow } from '../../components/ui/Table.jsx';
import Badge from '../../components/ui/Badge.jsx';
import ContactPicker from '../../components/ui/ContactPicker.jsx';

const EMPTY = {
  // Basic
  organization_id:           '',
  name:                      '',
  description:               '',
  // Numbers
  destination_number:        '',   // blast trigger — caller dials this to record
  playback_number:           '',   // callers dial this to hear latest blast
  blast_clid:                '',   // outbound caller ID sent to recipients
  reply_clid:                '',   // callback DID for replies
  // Auth
  pin:                       '',
  // Campaign engine
  max_concurrent_calls:      30,
  calls_per_second:          10,
  batch_size:                30,
  max_attempts:              3,
  retry_interval_sec:        60,
  campaign_timeout_min:      60,
  recording_retention_hours: 24,
  retry_failed_only:         false,
  adaptive_throttling:       false,
  campaign_priority:         5,
  sip_gateway:               '',
  max_active_campaigns:      1,
  // Announcements
  expiry_announcement:       '',
  no_pending_msg:            '',
  // Responders
  group_ids:                 [],
  contact_ids:               [],
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
        api.contacts.list(),
      ]);
      setRows(e.configurations || []);
      setOrgs(o.organizations || []);
      setGroups(g.groups || []);
      setContacts(c.contacts || []);
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
        description:               form.description             || null,
        destination_number:        form.destination_number      || null,
        playback_number:           form.playback_number         || null,
        blast_clid:                form.blast_clid              || null,
        reply_clid:                form.reply_clid              || null,
        pin:                       form.pin                     || null,
        sip_gateway:               form.sip_gateway             || null,
        expiry_announcement:       form.expiry_announcement     || null,
        no_pending_msg:            form.no_pending_msg          || null,
        max_concurrent_calls:      Number(form.max_concurrent_calls),
        calls_per_second:          Number(form.calls_per_second),
        batch_size:                Number(form.batch_size),
        max_attempts:              Number(form.max_attempts),
        retry_interval_sec:        Number(form.retry_interval_sec),
        campaign_timeout_min:      Number(form.campaign_timeout_min),
        recording_retention_hours: Number(form.recording_retention_hours),
        campaign_priority:         Number(form.campaign_priority),
        max_active_campaigns:      Number(form.max_active_campaigns),
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
    try {
      const full = await api.ens.get(r.id);
      setForm({
        organization_id:           full.organization_id          ?? '',
        name:                      full.name                     ?? '',
        description:               full.description              ?? '',
        destination_number:        full.destination_number       ?? '',
        playback_number:           full.playback_number          ?? '',
        blast_clid:                full.blast_clid               ?? '',
        reply_clid:                full.reply_clid               ?? '',
        pin:                       full.pin                      ?? '',
        max_concurrent_calls:      full.max_concurrent_calls     ?? 30,
        calls_per_second:          full.calls_per_second         ?? 10,
        batch_size:                full.batch_size               ?? 30,
        max_attempts:              full.max_attempts             ?? 3,
        retry_interval_sec:        full.retry_interval_sec       ?? 60,
        campaign_timeout_min:      full.campaign_timeout_min     ?? 60,
        recording_retention_hours: full.recording_retention_hours ?? 24,
        retry_failed_only:         full.retry_failed_only        ?? false,
        adaptive_throttling:       full.adaptive_throttling      ?? false,
        campaign_priority:         full.campaign_priority        ?? 5,
        sip_gateway:               full.sip_gateway              ?? '',
        max_active_campaigns:      full.max_active_campaigns     ?? 1,
        expiry_announcement:       full.expiry_announcement      ?? '',
        no_pending_msg:            full.no_pending_msg           ?? '',
        group_ids:                 (full.groups   || []).map(g => g.responder_group_id ?? g.id),
        contact_ids:               (full.contacts || []).map(c => c.emergency_contact_id ?? c.id),
      });
    } catch {
      setForm({ ...EMPTY, organization_id: r.organization_id ?? '', name: r.name ?? '' });
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
          <Th>Organization</Th>
          <Th>Trigger / Playback</Th>
          <Th>Contacts</Th>
          <Th>Concurrent</Th>
          <Th>Retry</Th>
          <Th>Status</Th>
          <Th></Th>
        </tr></thead>
        <tbody>
          {rows.length === 0 ? <EmptyRow cols={8} /> : rows.map(r => (
            <Tr key={r.id}>
              <Td className="font-medium">
                <div>{r.name}</div>
                {r.description && (
                  <div className="text-xs text-text-muted truncate max-w-[160px]">{r.description}</div>
                )}
              </Td>
              <Td className="text-text-muted">{orgName(r.organization_id)}</Td>
              <Td>
                <div className="text-xs font-mono space-y-0.5">
                  {r.destination_number && <div className="text-text-primary">T: {r.destination_number}</div>}
                  {r.playback_number    && <div className="text-text-muted">P: {r.playback_number}</div>}
                  {!r.destination_number && !r.playback_number && <span className="text-text-muted">—</span>}
                </div>
              </Td>
              <Td>
                <div className="flex items-center gap-2 text-xs text-text-muted">
                  {(r.group_count || 0) > 0 && (
                    <span className="flex items-center gap-1">
                      <Users size={11} /> {r.group_count}g
                    </span>
                  )}
                  {(r.contact_count || 0) > 0 && (
                    <span className="flex items-center gap-1">
                      <User size={11} /> {r.contact_count}c
                    </span>
                  )}
                  {!r.group_count && !r.contact_count && <span className="text-red-400">None</span>}
                </div>
              </Td>
              <Td className="text-text-muted text-xs font-mono">
                {r.max_concurrent_calls ?? r.max_concurrent ?? '—'}
              </Td>
              <Td className="text-text-muted text-xs">
                {r.max_attempts ?? r.retry_count ?? '—'} × {r.retry_interval_sec ?? r.retry_delay_seconds ?? '—'}s
              </Td>
              <Td>
                <Badge variant={r.is_active ? 'success' : 'default'}>
                  {r.is_active ? 'Active' : 'Inactive'}
                </Badge>
              </Td>
              <Td>
                <div className="flex gap-1 justify-end">
                  <button onClick={() => toggle(r)} className="btn-ghost p-1.5" title="Toggle active">
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
          <div className="space-y-5">

            {/* ── Basic ── */}
            <section>
              <p className="text-xs font-bold text-text-secondary uppercase tracking-wider mb-3">Basic</p>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="label">Organization *</label>
                  <select className="input" value={form.organization_id}
                          onChange={e => f('organization_id', Number(e.target.value) || '')}>
                    <option value="">Select organization…</option>
                    {orgs.map(o => <option key={o.id} value={o.id}>{o.name}</option>)}
                  </select>
                </div>
                <div>
                  <label className="label">Configuration Name *</label>
                  <input className="input" value={form.name}
                         onChange={e => f('name', e.target.value)}
                         placeholder="e.g. Site-A Emergency Notification" />
                </div>
              </div>
              <div className="mt-3">
                <label className="label">Description</label>
                <input className="input" value={form.description}
                       onChange={e => f('description', e.target.value)}
                       placeholder="Optional description" />
              </div>
            </section>

            {/* ── Numbers ── */}
            <section>
              <p className="text-xs font-bold text-text-secondary uppercase tracking-wider mb-3">Service Numbers</p>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="label">Blast Trigger Number</label>
                  <input className="input font-mono" value={form.destination_number}
                         onChange={e => f('destination_number', e.target.value)}
                         placeholder="e.g. 1888" />
                  <p className="text-[11px] text-text-muted mt-1">Callers dial this to record a blast message</p>
                </div>
                <div>
                  <label className="label">Playback Number</label>
                  <input className="input font-mono" value={form.playback_number}
                         onChange={e => f('playback_number', e.target.value)}
                         placeholder="e.g. 1999" />
                  <p className="text-[11px] text-text-muted mt-1">Callers dial this to hear the latest blast</p>
                </div>
                <div>
                  <label className="label">Caller ID (Blast)</label>
                  <input className="input font-mono" value={form.blast_clid}
                         onChange={e => f('blast_clid', e.target.value)}
                         placeholder="Number shown to blast recipients" />
                </div>
                <div>
                  <label className="label">Reply Caller ID</label>
                  <input className="input font-mono" value={form.reply_clid}
                         onChange={e => f('reply_clid', e.target.value)}
                         placeholder="DID for callbacks" />
                </div>
              </div>
            </section>

            {/* ── Auth ── */}
            <section>
              <p className="text-xs font-bold text-text-secondary uppercase tracking-wider mb-3">Auth</p>
              <div className="max-w-xs">
                <label className="label">Auth PIN (optional)</label>
                <input className="input" type="password" value={form.pin}
                       onChange={e => f('pin', e.target.value)}
                       placeholder="Leave blank to disable"
                       maxLength={20} autoComplete="new-password" />
                <p className="text-[11px] text-text-muted mt-1">
                  Caller must enter this PIN before recording a blast
                </p>
              </div>
            </section>

            {/* ── Campaign Engine ── */}
            <section>
              <p className="text-xs font-bold text-text-secondary uppercase tracking-wider mb-3">Campaign Engine</p>
              <div className="grid grid-cols-3 gap-3">
                <div>
                  <label className="label">Max Concurrent Calls</label>
                  <input className="input" type="number" min="1" max="500"
                         value={form.max_concurrent_calls}
                         onChange={e => f('max_concurrent_calls', Number(e.target.value))} />
                </div>
                <div>
                  <label className="label">Calls Per Second (CPS)</label>
                  <input className="input" type="number" min="1" max="100"
                         value={form.calls_per_second}
                         onChange={e => f('calls_per_second', Number(e.target.value))} />
                </div>
                <div>
                  <label className="label">Batch Size</label>
                  <input className="input" type="number" min="1" max="500"
                         value={form.batch_size}
                         onChange={e => f('batch_size', Number(e.target.value))} />
                  <p className="text-[11px] text-text-muted mt-1">Contacts per dial batch</p>
                </div>
                <div>
                  <label className="label">Retry Count</label>
                  <input className="input" type="number" min="0" max="10"
                         value={form.max_attempts}
                         onChange={e => f('max_attempts', Number(e.target.value))} />
                </div>
                <div>
                  <label className="label">Retry Interval (s)</label>
                  <input className="input" type="number" min="10"
                         value={form.retry_interval_sec}
                         onChange={e => f('retry_interval_sec', Number(e.target.value))} />
                </div>
                <div>
                  <label className="label">Campaign Timeout (min)</label>
                  <input className="input" type="number" min="1"
                         value={form.campaign_timeout_min}
                         onChange={e => f('campaign_timeout_min', Number(e.target.value))} />
                  <p className="text-[11px] text-text-muted mt-1">0 = unlimited</p>
                </div>
                <div>
                  <label className="label">Recording Retention (h)</label>
                  <input className="input" type="number" min="1"
                         value={form.recording_retention_hours}
                         onChange={e => f('recording_retention_hours', Number(e.target.value))} />
                </div>
                <div>
                  <label className="label">Campaign Priority</label>
                  <input className="input" type="number" min="1" max="10"
                         value={form.campaign_priority}
                         onChange={e => f('campaign_priority', Number(e.target.value))} />
                </div>
                <div>
                  <label className="label">Max Active Campaigns</label>
                  <input className="input" type="number" min="1"
                         value={form.max_active_campaigns}
                         onChange={e => f('max_active_campaigns', Number(e.target.value))} />
                  <p className="text-[11px] text-text-muted mt-1">1 = serial campaigns only</p>
                </div>
              </div>

              <div className="mt-3">
                <label className="label">SIP Gateway</label>
                <input className="input font-mono text-xs max-w-xs" value={form.sip_gateway}
                       onChange={e => f('sip_gateway', e.target.value)}
                       placeholder="e.g. sofia/gateway/primary" />
              </div>

              <div className="flex flex-wrap gap-4 mt-3">
                <label className="flex items-center gap-2 cursor-pointer">
                  <input type="checkbox" checked={form.retry_failed_only}
                         onChange={e => f('retry_failed_only', e.target.checked)} />
                  <span className="text-sm text-text-primary">Retry Failed Only</span>
                </label>
                <label className="flex items-center gap-2 cursor-pointer">
                  <input type="checkbox" checked={form.adaptive_throttling}
                         onChange={e => f('adaptive_throttling', e.target.checked)} />
                  <span className="text-sm text-text-primary">Adaptive Throttling</span>
                </label>
              </div>
            </section>

            {/* ── Announcements ── */}
            <section>
              <p className="text-xs font-bold text-text-secondary uppercase tracking-wider mb-3">Announcements</p>
              <div className="grid grid-cols-1 gap-3">
                <div>
                  <label className="label">Expiry Announcement</label>
                  <input className="input" value={form.expiry_announcement}
                         onChange={e => f('expiry_announcement', e.target.value)}
                         placeholder="Message played when a recording has expired" />
                </div>
                <div>
                  <label className="label">No Pending Message</label>
                  <input className="input" value={form.no_pending_msg}
                         onChange={e => f('no_pending_msg', e.target.value)}
                         placeholder="Message played when there is no active blast" />
                </div>
              </div>
            </section>

            {/* ── Blast Contacts ── */}
            <section>
              <p className="text-xs font-bold text-text-secondary uppercase tracking-wider mb-3">Blast Recipients</p>
              <ContactPicker
                groups={orgGroups}
                contacts={orgContacts}
                selectedGroupIds={form.group_ids}
                selectedContactIds={form.contact_ids}
                onChange={({ group_ids, contact_ids }) => setForm(p => ({ ...p, group_ids, contact_ids }))}
              />
            </section>

            {error && <p className="text-sm text-red-500">{error}</p>}
            <div className="flex gap-2 justify-end pt-2">
              <button onClick={() => setModal(null)} className="btn-secondary">Cancel</button>
              <button onClick={handleSave} disabled={saving} className="btn-primary">
                {saving ? 'Saving…' : modal.id ? 'Update' : 'Create'}
              </button>
            </div>
          </div>
        </Modal>
      )}
    </div>
  );
}
