import { useEffect, useState, useMemo } from 'react';
import { Plus, Pencil, Trash2, ToggleLeft, ToggleRight, Users, User, ChevronDown } from 'lucide-react';
import { api } from '../../api/client.js';
import Modal from '../../components/ui/Modal.jsx';
import { Table, Th, Td, Tr, EmptyRow } from '../../components/ui/Table.jsx';
import Badge from '../../components/ui/Badge.jsx';
import ContactPicker from '../../components/ui/ContactPicker.jsx';

// ── Collapsible section wrapper ───────────────────────────────────────────────

function Section({ id, title, open, onToggle, children }) {
  return (
    <div className="border border-border rounded-lg overflow-hidden">
      <button
        type="button"
        onClick={() => onToggle(id)}
        className="w-full flex items-center justify-between px-4 py-2.5 bg-surface-hover hover:bg-surface text-left"
      >
        <span className="text-xs font-bold text-text-secondary uppercase tracking-wider">{title}</span>
        <ChevronDown
          size={14}
          className={`text-text-muted transition-transform duration-150 ${open ? 'rotate-180' : ''}`}
        />
      </button>
      {open && <div className="px-4 py-3 space-y-3">{children}</div>}
    </div>
  );
}

// ── Formatting preview ────────────────────────────────────────────────────────

function applyMobilePreview(raw, form) {
  if (!form.mobile_normalize_enabled) return raw;
  let n = raw;
  if (form.mobile_strip_leading_zero && n.startsWith('0')) n = n.slice(1);
  if (form.mobile_prefix) n = form.mobile_prefix + n;
  if (form.mobile_suffix) n = n + form.mobile_suffix;
  return n;
}

function applyExtPreview(raw, form) {
  if (!form.ext_normalize_enabled) return raw;
  let n = raw;
  if (form.ext_prefix) n = form.ext_prefix + n;
  if (form.ext_suffix) n = n + form.ext_suffix;
  return n;
}

// ── Default form state ────────────────────────────────────────────────────────

const EMPTY = {
  organization_id:           '',
  name:                      '',
  description:               '',
  // Caller ID
  blast_clid:                '',
  reply_clid:                '',
  // Auth
  pin:                       '',
  // Campaign engine
  max_concurrent_calls:      30,
  calls_per_second:          10,
  batch_size:                30,
  campaign_timeout_min:      60,
  recording_retention_hours: 24,
  campaign_priority:         5,
  max_active_campaigns:      1,
  adaptive_throttling:       false,
  // Retry
  max_attempts:              3,
  retry_interval_sec:        60,
  retry_failed_only:         false,
  // Call routing
  sip_gateway:               '',
  routing_mode:              'auto',
  dial_preference:           'extension_mobile',
  fallback_mode:             'none',
  skip_behavior:             'skip',
  // Mobile dialing rules
  allow_mobile:              true,
  mobile_normalize_enabled:  false,
  mobile_strip_leading_zero: false,
  mobile_prefix:             '',
  mobile_suffix:             '',
  // Extension dialing rules
  allow_extension:           false,
  ext_normalize_enabled:     false,
  ext_prefix:                '',
  ext_suffix:                '',
  // Announcements
  expiry_announcement:       '',
  no_pending_msg:            '',
  // Recipients
  group_ids:                 [],
  contact_ids:               [],
};

// ── Component ─────────────────────────────────────────────────────────────────

export default function EnsList() {
  const [rows,     setRows]     = useState([]);
  const [orgs,     setOrgs]     = useState([]);
  const [groups,   setGroups]   = useState([]);
  const [contacts, setContacts] = useState([]);
  const [gateways, setGateways] = useState([]);
  const [modal,    setModal]    = useState(null);
  const [form,     setForm]     = useState(EMPTY);
  const [saving,   setSaving]   = useState(false);
  const [error,    setError]    = useState('');

  // Which sections are expanded (start open: general, callrouting, recipients)
  const [openSections, setOpenSections] = useState(
    new Set(['general', 'callerid', 'campaign', 'callrouting', 'recipients'])
  );

  function toggleSection(id) {
    setOpenSections(prev => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  }

  async function load() {
    try {
      const [e, o, g, c, gw] = await Promise.all([
        api.ens.list(),
        api.orgs.list(),
        api.groups.list(),
        api.contacts.list(),
        api.gateways.list(),
      ]);
      setRows(e.configurations || []);
      setOrgs(o.organizations || []);
      setGroups(g.groups || []);
      setContacts(c.contacts || []);
      setGateways(gw.gateways || []);
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

  // Live formatting previews
  const mobilePreviewRaw = '0507221769';
  const mobilePreviewOut = useMemo(
    () => applyMobilePreview(mobilePreviewRaw, form),
    [form.mobile_normalize_enabled, form.mobile_strip_leading_zero, form.mobile_prefix, form.mobile_suffix]
  );

  const extPreviewRaw = '1001';
  const extPreviewOut = useMemo(
    () => applyExtPreview(extPreviewRaw, form),
    [form.ext_normalize_enabled, form.ext_prefix, form.ext_suffix]
  );

  async function handleSave() {
    setSaving(true); setError('');
    try {
      const payload = {
        ...form,
        organization_id:           Number(form.organization_id) || undefined,
        description:               form.description             || null,
        blast_clid:                form.blast_clid              || null,
        reply_clid:                form.reply_clid              || null,
        pin:                       form.pin                     || null,
        sip_gateway:               form.sip_gateway             || null,
        expiry_announcement:       form.expiry_announcement     || null,
        no_pending_msg:            form.no_pending_msg          || null,
        mobile_prefix:             form.mobile_prefix           || null,
        mobile_suffix:             form.mobile_suffix           || null,
        ext_prefix:                form.ext_prefix              || null,
        ext_suffix:                form.ext_suffix              || null,
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

  function openCreate() {
    setForm(EMPTY);
    setOpenSections(new Set(['general', 'callerid', 'campaign', 'callrouting', 'recipients']));
    setModal({}); setError('');
  }

  async function openEdit(r) {
    try {
      const full = await api.ens.get(r.id);
      setForm({
        organization_id:           full.organization_id          ?? '',
        name:                      full.name                     ?? '',
        description:               full.description              ?? '',
        blast_clid:                full.blast_clid               ?? '',
        reply_clid:                full.reply_clid               ?? '',
        pin:                       full.pin                      ?? '',
        max_concurrent_calls:      full.max_concurrent_calls     ?? 30,
        calls_per_second:          full.calls_per_second         ?? 10,
        batch_size:                full.batch_size               ?? 30,
        campaign_timeout_min:      full.campaign_timeout_min     ?? 60,
        recording_retention_hours: full.recording_retention_hours ?? 24,
        campaign_priority:         full.campaign_priority        ?? 5,
        max_active_campaigns:      full.max_active_campaigns     ?? 1,
        adaptive_throttling:       full.adaptive_throttling      ?? false,
        max_attempts:              full.max_attempts             ?? 3,
        retry_interval_sec:        full.retry_interval_sec       ?? 60,
        retry_failed_only:         full.retry_failed_only        ?? false,
        sip_gateway:               full.sip_gateway              ?? '',
        routing_mode:              full.routing_mode             ?? 'auto',
        dial_preference:           full.dial_preference          ?? 'extension_mobile',
        fallback_mode:             full.fallback_mode            ?? 'none',
        skip_behavior:             full.skip_behavior            ?? 'skip',
        allow_mobile:              full.allow_mobile             ?? true,
        mobile_normalize_enabled:  full.mobile_normalize_enabled  ?? false,
        mobile_strip_leading_zero: full.mobile_strip_leading_zero ?? false,
        mobile_prefix:             full.mobile_prefix             ?? '',
        mobile_suffix:             full.mobile_suffix             ?? '',
        allow_extension:           full.allow_extension           ?? false,
        ext_normalize_enabled:     full.ext_normalize_enabled     ?? false,
        ext_prefix:                full.ext_prefix                ?? '',
        ext_suffix:                full.ext_suffix                ?? '',
        expiry_announcement:       full.expiry_announcement      ?? '',
        no_pending_msg:            full.no_pending_msg           ?? '',
        group_ids:                 (full.groups   || []).map(g => g.responder_group_id ?? g.id),
        contact_ids:               (full.contacts || []).map(c => c.emergency_contact_id ?? c.id),
      });
    } catch {
      setForm({ ...EMPTY, organization_id: r.organization_id ?? '', name: r.name ?? '' });
    }
    setOpenSections(new Set(['general', 'callerid', 'campaign', 'callrouting', 'recipients']));
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
                    <span className="flex items-center gap-1"><Users size={11} /> {r.group_count}g</span>
                  )}
                  {(r.contact_count || 0) > 0 && (
                    <span className="flex items-center gap-1"><User size={11} /> {r.contact_count}c</span>
                  )}
                  {!r.group_count && !r.contact_count && <span className="text-red-400">None</span>}
                </div>
              </Td>
              <Td className="text-text-muted text-xs font-mono">
                {r.max_concurrent_calls ?? '—'}
              </Td>
              <Td className="text-text-muted text-xs">
                {r.max_attempts ?? '—'} × {r.retry_interval_sec ?? '—'}s
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
          <div className="space-y-2">

            {/* ── General ── */}
            <Section id="general" title="General" open={openSections.has('general')} onToggle={toggleSection}>
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
              <div>
                <label className="label">Description</label>
                <input className="input" value={form.description}
                       onChange={e => f('description', e.target.value)}
                       placeholder="Optional description" />
              </div>
            </Section>

            {/* ── Caller ID & Auth ── */}
            <Section id="callerid" title="Caller ID & Auth" open={openSections.has('callerid')} onToggle={toggleSection}>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="label">Outbound Caller ID</label>
                  <input className="input font-mono" value={form.blast_clid}
                         onChange={e => f('blast_clid', e.target.value)}
                         placeholder="Number shown to blast recipients" />
                </div>
                <div>
                  <label className="label">Reply Caller ID</label>
                  <input className="input font-mono" value={form.reply_clid}
                         onChange={e => f('reply_clid', e.target.value)}
                         placeholder="Callback DID" />
                </div>
              </div>
              <div className="max-w-xs">
                <label className="label">Auth PIN (optional)</label>
                <input className="input" type="password" value={form.pin}
                       onChange={e => f('pin', e.target.value)}
                       placeholder="Leave blank to disable"
                       maxLength={20} autoComplete="new-password" />
                <p className="text-[11px] text-text-muted mt-1">Caller must enter this PIN before recording a blast</p>
              </div>
            </Section>

            {/* ── Campaign Engine ── */}
            <Section id="campaign" title="Campaign Engine" open={openSections.has('campaign')} onToggle={toggleSection}>
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
                  <label className="label">Campaign Timeout (min)</label>
                  <input className="input" type="number" min="1"
                         value={form.campaign_timeout_min}
                         onChange={e => f('campaign_timeout_min', Number(e.target.value))} />
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
                  <p className="text-[11px] text-text-muted mt-1">Higher = runs first</p>
                </div>
              </div>
              <label className="flex items-center gap-2 cursor-pointer">
                <input type="checkbox" checked={form.adaptive_throttling}
                       onChange={e => f('adaptive_throttling', e.target.checked)} />
                <span className="text-sm text-text-primary">Adaptive Throttling</span>
                <span className="text-[11px] text-text-muted">— reduces CPS when busy rate exceeds 30%</span>
              </label>
            </Section>

            {/* ── Retry ── */}
            <Section id="retry" title="Retry" open={openSections.has('retry')} onToggle={toggleSection}>
              <div className="grid grid-cols-3 gap-3">
                <div>
                  <label className="label">Max Attempts</label>
                  <input className="input" type="number" min="0" max="10"
                         value={form.max_attempts}
                         onChange={e => f('max_attempts', Number(e.target.value))} />
                  <p className="text-[11px] text-text-muted mt-1">0 = no retries</p>
                </div>
                <div>
                  <label className="label">Retry Interval (s)</label>
                  <input className="input" type="number" min="10"
                         value={form.retry_interval_sec}
                         onChange={e => f('retry_interval_sec', Number(e.target.value))} />
                </div>
              </div>
              <label className="flex items-center gap-2 cursor-pointer">
                <input type="checkbox" checked={form.retry_failed_only}
                       onChange={e => f('retry_failed_only', e.target.checked)} />
                <span className="text-sm text-text-primary">Retry Failed Only</span>
                <span className="text-[11px] text-text-muted">— skip contacts that answered on a previous attempt</span>
              </label>
            </Section>

            {/* ── Call Routing ── */}
            <Section id="callrouting" title="Call Routing" open={openSections.has('callrouting')} onToggle={toggleSection}>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="label">Default Gateway</label>
                  <select className="input" value={form.sip_gateway}
                          onChange={e => f('sip_gateway', e.target.value)}>
                    <option value="">Internal (no gateway)</option>
                    {gateways.map(g => (
                      <option key={g.id} value={g.name}>{g.name}</option>
                    ))}
                  </select>
                  <p className="text-[11px] text-text-muted mt-1">
                    Priority: contact's gateway → this default → platform default → internal
                  </p>
                </div>
                <div>
                  <label className="label">Routing Mode</label>
                  <select className="input" value={form.routing_mode}
                          onChange={e => f('routing_mode', e.target.value)}>
                    <option value="auto">Auto — use gateway when configured</option>
                    <option value="internal_only">Internal Only</option>
                    <option value="gateway_only">Gateway Only</option>
                  </select>
                </div>
                <div>
                  <label className="label">Dial Preference</label>
                  <select className="input" value={form.dial_preference}
                          onChange={e => f('dial_preference', e.target.value)}>
                    <option value="extension_mobile">Extension → Mobile</option>
                    <option value="mobile_extension">Mobile → Extension</option>
                    <option value="extension_only">Extension Only</option>
                    <option value="mobile_only">Mobile Only</option>
                  </select>
                </div>
                <div>
                  <label className="label">Skip Behaviour</label>
                  <select className="input" value={form.skip_behavior}
                          onChange={e => f('skip_behavior', e.target.value)}>
                    <option value="skip">Skip Contact</option>
                    <option value="warn">Warning Only</option>
                    <option value="fail">Fail Campaign</option>
                  </select>
                  <p className="text-[11px] text-text-muted mt-1">When a contact has no dialable number</p>
                </div>
              </div>
            </Section>

            {/* ── Mobile Dialing Rules ── */}
            <Section id="mobile" title="Mobile Dialing Rules" open={openSections.has('mobile')} onToggle={toggleSection}>
              <label className="flex items-center gap-2 cursor-pointer">
                <input type="checkbox" checked={form.allow_mobile}
                       onChange={e => f('allow_mobile', e.target.checked)} />
                <span className="text-sm font-medium text-text-primary">Allow Mobile Numbers</span>
              </label>

              {form.allow_mobile && (
                <div className="border border-border rounded-lg p-3 space-y-3">
                  <label className="flex items-center gap-2 cursor-pointer">
                    <input type="checkbox" checked={form.mobile_normalize_enabled}
                           onChange={e => f('mobile_normalize_enabled', e.target.checked)} />
                    <span className="text-sm font-medium text-text-primary">Enable Mobile Formatting</span>
                  </label>

                  {form.mobile_normalize_enabled && (
                    <div className="pl-5 space-y-3">
                      <label className="flex items-center gap-2 cursor-pointer">
                        <input type="checkbox" checked={form.mobile_strip_leading_zero}
                               onChange={e => f('mobile_strip_leading_zero', e.target.checked)} />
                        <span className="text-sm text-text-primary">Strip Leading Zero</span>
                      </label>
                      <div className="grid grid-cols-2 gap-3">
                        <div>
                          <label className="label text-xs">Prefix</label>
                          <input className="input font-mono text-xs" value={form.mobile_prefix}
                                 onChange={e => f('mobile_prefix', e.target.value)}
                                 placeholder="e.g. +966, 966, 9" />
                        </div>
                        <div>
                          <label className="label text-xs">Suffix</label>
                          <input className="input font-mono text-xs" value={form.mobile_suffix}
                                 onChange={e => f('mobile_suffix', e.target.value)}
                                 placeholder="e.g. # (rare)" />
                        </div>
                      </div>

                      {/* Live preview */}
                      <div className="flex items-center gap-2 bg-surface-hover rounded-md px-3 py-2 text-xs font-mono">
                        <span className="text-text-muted">{mobilePreviewRaw}</span>
                        <span className="text-text-muted">→</span>
                        <span className={`font-semibold ${mobilePreviewOut !== mobilePreviewRaw ? 'text-brand' : 'text-text-muted'}`}>
                          {mobilePreviewOut}
                        </span>
                      </div>
                    </div>
                  )}
                </div>
              )}
            </Section>

            {/* ── Extension Dialing Rules ── */}
            <Section id="extension" title="Extension Dialing Rules" open={openSections.has('extension')} onToggle={toggleSection}>
              <label className="flex items-center gap-2 cursor-pointer">
                <input type="checkbox" checked={form.allow_extension}
                       onChange={e => f('allow_extension', e.target.checked)} />
                <span className="text-sm font-medium text-text-primary">Allow Extension Numbers</span>
              </label>

              {form.allow_extension && (
                <div className="border border-border rounded-lg p-3 space-y-3">
                  <label className="flex items-center gap-2 cursor-pointer">
                    <input type="checkbox" checked={form.ext_normalize_enabled}
                           onChange={e => f('ext_normalize_enabled', e.target.checked)} />
                    <span className="text-sm font-medium text-text-primary">Enable Extension Formatting</span>
                  </label>

                  {form.ext_normalize_enabled && (
                    <div className="pl-5 space-y-3">
                      <div className="grid grid-cols-2 gap-3">
                        <div>
                          <label className="label text-xs">Prefix</label>
                          <input className="input font-mono text-xs" value={form.ext_prefix}
                                 onChange={e => f('ext_prefix', e.target.value)}
                                 placeholder="e.g. 8, 9" />
                        </div>
                        <div>
                          <label className="label text-xs">Suffix</label>
                          <input className="input font-mono text-xs" value={form.ext_suffix}
                                 onChange={e => f('ext_suffix', e.target.value)}
                                 placeholder="e.g. # (rare)" />
                        </div>
                      </div>

                      {/* Live preview */}
                      <div className="flex items-center gap-2 bg-surface-hover rounded-md px-3 py-2 text-xs font-mono">
                        <span className="text-text-muted">{extPreviewRaw}</span>
                        <span className="text-text-muted">→</span>
                        <span className={`font-semibold ${extPreviewOut !== extPreviewRaw ? 'text-brand' : 'text-text-muted'}`}>
                          {extPreviewOut}
                        </span>
                      </div>
                    </div>
                  )}
                </div>
              )}
            </Section>

            {/* ── Announcements ── */}
            <Section id="announcements" title="Announcements" open={openSections.has('announcements')} onToggle={toggleSection}>
              <div>
                <label className="label">No Pending Message</label>
                <input className="input" value={form.no_pending_msg}
                       onChange={e => f('no_pending_msg', e.target.value)}
                       placeholder="Spoken when there is no active blast" />
              </div>
              <div>
                <label className="label">Expiry Announcement</label>
                <input className="input" value={form.expiry_announcement}
                       onChange={e => f('expiry_announcement', e.target.value)}
                       placeholder="Spoken when the recording has expired" />
              </div>
            </Section>

            {/* ── Blast Recipients ── */}
            <Section id="recipients" title="Blast Recipients" open={openSections.has('recipients')} onToggle={toggleSection}>
              <ContactPicker
                groups={orgGroups}
                contacts={orgContacts}
                selectedGroupIds={form.group_ids}
                selectedContactIds={form.contact_ids}
                onChange={({ group_ids, contact_ids }) => setForm(p => ({ ...p, group_ids, contact_ids }))}
              />
            </Section>

            {error && <p className="text-sm text-red-500 pt-1">{error}</p>}
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
