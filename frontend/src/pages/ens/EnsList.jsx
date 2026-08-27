import { useEffect, useState, useMemo, useCallback, useRef } from 'react';
import { useAuthStore } from '../../store/authStore.js';
import { Plus, Pencil, Trash2, ToggleLeft, ToggleRight, Users, User, ChevronDown, Search, Play, Check, X } from 'lucide-react';
import { api } from '../../api/client.js';
import Modal from '../../components/ui/Modal.jsx';
import { Table, Th, Td, Tr, EmptyRow } from '../../components/ui/Table.jsx';
import Badge from '../../components/ui/Badge.jsx';
import ContactPicker from '../../components/ui/ContactPicker.jsx';
import PageHeader from '../../components/ui/PageHeader.jsx';

// ── Collapsible section wrapper ───────────────────────────────────────────────

function Section({ id, title, open, onToggle, children }) {
  return (
    <div className="border border-surface-border rounded-lg overflow-hidden">
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

// ── Media picker (reused from PropertyPanel pattern) ─────────────────────────

function MediaPickerField({ value, onChange }) {
  const [open, setOpen]       = useState(false);
  const [query, setQuery]     = useState('');
  const [results, setResults] = useState([]);
  const [loading, setLoading] = useState(false);
  const [previewId, setPreviewId] = useState(null);
  const audioRef = useRef(null);
  const timerRef = useRef(null);
  const displayName = value ? value.replace(/^\/media\//, '') : '';

  const search = useCallback(async (q) => {
    setLoading(true);
    try {
      const r = await api.mediaLibrary.list({ search: q || undefined, limit: 30, deployed: 'true' });
      setResults(r.files || []);
    } catch { setResults([]); } finally { setLoading(false); }
  }, []);

  useEffect(() => {
    if (!open) return;
    clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => search(query), 250);
    return () => clearTimeout(timerRef.current);
  }, [query, open, search]);

  useEffect(() => { if (open) search(query); }, [open]); // eslint-disable-line react-hooks/exhaustive-deps

  function selectFile(file) {
    const leaf = file.fs_path
      ? file.fs_path.split('/').pop()
      : file.path_or_uri ? file.path_or_uri.split('/').pop() : file.name || String(file.id);
    onChange('/media/' + leaf);
    setOpen(false);
    setPreviewId(null);
  }

  function togglePreview(fileId, e) {
    e.stopPropagation();
    if (previewId === fileId) { audioRef.current?.pause(); setPreviewId(null); }
    else setPreviewId(fileId);
  }

  return (
    <div className="space-y-1">
      <div className="flex gap-1.5 items-center">
        <div className="flex-1 bg-surface border border-surface-border rounded-lg px-2.5 py-1.5 text-xs font-mono text-text-primary truncate min-w-0">
          {displayName || <span className="text-text-muted">No file selected</span>}
        </div>
        {value && (
          <button onClick={() => onChange('')} title="Clear" className="text-text-muted hover:text-red-400 p-1 shrink-0">
            <X size={12} />
          </button>
        )}
        <button
          onClick={() => setOpen(o => !o)}
          className="shrink-0 flex items-center gap-1 px-2 py-1.5 rounded-lg text-xs bg-brand/10 text-brand border border-brand/20 hover:bg-brand/20 transition-colors"
        >
          <Search size={11} /> Browse
        </button>
      </div>
      {open && (
        <div className="border border-surface-border rounded-lg bg-surface shadow-lg overflow-hidden">
          <div className="flex items-center gap-2 px-2.5 py-2 border-b border-surface-border">
            <Search size={12} className="text-text-muted shrink-0" />
            <input autoFocus value={query} onChange={e => setQuery(e.target.value)}
              placeholder="Search media…"
              className="flex-1 bg-transparent text-xs text-text-primary placeholder:text-text-muted outline-none" />
            {loading && <span className="text-[9px] text-text-muted">Loading…</span>}
          </div>
          <div className="max-h-48 overflow-y-auto">
            {results.length === 0 && !loading && (
              <div className="px-3 py-4 text-center text-[10px] text-text-muted">
                {query ? 'No files match your search' : 'No deployed media files found'}
              </div>
            )}
            {results.map(file => {
              const leaf     = file.fs_path ? file.fs_path.split('/').pop() : file.name;
              const mediaUrl = '/media/' + leaf;
              const selected = value === mediaUrl;
              const durRaw   = file.duration_sec;
              const durNum   = durRaw == null ? null : Number(durRaw);
              const dur      = (durNum != null && !isNaN(durNum) && durNum > 0)
                ? (durNum < 60 ? `${durNum.toFixed(0)}s` : `${(durNum / 60).toFixed(1)}m`) : null;
              return (
                <div key={file.id} onClick={() => selectFile(file)}
                  className={`flex items-center gap-2 px-2.5 py-2 cursor-pointer hover:bg-surface-hover border-b border-surface-border/50 last:border-0 ${selected ? 'bg-brand/5' : ''}`}>
                  <button onClick={e => togglePreview(file.id, e)}
                    className="shrink-0 text-text-muted hover:text-brand p-0.5" title="Preview">
                    <Play size={10} className={previewId === file.id ? 'text-brand' : ''} />
                  </button>
                  <div className="flex-1 min-w-0">
                    <p className="text-xs text-text-primary truncate">{file.name}</p>
                    <p className="text-[9px] text-text-muted truncate">{[file.category, dur].filter(Boolean).join(' · ')}</p>
                  </div>
                  {selected && <Check size={11} className="text-brand shrink-0" />}
                </div>
              );
            })}
          </div>
          {previewId && (
            <audio ref={audioRef} autoPlay src={api.mediaLibrary.streamUrl(previewId)}
              onEnded={() => setPreviewId(null)} className="hidden" />
          )}
        </div>
      )}
    </div>
  );
}

// ── Per-announcement source selector ─────────────────────────────────────────

function AnnouncementField({ sourceType, text, audioUrl, onSourceType, onText, onAudioUrl, textPlaceholder }) {
  return (
    <div className="space-y-2">
      <div className="flex gap-3">
        {['tts', 'audio'].map(st => (
          <label key={st} className="flex items-center gap-1.5 cursor-pointer select-none text-xs text-text-secondary">
            <input type="radio" name={undefined} checked={sourceType === st} onChange={() => onSourceType(st)}
              className="accent-brand" />
            {st === 'tts' ? 'Text to Speech' : 'Audio File'}
          </label>
        ))}
      </div>
      {sourceType === 'tts' ? (
        <input className="input" value={text} onChange={e => onText(e.target.value)} placeholder={textPlaceholder} />
      ) : (
        <MediaPickerField value={audioUrl} onChange={onAudioUrl} />
      )}
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
  gateway_override:          '',
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
  no_pending_source_type:    'tts',
  no_pending_msg:            '',
  no_pending_audio_url:      '',
  expiry_source_type:        'tts',
  expiry_announcement:       '',
  expiry_audio_url:          '',
  unauthorized_source_type:  'tts',
  unauthorized_msg:          '',
  unauthorized_audio_url:    '',
  // Recipients
  group_ids:                 [],
  contact_ids:               [],
};

// ── Component ─────────────────────────────────────────────────────────────────

export default function EnsList() {
  const activeTenantId = useAuthStore(s => s.activeTenantId);
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

  useEffect(() => { setModal(null); load(); }, [activeTenantId]); // eslint-disable-line react-hooks/exhaustive-deps

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
        gateway_override:          form.gateway_override        || null,
        no_pending_source_type:    form.no_pending_source_type  || 'tts',
        no_pending_msg:            form.no_pending_msg          || null,
        no_pending_audio_url:      form.no_pending_audio_url    || null,
        expiry_source_type:        form.expiry_source_type      || 'tts',
        expiry_announcement:       form.expiry_announcement     || null,
        expiry_audio_url:          form.expiry_audio_url        || null,
        unauthorized_source_type:  form.unauthorized_source_type || 'tts',
        unauthorized_msg:          form.unauthorized_msg        || null,
        unauthorized_audio_url:    form.unauthorized_audio_url  || null,
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
        gateway_override:          full.gateway_override         ?? '',
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
        no_pending_source_type:    full.no_pending_source_type   ?? 'tts',
        no_pending_msg:            full.no_pending_msg           ?? '',
        no_pending_audio_url:      full.no_pending_audio_url     ?? '',
        expiry_source_type:        full.expiry_source_type       ?? 'tts',
        expiry_announcement:       full.expiry_announcement      ?? '',
        expiry_audio_url:          full.expiry_audio_url         ?? '',
        unauthorized_source_type:  full.unauthorized_source_type ?? 'tts',
        unauthorized_msg:          full.unauthorized_msg         ?? '',
        unauthorized_audio_url:    full.unauthorized_audio_url   ?? '',
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
    <div className="space-y-6">
      <PageHeader title="ENS Configurations">
        <button onClick={openCreate} className="btn-primary">
          <Plus size={15} /> Add ENS
        </button>
      </PageHeader>

      <Table>
        <thead><tr>
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
                  {(r.bound_numbers || []).length === 0
                    ? <span className="text-text-muted">—</span>
                    : (r.bound_numbers || []).map(n => (
                        <div key={n.number} className="text-text-primary" title={n.service_name || ''}>
                          {n.number}
                        </div>
                      ))
                  }
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
                {/* Row 1: Default Gateway | Gateway Override */}
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
                    Select a gateway registered in the Telephony Gateways module.
                  </p>
                </div>
                <div>
                  <label className="label">FreeSWITCH Gateway Name</label>
                  <input
                    className={`input font-mono ${form.gateway_override && !/^[a-zA-Z0-9\-_.]+$/.test(form.gateway_override) ? 'border-red-400 focus:ring-red-400' : ''}`}
                    value={form.gateway_override}
                    onChange={e => f('gateway_override', e.target.value)}
                    placeholder="service-provider"
                    maxLength={255}
                  />
                  {form.gateway_override && !/^[a-zA-Z0-9\-_.]+$/.test(form.gateway_override)
                    ? <p className="text-[11px] text-red-500 mt-1">Only letters, numbers, -, _, and . are allowed.</p>
                    : <p className="text-[11px] text-text-muted mt-1">Optional. Enter an existing FreeSWITCH gateway name. Leave empty to use the selected gateway.</p>
                  }
                </div>

                {/* Row 2: Routing Mode | Skip Behaviour */}
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
                  <label className="label">Skip Behaviour</label>
                  <select className="input" value={form.skip_behavior}
                          onChange={e => f('skip_behavior', e.target.value)}>
                    <option value="skip">Skip Contact</option>
                    <option value="warn">Warning Only</option>
                    <option value="fail">Fail Campaign</option>
                  </select>
                  <p className="text-[11px] text-text-muted mt-1">When a contact has no dialable number</p>
                </div>

                {/* Row 3: Dial Preference */}
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

                {/* Routing priority — informational */}
                <div className="col-span-2 rounded-lg bg-surface-hover border border-surface-border px-3 py-2">
                  <p className="text-[10px] font-semibold text-text-secondary uppercase tracking-wide mb-1">Routing Priority</p>
                  <ol className="text-[11px] text-text-muted space-y-0.5 list-decimal list-inside">
                    <li><span className="text-text-primary font-medium">FreeSWITCH Gateway Name</span> — manual XML-only gateway</li>
                    <li>Selected Gateway — managed gateway from dropdown above</li>
                    <li>Organization Default Gateway</li>
                    <li>Tenant Default Gateway</li>
                    <li>Platform Default Gateway</li>
                    <li>Internal Routing</li>
                  </ol>
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
                <div className="border border-surface-border rounded-lg p-3 space-y-3">
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
                <div className="border border-surface-border rounded-lg p-3 space-y-3">
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
                <p className="text-[10px] text-text-muted mb-1.5">Played when the caller is authorized but no blast has been sent yet.</p>
                <AnnouncementField
                  sourceType={form.no_pending_source_type}
                  text={form.no_pending_msg}
                  audioUrl={form.no_pending_audio_url}
                  onSourceType={v => f('no_pending_source_type', v)}
                  onText={v => f('no_pending_msg', v)}
                  onAudioUrl={v => f('no_pending_audio_url', v)}
                  textPlaceholder="There are no pending emergency notifications at this time."
                />
              </div>
              <div>
                <label className="label">Expiry Announcement</label>
                <p className="text-[10px] text-text-muted mb-1.5">Played when the latest campaign has passed its retention window.</p>
                <AnnouncementField
                  sourceType={form.expiry_source_type}
                  text={form.expiry_announcement}
                  audioUrl={form.expiry_audio_url}
                  onSourceType={v => f('expiry_source_type', v)}
                  onText={v => f('expiry_announcement', v)}
                  onAudioUrl={v => f('expiry_audio_url', v)}
                  textPlaceholder="This emergency notification has expired."
                />
              </div>
              <div>
                <label className="label">Unauthorized Message</label>
                <p className="text-[10px] text-text-muted mb-1.5">Played when the caller is not in any blast destination list.</p>
                <AnnouncementField
                  sourceType={form.unauthorized_source_type}
                  text={form.unauthorized_msg}
                  audioUrl={form.unauthorized_audio_url}
                  onSourceType={v => f('unauthorized_source_type', v)}
                  onText={v => f('unauthorized_msg', v)}
                  onAudioUrl={v => f('unauthorized_audio_url', v)}
                  textPlaceholder="You are not authorized to access this message."
                />
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
