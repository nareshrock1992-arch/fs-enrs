import { useEffect, useState, useMemo } from 'react';
import {
  Plus, Pencil, Trash2, ToggleLeft, ToggleRight,
  Users, Shield, ChevronDown, ChevronRight,
} from 'lucide-react';
import { api } from '../../api/client.js';
import Modal from '../../components/ui/Modal.jsx';
import { Table, Th, Td, Tr, EmptyRow } from '../../components/ui/Table.jsx';
import Badge from '../../components/ui/Badge.jsx';
import ContactPicker from '../../components/ui/ContactPicker.jsx';

const EMPTY = {
  organization_id:              '',
  name:                         '',
  description:                  '',
  // Bridges
  primary_bridge_number:        '',
  secondary_bridge_number:      '',
  conference_profile:           'default',
  max_concurrent_conferences:   2,
  max_conference_duration_min:  0,
  // Queue
  queue_enabled:                true,
  queue_announcement_audio:     '',
  queue_music_path:             '',
  queue_timeout_sec:            0,
  queue_priority:               5,
  // Recording — Lua channel recording
  record_conferences:           false,
  recording_directory:          '',
  // Conference type + backend-driven recording
  conference_type:              'STATIC',
  recording_enabled:            false,
  recording_mode:               'MANUAL',
  recording_trigger:            'CONFERENCE_CREATED',
  recording_format:             'wav',
  // Conference behaviour (reserved — Phase 4)
  max_participants:             0,
  conference_lock:              false,
  auto_destroy:                 true,
  allow_external:               false,
  allow_duplicate_responders:   false,
  moderator_required:           false,
  bridge_timeout_sec:           0,
  // Ring / retry (shared)
  retry_ring_count:             3,
  retry_ring_interval:          30,
  ring_timeout_seconds:         '',   // blank = ring indefinitely (2h safety cap)
  // Auth
  pin:                          '',
  allow_rejoin:                 true,
  cli_authentication:           false,
  // Per-tier retry
  primary_retry_count:          3,
  primary_retry_interval_sec:   30,
  secondary_retry_count:        3,
  secondary_retry_interval_sec: 30,
  // Tier responders
  primary_group_ids:            [],
  secondary_group_ids:          [],
  primary_contact_ids:          [],
  secondary_contact_ids:        [],
};

// ── Collapsible tier section ──────────────────────────────────────────────────

function TierSection({
  label, tier,
  groups, contacts,
  selectedGroupIds, selectedContactIds,
  retryCount, retryInterval,
  onGroupChange, onContactChange,
  onRetryCountChange, onRetryIntervalChange,
}) {
  const [open, setOpen] = useState(true);
  const isPrimary = tier === 'primary';
  const colors = isPrimary
    ? { border: 'border-blue-200 dark:border-blue-800',
        header: 'bg-blue-50 dark:bg-blue-900/20',
        text:   'text-blue-700 dark:text-blue-300',
        icon:   'text-blue-600 dark:text-blue-400' }
    : { border: 'border-amber-200 dark:border-amber-800',
        header: 'bg-amber-50 dark:bg-amber-900/20',
        text:   'text-amber-700 dark:text-amber-300',
        icon:   'text-amber-600 dark:text-amber-400' };

  const total = selectedGroupIds.length + selectedContactIds.length;

  return (
    <div className={`border rounded-lg overflow-hidden ${colors.border}`}>
      <button
        type="button"
        onClick={() => setOpen(o => !o)}
        className={`w-full flex items-center gap-2 px-3 py-2.5 text-left ${colors.header}`}
      >
        <Shield size={13} className={colors.icon} />
        <span className={`flex-1 text-xs font-bold ${colors.text}`}>{label}</span>
        <span className="text-[10px] text-text-muted mr-1">
          {total > 0 ? `${total} selected` : 'None'}
        </span>
        {open
          ? <ChevronDown  size={12} className="text-text-muted" />
          : <ChevronRight size={12} className="text-text-muted" />}
      </button>

      {open && (
        <div className="p-3 space-y-3">
          <div className="grid grid-cols-2 gap-2">
            <div>
              <label className="label">Retry Count</label>
              <input className="input" type="number" min="0" max="10"
                     value={retryCount}
                     onChange={e => onRetryCountChange(Number(e.target.value))} />
            </div>
            <div>
              <label className="label">Retry Interval (s)</label>
              <input className="input" type="number" min="5"
                     value={retryInterval}
                     onChange={e => onRetryIntervalChange(Number(e.target.value))} />
            </div>
          </div>

          <ContactPicker
            groups={groups}
            contacts={contacts}
            selectedGroupIds={selectedGroupIds}
            selectedContactIds={selectedContactIds}
            onChange={({ group_ids, contact_ids }) => {
              onGroupChange(group_ids);
              onContactChange(contact_ids);
            }}
          />
        </div>
      )}
    </div>
  );
}

// ── Main page ─────────────────────────────────────────────────────────────────

export default function ErsConfigList() {
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
        api.ers.list(),
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
    () => groups.filter(g => !form.organization_id || g.organization_id === Number(form.organization_id))
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
        organization_id:              Number(form.organization_id) || undefined,
        description:                  form.description || null,
        primary_bridge_number:        form.primary_bridge_number || null,
        secondary_bridge_number:      form.secondary_bridge_number || null,
        conference_profile:           form.conference_profile || 'default',
        max_concurrent_conferences:   Number(form.max_concurrent_conferences),
        max_conference_duration_min:  Number(form.max_conference_duration_min),
        queue_announcement_audio:     form.queue_announcement_audio || null,
        queue_music_path:             form.queue_music_path || null,
        queue_timeout_sec:            Number(form.queue_timeout_sec),
        queue_priority:               Number(form.queue_priority),
        recording_directory:          form.recording_directory || null,
        conference_type:              form.conference_type,
        recording_enabled:            form.recording_enabled,
        recording_mode:               form.recording_mode,
        recording_trigger:            form.recording_trigger,
        recording_format:             form.recording_format || 'wav',
        max_participants:             Number(form.max_participants),
        conference_lock:              form.conference_lock,
        auto_destroy:                 form.auto_destroy,
        allow_external:               form.allow_external,
        allow_duplicate_responders:   form.allow_duplicate_responders,
        moderator_required:           form.moderator_required,
        bridge_timeout_sec:           Number(form.bridge_timeout_sec),
        retry_ring_count:             Number(form.retry_ring_count),
        retry_ring_interval:          Number(form.retry_ring_interval),
        ring_timeout_seconds:         form.ring_timeout_seconds === '' ? null : Number(form.ring_timeout_seconds),
        pin:                          form.pin || null,
        primary_retry_count:          Number(form.primary_retry_count),
        primary_retry_interval_sec:   Number(form.primary_retry_interval_sec),
        secondary_retry_count:        Number(form.secondary_retry_count),
        secondary_retry_interval_sec: Number(form.secondary_retry_interval_sec),
        primary_group_ids:            form.primary_group_ids.map(Number),
        secondary_group_ids:          form.secondary_group_ids.map(Number),
        primary_contact_ids:          form.primary_contact_ids.map(Number),
        secondary_contact_ids:        form.secondary_contact_ids.map(Number),
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
        organization_id:              full.organization_id ?? '',
        name:                         full.name ?? '',
        description:                  full.description ?? '',
        primary_bridge_number:        full.primary_bridge_number ?? '',
        secondary_bridge_number:      full.secondary_bridge_number ?? '',
        conference_profile:           full.conference_profile ?? 'default',
        max_concurrent_conferences:   full.max_concurrent_conferences ?? 2,
        max_conference_duration_min:  full.max_conference_duration_min ?? 0,
        queue_enabled:                full.queue_enabled ?? true,
        queue_announcement_audio:     full.queue_announcement_audio ?? '',
        queue_music_path:             full.queue_music_path ?? '',
        queue_timeout_sec:            full.queue_timeout_sec ?? 0,
        queue_priority:               full.queue_priority ?? 5,
        record_conferences:           full.record_conferences ?? false,
        recording_directory:          full.recording_directory ?? '',
        conference_type:              full.conference_type ?? 'STATIC',
        recording_enabled:            full.recording_enabled ?? false,
        recording_mode:               full.recording_mode ?? 'MANUAL',
        recording_trigger:            full.recording_trigger ?? 'CONFERENCE_CREATED',
        recording_format:             full.recording_format ?? 'wav',
        max_participants:             full.max_participants ?? 0,
        conference_lock:              full.conference_lock ?? false,
        auto_destroy:                 full.auto_destroy ?? true,
        allow_external:               full.allow_external ?? false,
        allow_duplicate_responders:   full.allow_duplicate_responders ?? false,
        moderator_required:           full.moderator_required ?? false,
        bridge_timeout_sec:           full.bridge_timeout_sec ?? 0,
        retry_ring_count:             full.retry_ring_count ?? 3,
        retry_ring_interval:          full.retry_ring_interval ?? 30,
        ring_timeout_seconds:         full.ring_timeout_seconds ?? '',
        pin:                          full.pin ?? '',
        allow_rejoin:                 full.allow_rejoin ?? true,
        cli_authentication:           full.cli_authentication ?? false,
        primary_retry_count:          full.primary_retry_count ?? 3,
        primary_retry_interval_sec:   full.primary_retry_interval_sec ?? 30,
        secondary_retry_count:        full.secondary_retry_count ?? 3,
        secondary_retry_interval_sec: full.secondary_retry_interval_sec ?? 30,
        primary_group_ids:    (tiers.primary_groups    || []).map(g => g.group_id),
        secondary_group_ids:  (tiers.secondary_groups  || []).map(g => g.group_id),
        primary_contact_ids:  (tiers.primary_contacts  || []).map(c => c.contact_id),
        secondary_contact_ids:(tiers.secondary_contacts|| []).map(c => c.contact_id),
      });
    } catch {
      setForm({ ...EMPTY, organization_id: r.organization_id ?? '', name: r.name ?? '' });
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
          <Th>Bridges</Th>
          <Th>Tier 1</Th>
          <Th>Tier 2</Th>
          <Th>Max</Th>
          <Th>Queue</Th>
          <Th>Status</Th>
          <Th></Th>
        </tr></thead>
        <tbody>
          {rows.length === 0 ? <EmptyRow cols={9} /> : rows.map(r => (
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
                  {r.primary_bridge_number   && <div className="text-blue-400">P: {r.primary_bridge_number}</div>}
                  {r.secondary_bridge_number && <div className="text-amber-400">S: {r.secondary_bridge_number}</div>}
                  {!r.primary_bridge_number && !r.secondary_bridge_number && <span className="text-text-muted">—</span>}
                </div>
              </Td>
              <Td>
                <div className="flex items-center gap-1 text-xs">
                  <Users size={11} className="text-blue-500" />
                  <span className="text-text-muted">
                    {(r.primary_group_count || 0) > 0 || (r.primary_contact_count || 0) > 0
                      ? `${r.primary_group_count || 0}g · ${r.primary_contact_count || 0}c`
                      : <span className="text-red-400">None</span>}
                  </span>
                </div>
              </Td>
              <Td>
                <div className="flex items-center gap-1 text-xs">
                  <Users size={11} className="text-amber-500" />
                  <span className="text-text-muted">
                    {(r.secondary_group_count || 0) > 0 || (r.secondary_contact_count || 0) > 0
                      ? `${r.secondary_group_count || 0}g · ${r.secondary_contact_count || 0}c`
                      : <span className="text-text-muted">—</span>}
                  </span>
                </div>
              </Td>
              <Td className="text-text-muted text-xs">{r.max_concurrent_conferences ?? 2}</Td>
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
          title={modal.id ? 'Edit ERS Configuration' : 'Create ERS Configuration'}
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
                         placeholder="e.g. Main Emergency Response" />
                </div>
              </div>
              <div className="mt-3">
                <label className="label">Description</label>
                <input className="input" value={form.description}
                       onChange={e => f('description', e.target.value)}
                       placeholder="Optional description" />
              </div>
            </section>

            {/* ── Conference Bridges ── */}
            <section>
              <p className="text-xs font-bold text-text-secondary uppercase tracking-wider mb-3">Conference Bridges</p>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="label">Primary Bridge Number</label>
                  <input className="input font-mono" value={form.primary_bridge_number}
                         onChange={e => f('primary_bridge_number', e.target.value)}
                         placeholder="e.g. 7000" />
                  <p className="text-[11px] text-text-muted mt-1">Extension of the primary conference room</p>
                </div>
                <div>
                  <label className="label">Secondary Bridge Number</label>
                  <input className="input font-mono" value={form.secondary_bridge_number}
                         onChange={e => f('secondary_bridge_number', e.target.value)}
                         placeholder="e.g. 7001" />
                  <p className="text-[11px] text-text-muted mt-1">Extension of the secondary conference room</p>
                </div>
              </div>
              <div className="grid grid-cols-3 gap-3 mt-3">
                <div>
                  <label className="label">Conference Profile</label>
                  <input className="input" value={form.conference_profile}
                         onChange={e => f('conference_profile', e.target.value)}
                         placeholder="default" />
                </div>
                <div>
                  <label className="label">Max Concurrent Incidents</label>
                  <input className="input" type="number" min="1" max="10"
                         value={form.max_concurrent_conferences}
                         onChange={e => f('max_concurrent_conferences', Number(e.target.value))} />
                  <p className="text-[11px] text-text-muted mt-1">2 = primary + secondary bridge</p>
                </div>
                <div>
                  <label className="label">Max Duration (min)</label>
                  <input className="input" type="number" min="0"
                         value={form.max_conference_duration_min}
                         onChange={e => f('max_conference_duration_min', Number(e.target.value))} />
                  <p className="text-[11px] text-text-muted mt-1">0 = unlimited</p>
                </div>
              </div>
            </section>

            {/* ── Queue ── */}
            <section>
              <p className="text-xs font-bold text-text-secondary uppercase tracking-wider mb-3">Queue</p>
              <div className="flex items-center gap-2 mb-3">
                <input type="checkbox" id="qEnabled" checked={form.queue_enabled}
                       onChange={e => f('queue_enabled', e.target.checked)} />
                <label htmlFor="qEnabled" className="text-sm font-medium text-text-primary cursor-pointer">
                  Enable Queue — callers wait when all bridges are busy
                </label>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="label">Announcement Audio</label>
                  <input className="input font-mono text-xs" value={form.queue_announcement_audio}
                         onChange={e => f('queue_announcement_audio', e.target.value)}
                         placeholder="/opt/freeswitch/sounds/queue_busy.wav" />
                </div>
                <div>
                  <label className="label">Queue Music / Hold Audio</label>
                  <input className="input font-mono text-xs" value={form.queue_music_path}
                         onChange={e => f('queue_music_path', e.target.value)}
                         placeholder="/opt/freeswitch/sounds/hold_music.wav" />
                </div>
                <div>
                  <label className="label">Queue Timeout (s)</label>
                  <input className="input" type="number" min="0"
                         value={form.queue_timeout_sec}
                         onChange={e => f('queue_timeout_sec', Number(e.target.value))} />
                  <p className="text-[11px] text-text-muted mt-1">0 = wait indefinitely</p>
                </div>
                <div>
                  <label className="label">Queue Priority</label>
                  <input className="input" type="number" min="1" max="10"
                         value={form.queue_priority}
                         onChange={e => f('queue_priority', Number(e.target.value))} />
                </div>
              </div>
            </section>

            {/* ── Conference ── */}
            <section>
              <p className="text-xs font-bold text-text-secondary uppercase tracking-wider mb-3">Conference</p>
              <div className="grid grid-cols-2 gap-3">
                <div className="col-span-2">
                  <label className="label">Conference Room Type</label>
                  <select className="input" value={form.conference_type}
                          onChange={e => f('conference_type', e.target.value)}>
                    <option value="STATIC">Static — use configured bridge numbers</option>
                    <option value="DYNAMIC">Dynamic — generate unique room per incident</option>
                  </select>
                  {form.conference_type === 'DYNAMIC' && (
                    <p className="text-[11px] text-amber-600 dark:text-amber-400 mt-1">
                      Dynamic rooms are generated at call time. Bridge numbers below become fallback identifiers only.
                    </p>
                  )}
                </div>
              </div>
            </section>

            {/* ── Recording ── */}
            <section>
              <p className="text-xs font-bold text-text-secondary uppercase tracking-wider mb-3">Recording</p>

              {/* Lua channel recording (existing) */}
              <div className="flex items-center gap-2 mb-3">
                <input type="checkbox" id="recConf" checked={form.record_conferences}
                       onChange={e => f('record_conferences', e.target.checked)} />
                <label htmlFor="recConf" className="text-sm text-text-primary cursor-pointer">
                  Record each leg (Lua record_session)
                </label>
              </div>

              {/* Backend-driven conference recording */}
              <div className="border border-surface-border rounded-lg p-3 space-y-3 mb-3">
                <div className="flex items-center gap-2">
                  <input type="checkbox" id="recEnabled" checked={form.recording_enabled}
                         onChange={e => f('recording_enabled', e.target.checked)} />
                  <label htmlFor="recEnabled" className="text-sm font-medium text-text-primary cursor-pointer">
                    Enable conference recording (ESL)
                  </label>
                </div>
                {form.recording_enabled && (
                  <div className="grid grid-cols-2 gap-3 pt-1">
                    <div>
                      <label className="label">Recording Mode</label>
                      <select className="input" value={form.recording_mode}
                              onChange={e => f('recording_mode', e.target.value)}>
                        <option value="MANUAL">Manual — operator starts recording</option>
                        <option value="AUTO">Auto — backend starts automatically</option>
                      </select>
                    </div>
                    {form.recording_mode === 'AUTO' && (
                      <div>
                        <label className="label">Start Trigger</label>
                        <select className="input" value={form.recording_trigger}
                                onChange={e => f('recording_trigger', e.target.value)}>
                          <option value="CONFERENCE_CREATED">Conference Created</option>
                          <option value="FIRST_PARTICIPANT">First Participant Joins</option>
                          <option value="MODERATOR_JOIN">Moderator Joins</option>
                        </select>
                      </div>
                    )}
                    <div>
                      <label className="label">Format</label>
                      <select className="input" value={form.recording_format}
                              onChange={e => f('recording_format', e.target.value)}>
                        <option value="wav">WAV (uncompressed)</option>
                        <option value="mp3">MP3</option>
                        <option value="ogg">OGG</option>
                      </select>
                    </div>
                  </div>
                )}
              </div>

              <div>
                <label className="label">Recording Directory (override)</label>
                <input className="input font-mono text-xs" value={form.recording_directory}
                       onChange={e => f('recording_directory', e.target.value)}
                       placeholder="/opt/freeswitch/recordings/ers" />
                <p className="text-[11px] text-text-muted mt-1">Leave blank to use the system default.</p>
              </div>
            </section>

            {/* ── Advanced (Phase 4 — reserved) ── */}
            <section>
              <p className="text-xs font-bold text-text-secondary uppercase tracking-wider mb-3">Advanced</p>
              <p className="text-[11px] text-text-muted mb-3">These settings are stored and will be enforced in a future release.</p>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="label">Max Participants (0 = unlimited)</label>
                  <input className="input" type="number" min="0"
                         value={form.max_participants}
                         onChange={e => f('max_participants', Number(e.target.value))} />
                </div>
                <div>
                  <label className="label">Bridge Timeout (s) — 0 = disabled</label>
                  <input className="input" type="number" min="0"
                         value={form.bridge_timeout_sec}
                         onChange={e => f('bridge_timeout_sec', Number(e.target.value))} />
                </div>
                <div className="col-span-2 flex flex-wrap gap-x-6 gap-y-2 pt-1">
                  {[
                    ['conference_lock',            'Lock conference after moderator joins'],
                    ['auto_destroy',               'Auto-destroy empty conference'],
                    ['allow_external',             'Allow external (non-responder) participants'],
                    ['allow_duplicate_responders', 'Allow same responder to join twice'],
                    ['moderator_required',         'Require moderator before audio opens'],
                  ].map(([key, label]) => (
                    <label key={key} className="flex items-center gap-2 cursor-pointer">
                      <input type="checkbox" checked={form[key]}
                             onChange={e => f(key, e.target.checked)} />
                      <span className="text-sm text-text-primary">{label}</span>
                    </label>
                  ))}
                </div>
              </div>
            </section>

            {/* ── Ring / Retry ── */}
            <section>
              <p className="text-xs font-bold text-text-secondary uppercase tracking-wider mb-3">Ring / Retry</p>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="label">Ring Count per Responder</label>
                  <input className="input" type="number" min="1"
                         value={form.retry_ring_count}
                         onChange={e => f('retry_ring_count', Number(e.target.value))} />
                </div>
                <div>
                  <label className="label">Ring Interval (s)</label>
                  <input className="input" type="number" min="5"
                         value={form.retry_ring_interval}
                         onChange={e => f('retry_ring_interval', Number(e.target.value))} />
                </div>
                <div className="col-span-2">
                  <label className="label">Ring-All Timeout (s) — blank = ring indefinitely</label>
                  <input className="input" type="number" min="10" max="7200"
                         placeholder="Leave blank to keep ringing until someone answers"
                         value={form.ring_timeout_seconds}
                         onChange={e => f('ring_timeout_seconds', e.target.value)} />
                  <p className="text-[10px] text-text-muted mt-1">
                    Overall ceiling for a ring-all wave: give up after this many seconds with no
                    responder answering. Indefinite ringing is safety-capped at 2 hours internally.
                  </p>
                </div>
              </div>
            </section>

            {/* ── Auth & Access ── */}
            <section>
              <p className="text-xs font-bold text-text-secondary uppercase tracking-wider mb-3">Auth & Access</p>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="label">PIN (optional)</label>
                  <input className="input" type="password" value={form.pin}
                         onChange={e => f('pin', e.target.value)}
                         placeholder="Leave blank to disable PIN auth"
                         maxLength={20} autoComplete="new-password" />
                </div>
                <div className="flex flex-col gap-3 pt-1">
                  <label className="flex items-center gap-2 cursor-pointer">
                    <input type="checkbox" checked={form.allow_rejoin}
                           onChange={e => f('allow_rejoin', e.target.checked)} />
                    <span className="text-sm text-text-primary">Allow Rejoin</span>
                  </label>
                  <label className="flex items-center gap-2 cursor-pointer">
                    <input type="checkbox" checked={form.cli_authentication}
                           onChange={e => f('cli_authentication', e.target.checked)} />
                    <span className="text-sm text-text-primary">CLI Authentication</span>
                  </label>
                </div>
              </div>
            </section>

            {/* ── Responder Tiers ── */}
            <section>
              <p className="text-xs font-bold text-text-secondary uppercase tracking-wider mb-3">Responder Tiers</p>
              <div className="space-y-3">
                <TierSection
                  label="Tier 1 — Primary Responders (Bridge 1)"
                  tier="primary"
                  groups={orgGroups}
                  contacts={orgContacts}
                  selectedGroupIds={form.primary_group_ids}
                  selectedContactIds={form.primary_contact_ids}
                  retryCount={form.primary_retry_count}
                  retryInterval={form.primary_retry_interval_sec}
                  onGroupChange={ids => f('primary_group_ids', ids)}
                  onContactChange={ids => f('primary_contact_ids', ids)}
                  onRetryCountChange={v => f('primary_retry_count', v)}
                  onRetryIntervalChange={v => f('primary_retry_interval_sec', v)}
                />
                <TierSection
                  label="Tier 2 — Secondary Responders (Bridge 2)"
                  tier="secondary"
                  groups={orgGroups}
                  contacts={orgContacts}
                  selectedGroupIds={form.secondary_group_ids}
                  selectedContactIds={form.secondary_contact_ids}
                  retryCount={form.secondary_retry_count}
                  retryInterval={form.secondary_retry_interval_sec}
                  onGroupChange={ids => f('secondary_group_ids', ids)}
                  onContactChange={ids => f('secondary_contact_ids', ids)}
                  onRetryCountChange={v => f('secondary_retry_count', v)}
                  onRetryIntervalChange={v => f('secondary_retry_interval_sec', v)}
                />
                <div className="rounded-lg bg-surface-hover border border-surface-border px-3 py-2.5 text-xs text-text-muted">
                  <strong className="text-text-primary">Bridge routing:</strong>
                  {' '}Call 1 → Bridge 1 → Tier 1 responders invited.
                  Call 2 → Bridge 2 → Tier 2 responders invited.
                  Call 3+ → queued → joins when a bridge frees.
                </div>
              </div>
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
