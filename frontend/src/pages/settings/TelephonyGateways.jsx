import { useEffect, useState } from 'react';
import { Plus, Pencil, Trash2, UploadCloud, CheckCircle, XCircle, Star } from 'lucide-react';
import { api } from '../../api/client.js';
import Modal from '../../components/ui/Modal.jsx';
import { Table, Th, Td, Tr, EmptyRow } from '../../components/ui/Table.jsx';

// Every key here has a rendered field below — see [[C6/C8 audit]] earlier
// this session: a state key with no matching form control is exactly the
// bug class that kept recurring in this codebase (ServiceRegistry,
// ContactList, LocationList all hit variants of it).
const EMPTY = {
  name: '', type: 'generic_sip', host: '', port: 5060,
  username: '', password: '', register: true, caller_id_in_from: false,
  is_default_outbound: false, is_active: true,
  // Dialing policy (migration 035)
  allow_mobile:              true,
  allow_extension:           false,
  mobile_normalize_enabled:  false,
  mobile_strip_leading_zero: false,
  mobile_prefix:             '',
  mobile_suffix:             '',
  ext_normalize_enabled:     false,
  ext_prefix:                '',
  ext_suffix:                '',
};

const TYPE_LABELS = { avaya: 'Avaya Aura', cisco: 'Cisco UC', generic_sip: 'Generic SIP', other: 'Other' };

export default function TelephonyGateways() {
  const [rows,  setRows]  = useState([]);
  const [modal, setModal] = useState(null);
  const [form,  setForm]  = useState(EMPTY);
  const [saving, setSaving] = useState(false);
  const [deploying, setDeploying] = useState(null);
  const [error, setError] = useState('');

  async function load() {
    try {
      const r = await api.gateways.list();
      setRows(r.gateways || []);
    } catch {}
  }
  useEffect(() => { load(); }, []);

  const f = (k, v) => setForm(p => ({ ...p, [k]: v }));

  async function handleSave() {
    setSaving(true); setError('');
    try {
      const payload = {
        ...form,
        port:         Number(form.port) || 5060,
        mobile_prefix: form.mobile_prefix || null,
        mobile_suffix: form.mobile_suffix || null,
        ext_prefix:    form.ext_prefix    || null,
        ext_suffix:    form.ext_suffix    || null,
      };
      if (!modal.id) await api.gateways.create(payload);
      else           await api.gateways.update(modal.id, payload);
      setModal(null); load();
    } catch (e) { setError(e.message); } finally { setSaving(false); }
  }

  function openCreate() { setForm(EMPTY); setModal({}); setError(''); }
  function openEdit(r) {
    setForm({
      name: r.name, type: r.type, host: r.host, port: r.port,
      username: r.username || '', password: '', // never pre-fill password from a masked read
      register: r.register, caller_id_in_from: r.caller_id_in_from,
      is_default_outbound: r.is_default_outbound, is_active: r.is_active,
      allow_mobile:              r.allow_mobile              ?? true,
      allow_extension:           r.allow_extension           ?? false,
      mobile_normalize_enabled:  r.mobile_normalize_enabled  ?? false,
      mobile_strip_leading_zero: r.mobile_strip_leading_zero ?? false,
      mobile_prefix:             r.mobile_prefix             ?? '',
      mobile_suffix:             r.mobile_suffix             ?? '',
      ext_normalize_enabled:     r.ext_normalize_enabled     ?? false,
      ext_prefix:                r.ext_prefix                ?? '',
      ext_suffix:                r.ext_suffix                ?? '',
    });
    setModal(r); setError('');
  }

  async function del(r) {
    if (!confirm(`Delete gateway "${r.name}"? Calls using it will fall back to internal dialing.`)) return;
    try { await api.gateways.remove(r.id); load(); } catch (e) { alert(e.message); }
  }

  async function deploy(r) {
    setDeploying(r.id);
    try {
      const result = await api.gateways.deploy(r.id);
      alert(result.status === 'success'
        ? `Deployed and verified — ${r.name} is registering with FreeSWITCH.`
        : `Deployed but verification failed: ${result.verify_detail || result.reload_error || 'unknown error'}`);
      load();
    } catch (e) { alert(e.message); } finally { setDeploying(null); }
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-bold text-text-primary">Telephony Gateways</h1>
          <p className="text-xs text-text-muted mt-0.5">
            Connect a real Avaya/Cisco/SIP trunk — with none configured, every
            call defaults to internal SIP extensions automatically.
          </p>
        </div>
        <button onClick={openCreate} className="btn-primary flex items-center gap-1.5"><Plus size={15} /> Add Gateway</button>
      </div>

      <Table>
        <thead><tr className="bg-surface-hover">
          <Th>Name</Th><Th>Type</Th><Th>Host</Th><Th>Default</Th><Th>Deploy Status</Th><Th></Th>
        </tr></thead>
        <tbody>
          {rows.length === 0 ? <EmptyRow cols={6} /> : rows.map(r => (
            <Tr key={r.id}>
              <Td className="font-medium">{r.name}</Td>
              <Td className="text-text-muted">{TYPE_LABELS[r.type] || r.type}</Td>
              <Td className="text-text-muted">{r.host}:{r.port}</Td>
              <Td>{r.is_default_outbound && <Star size={13} className="text-brand" />}</Td>
              <Td>
                {r.last_deployment_status === 'success'
                  ? <span className="flex items-center gap-1 text-green-500 text-xs"><CheckCircle size={12} /> Live</span>
                  : r.last_deployment_status === 'failed'
                  ? <span className="flex items-center gap-1 text-red-400 text-xs"><XCircle size={12} /> Failed</span>
                  : <span className="text-text-muted text-xs">Not deployed</span>}
              </Td>
              <Td>
                <div className="flex gap-1 justify-end">
                  <button onClick={() => deploy(r)} disabled={deploying === r.id} className="btn-ghost p-1.5" title="Deploy to FreeSWITCH">
                    <UploadCloud size={13} />
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
        <Modal title={modal.id ? 'Edit Gateway' : 'Add Gateway'} onClose={() => setModal(null)}>
          <div className="space-y-3">
            <div><label className="label">Name</label>
              <input className="input" value={form.name} onChange={e => f('name', e.target.value)}
                     placeholder="avaya_main" disabled={!!modal.id} />
              <p className="text-[10px] text-text-muted mt-1">Must match the FreeSWITCH gateway name — cannot be changed after creation.</p>
            </div>
            <div><label className="label">Type</label>
              <select className="input" value={form.type} onChange={e => f('type', e.target.value)}>
                {Object.entries(TYPE_LABELS).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
              </select>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div><label className="label">Host</label>
                <input className="input" value={form.host} onChange={e => f('host', e.target.value)} placeholder="10.0.0.5" /></div>
              <div><label className="label">Port</label>
                <input className="input" type="number" value={form.port} onChange={e => f('port', e.target.value)} /></div>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div><label className="label">Username</label>
                <input className="input" value={form.username} onChange={e => f('username', e.target.value)} /></div>
              <div><label className="label">Password</label>
                <input className="input" type="password" value={form.password} onChange={e => f('password', e.target.value)}
                       placeholder={modal.id ? '(unchanged)' : ''} /></div>
            </div>
            <label className="flex items-center gap-2 text-sm text-text-primary">
              <input type="checkbox" checked={form.register} onChange={e => f('register', e.target.checked)} />
              Register with this gateway (uncheck for IP-authenticated trunks)
            </label>
            <label className="flex items-center gap-2 text-sm text-text-primary">
              <input type="checkbox" checked={form.caller_id_in_from} onChange={e => f('caller_id_in_from', e.target.checked)} />
              Put caller ID in From header (some PBXs require this)
            </label>
            <label className="flex items-center gap-2 text-sm text-text-primary">
              <input type="checkbox" checked={form.is_default_outbound} onChange={e => f('is_default_outbound', e.target.checked)} />
              Default outbound gateway for this tenant
            </label>
            <label className="flex items-center gap-2 text-sm text-text-primary">
              <input type="checkbox" checked={form.is_active} onChange={e => f('is_active', e.target.checked)} />
              Active
            </label>

            {/* ── Dialing Rules ── */}
            <div className="border-t border-border pt-3 space-y-3">
              <p className="text-xs font-bold text-text-secondary uppercase tracking-wider">Dialing Rules</p>
              <p className="text-[11px] text-text-muted">
                Controls which number types this gateway accepts and how they are formatted before dialing.
              </p>

              <div className="flex gap-5">
                <label className="flex items-center gap-2 cursor-pointer text-sm text-text-primary">
                  <input type="checkbox" checked={form.allow_mobile}
                         onChange={e => f('allow_mobile', e.target.checked)} />
                  Allow Mobile Numbers
                </label>
                <label className="flex items-center gap-2 cursor-pointer text-sm text-text-primary">
                  <input type="checkbox" checked={form.allow_extension}
                         onChange={e => f('allow_extension', e.target.checked)} />
                  Allow Extensions
                </label>
              </div>

              {/* Mobile formatting */}
              <div className="border border-border rounded-lg p-3">
                <label className="flex items-center gap-2 cursor-pointer">
                  <input type="checkbox" checked={form.mobile_normalize_enabled}
                         onChange={e => f('mobile_normalize_enabled', e.target.checked)} />
                  <span className="text-sm font-medium text-text-primary">Mobile Formatting</span>
                </label>
                {form.mobile_normalize_enabled && (
                  <div className="mt-3 pl-6 space-y-2">
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
                    <p className="text-[11px] text-text-muted">
                      Example: 0507221769 → strip 0 → 507221769 → add +966 → +966507221769
                    </p>
                  </div>
                )}
              </div>

              {/* Extension formatting */}
              <div className="border border-border rounded-lg p-3">
                <label className="flex items-center gap-2 cursor-pointer">
                  <input type="checkbox" checked={form.ext_normalize_enabled}
                         onChange={e => f('ext_normalize_enabled', e.target.checked)} />
                  <span className="text-sm font-medium text-text-primary">Extension Formatting</span>
                </label>
                {form.ext_normalize_enabled && (
                  <div className="mt-3 pl-6 grid grid-cols-2 gap-3">
                    <div>
                      <label className="label text-xs">Prefix</label>
                      <input className="input font-mono text-xs" value={form.ext_prefix}
                             onChange={e => f('ext_prefix', e.target.value)}
                             placeholder="e.g. 8" />
                    </div>
                    <div>
                      <label className="label text-xs">Suffix</label>
                      <input className="input font-mono text-xs" value={form.ext_suffix}
                             onChange={e => f('ext_suffix', e.target.value)}
                             placeholder="e.g. #" />
                    </div>
                    <p className="text-[11px] text-text-muted col-span-2">
                      Example: 1001 → add prefix 8 → 81001
                    </p>
                  </div>
                )}
              </div>
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
