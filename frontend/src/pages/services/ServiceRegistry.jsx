import { useEffect, useState, useCallback } from 'react';
import {
  ShieldAlert, Phone, Radio, Activity, AlertCircle,
  Users, RefreshCw, ChevronDown, ChevronRight,
  Siren, Flame, Stethoscope, Shield, Bell,
  Plus, Pencil, Trash2,
} from 'lucide-react';
import { api } from '../../api/client.js';
import Modal from '../../components/ui/Modal.jsx';

// ── Static maps ───────────────────────────────────────────────────────────────

const SERVICE_COLORS = {
  red:    'bg-red-500/10 text-red-500 border-red-500/20',
  orange: 'bg-orange-500/10 text-orange-500 border-orange-500/20',
  blue:   'bg-blue-500/10 text-blue-500 border-blue-500/20',
  green:  'bg-green-500/10 text-green-500 border-green-500/20',
  yellow: 'bg-yellow-500/10 text-yellow-500 border-yellow-500/20',
  purple: 'bg-purple-500/10 text-purple-500 border-purple-500/20',
};

const ICON_MAP = {
  'shield-alert': ShieldAlert,
  flame:          Flame,
  stethoscope:    Stethoscope,
  shield:         Shield,
  bell:           Bell,
  siren:          Siren,
  phone:          Phone,
  radio:          Radio,
  activity:       Activity,
};

const SERVICE_TYPES = ['ENS', 'ERS', 'IVR', 'REJOIN', 'OPEN_ACCESS'];
const COLORS        = ['red', 'orange', 'blue', 'green', 'yellow', 'purple'];
const ICONS         = Object.keys(ICON_MAP);

const EMPTY_FORM = {
  number:               '',
  type:                 'ENS',
  organization_id:      '',
  service_name:         '',
  description:          '',
  ens_configuration_id: '',
  ers_configuration_id: '',
  ivr_flow_id:          '',
  icon:                 'shield-alert',
  color:                'red',
  sort_order:           0,
  is_active:            true,
};

// ── Small display components ──────────────────────────────────────────────────

function ServiceIcon({ icon, color, size = 20 }) {
  const Ic  = ICON_MAP[icon]  || ShieldAlert;
  const col = SERVICE_COLORS[color] || SERVICE_COLORS.red;
  return (
    <div className={`w-10 h-10 rounded-lg border flex items-center justify-center shrink-0 ${col}`}>
      <Ic size={size} />
    </div>
  );
}

function TypeBadge({ type }) {
  const colors = {
    ENS:         'bg-brand/10 text-brand border-brand/20',
    ERS:         'bg-red-500/10 text-red-500 border-red-500/20',
    IVR:         'bg-purple-500/10 text-purple-500 border-purple-500/20',
    REJOIN:      'bg-amber-500/10 text-amber-500 border-amber-500/20',
    OPEN_ACCESS: 'bg-green-500/10 text-green-500 border-green-500/20',
  };
  return (
    <span className={`inline-flex items-center px-2 py-0.5 rounded text-[10px] font-bold tracking-wider uppercase border ${colors[type] || 'bg-surface-raised text-text-muted border-surface-border'}`}>
      {type}
    </span>
  );
}

function LiveCount({ value, label, warn = false }) {
  if (!value) return null;
  return (
    <div className={`flex items-center gap-1 px-2 py-0.5 rounded border text-xs font-semibold ${warn && value > 0 ? 'border-red-500/30 bg-red-500/10 text-red-400' : 'border-surface-border bg-surface-raised text-text-secondary'}`}>
      <Activity size={10} />
      <span>{value}</span>
      <span className="text-text-muted font-normal">{label}</span>
    </div>
  );
}

// ── ENS / ERS live panels ─────────────────────────────────────────────────────

function EnsPanel({ service, onTrigger }) {
  return (
    <div className="mt-4 pt-4 border-t border-surface-border">
      <div className="flex items-center justify-between mb-3">
        <span className="text-xs font-semibold text-text-secondary uppercase tracking-wide">Campaign Engine</span>
        <LiveCount value={service.active_campaigns} label="active" warn />
      </div>
      <div className="grid grid-cols-2 gap-2 text-xs">
        <div><span className="text-text-muted">Max Concurrent</span><div className="text-text-primary font-mono">{service.max_concurrent_calls ?? 30}</div></div>
        <div><span className="text-text-muted">CPS</span><div className="text-text-primary font-mono">{service.calls_per_second ?? 2}/s</div></div>
        <div><span className="text-text-muted">Max Attempts</span><div className="text-text-primary font-mono">{service.max_attempts ?? 3}</div></div>
        <div><span className="text-text-muted">Adaptive</span><div className={`font-semibold ${service.adaptive_throttling ? 'text-green-400' : 'text-text-muted'}`}>{service.adaptive_throttling ? 'ON' : 'OFF'}</div></div>
      </div>
      <button onClick={() => onTrigger(service)} className="mt-3 w-full btn-primary text-sm py-1.5">
        <Bell size={13} className="inline mr-1.5" /> Trigger Campaign
      </button>
    </div>
  );
}

function ErsPanel({ service }) {
  return (
    <div className="mt-4 pt-4 border-t border-surface-border">
      <div className="flex items-center justify-between mb-3">
        <span className="text-xs font-semibold text-text-secondary uppercase tracking-wide">Response Status</span>
        <div className="flex gap-1.5">
          <LiveCount value={service.active_incidents} label="active" warn />
          {service.queued_ers > 0 && <LiveCount value={service.queued_ers} label="queued" warn />}
        </div>
      </div>
      <div className="grid grid-cols-2 gap-2 text-xs">
        <div><span className="text-text-muted">Max Conferences</span><div className="text-text-primary font-mono">{service.max_concurrent_conferences ?? 2}</div></div>
        <div><span className="text-text-muted">Queue</span><div className={`font-semibold ${service.queue_enabled ? 'text-green-400' : 'text-text-muted'}`}>{service.queue_enabled ? 'Enabled' : 'Disabled'}</div></div>
        {service.primary_bridge_number   && <div><span className="text-text-muted">Bridge 1</span><div className="text-text-primary font-mono">{service.primary_bridge_number}</div></div>}
        {service.secondary_bridge_number && <div><span className="text-text-muted">Bridge 2</span><div className="text-text-primary font-mono">{service.secondary_bridge_number}</div></div>}
      </div>
    </div>
  );
}

// ── Service Card ──────────────────────────────────────────────────────────────

function ServiceCard({ service, onTrigger, onEdit, onDelete }) {
  const [expanded, setExpanded] = useState(false);
  return (
    <div className={`bg-surface-panel border rounded-xl overflow-hidden transition-all duration-200 ${!service.is_active ? 'opacity-50' : 'border-surface-border hover:border-surface-border/80'}`}>
      <div className="p-4 flex items-start gap-3">
        <div className="cursor-pointer flex-1 flex items-start gap-3 min-w-0" onClick={() => setExpanded(e => !e)}>
          <ServiceIcon icon={service.icon || 'shield-alert'} color={service.color || 'red'} />
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <span className="font-mono text-lg font-bold text-text-primary">{service.trigger_number}</span>
              <TypeBadge type={service.service_type} />
              {!service.is_active && (
                <span className="text-[10px] bg-surface-raised text-text-muted px-1.5 py-0.5 rounded border border-surface-border">INACTIVE</span>
              )}
            </div>
            <p className="text-sm font-semibold text-text-primary mt-0.5 truncate">
              {service.service_name || service.ens_config_name || service.ers_config_name || '—'}
            </p>
            {service.description && <p className="text-xs text-text-muted mt-0.5 truncate">{service.description}</p>}
          </div>
        </div>
        <div className="flex items-center gap-1 shrink-0">
          {service.service_type === 'ENS' && service.active_campaigns > 0 && <span className="w-2 h-2 rounded-full bg-green-400 animate-pulse" />}
          {service.service_type === 'ERS' && service.active_incidents > 0  && <span className="w-2 h-2 rounded-full bg-red-400 animate-pulse" />}
          <button onClick={() => onEdit(service)} className="btn-ghost p-1.5 ml-1" title="Edit service"><Pencil size={13} /></button>
          <button onClick={() => onDelete(service)} className="btn-ghost p-1.5 text-red-500" title="Delete service"><Trash2 size={13} /></button>
          <button onClick={() => setExpanded(e => !e)} className="btn-ghost p-1.5">
            {expanded ? <ChevronDown size={14} className="text-text-muted" /> : <ChevronRight size={14} className="text-text-muted" />}
          </button>
        </div>
      </div>

      {expanded && (
        <div className="px-4 pb-4">
          <div className="flex items-center gap-2 text-xs text-text-muted mb-3 border-t border-surface-border pt-3">
            <span>Config:</span>
            <span className="text-text-secondary font-medium">{service.service_type === 'ENS' ? service.ens_config_name : service.ers_config_name}</span>
            <span className="mx-1">·</span>
            <span>Org:</span>
            <span className="text-text-secondary font-medium">{service.organization_name || '—'}</span>
          </div>
          {service.service_type === 'ENS'
            ? <EnsPanel service={service} onTrigger={onTrigger} />
            : service.service_type === 'ERS'
              ? <ErsPanel service={service} />
              : null}
        </div>
      )}
    </div>
  );
}

// ── Campaign Trigger Modal ────────────────────────────────────────────────────

function TriggerModal({ service, onClose, onSuccess }) {
  const [messageText, setMessageText] = useState('');
  const [loading, setLoading]         = useState(false);
  const [error, setError]             = useState('');

  async function submit(e) {
    e.preventDefault();
    if (!messageText.trim()) { setError('Message text is required'); return; }
    setLoading(true); setError('');
    try {
      const result = await api.campaigns.trigger({ ens_configuration_id: service.ens_config_id, message_text: messageText });
      onSuccess(result);
    } catch (err) { setError(err.message || 'Failed to trigger campaign'); } finally { setLoading(false); }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm">
      <div className="bg-surface-panel border border-surface-border rounded-xl w-full max-w-md mx-4 shadow-2xl">
        <div className="p-5 border-b border-surface-border flex items-center gap-3">
          <ServiceIcon icon={service.icon || 'bell'} color={service.color || 'red'} />
          <div>
            <p className="font-semibold text-text-primary">Trigger ENS Campaign</p>
            <p className="text-xs text-text-muted">{service.trigger_number} · {service.service_name || service.ens_config_name}</p>
          </div>
        </div>
        <form onSubmit={submit} className="p-5 space-y-4">
          <div>
            <label className="label">Message (TTS fallback if no audio)</label>
            <textarea value={messageText} onChange={e => setMessageText(e.target.value)}
                      placeholder="Emergency notification message text…" rows={4}
                      className="input resize-none" />
          </div>
          {error && <div className="flex items-center gap-2 text-xs text-red-400 bg-red-500/10 border border-red-500/20 rounded p-2"><AlertCircle size={13} />{error}</div>}
          <div className="flex gap-2 pt-1">
            <button type="button" onClick={onClose} className="btn-secondary flex-1">Cancel</button>
            <button type="submit" disabled={loading} className="btn-primary flex-1">
              {loading ? 'Starting…' : 'Launch Campaign'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

// ── Create / Edit Service Modal ───────────────────────────────────────────────

function ServiceModal({ editRow, orgs, ensList, ersList, flowList, onClose, onSaved }) {
  const [form, setForm] = useState(editRow
    ? {
        number:               editRow.trigger_number ?? '',
        type:                 editRow.service_type   ?? 'ENS',
        organization_id:      editRow.organization_id ?? '',
        service_name:         editRow.service_name   ?? '',
        description:          editRow.description    ?? '',
        ens_configuration_id: editRow.ens_configuration_id ?? '',
        ers_configuration_id: editRow.ers_configuration_id ?? '',
        ivr_flow_id:          editRow.ivr_flow_id    ?? '',
        icon:                 editRow.icon            ?? 'shield-alert',
        color:                editRow.color           ?? 'red',
        sort_order:           editRow.sort_order      ?? 0,
        is_active:            editRow.is_active       ?? true,
      }
    : { ...EMPTY_FORM }
  );
  const [saving, setSaving] = useState(false);
  const [error,  setError]  = useState('');

  const f = (k, v) => setForm(p => ({ ...p, [k]: v }));

  async function save() {
    if (!form.number.trim()) { setError('Trigger number is required'); return; }
    setSaving(true); setError('');
    try {
      const payload = {
        ...form,
        organization_id:      Number(form.organization_id)      || null,
        ens_configuration_id: Number(form.ens_configuration_id) || null,
        ers_configuration_id: Number(form.ers_configuration_id) || null,
        ivr_flow_id:          Number(form.ivr_flow_id)          || null,
        sort_order:           Number(form.sort_order)           || 0,
        service_name:         form.service_name || null,
        description:          form.description  || null,
      };
      if (editRow?.id) await api.services.update(editRow.id, payload);
      else             await api.services.create(payload);
      onSaved();
    } catch (e) { setError(e.message); } finally { setSaving(false); }
  }

  const showEns = form.type === 'ENS';
  const showErs = form.type === 'ERS';
  const showIvr = form.type === 'IVR';

  return (
    <Modal title={editRow?.id ? 'Edit Service Number' : 'Register Service Number'} size="lg" onClose={onClose}>
      <div className="space-y-4">

        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="label">Trigger Number *</label>
            <input className="input font-mono" value={form.number} onChange={e => f('number', e.target.value)} placeholder="e.g. 1222" />
          </div>
          <div>
            <label className="label">Service Type *</label>
            <select className="input" value={form.type} onChange={e => f('type', e.target.value)}>
              {SERVICE_TYPES.map(t => <option key={t} value={t}>{t}</option>)}
            </select>
          </div>
        </div>

        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="label">Organization</label>
            <select className="input" value={form.organization_id} onChange={e => f('organization_id', e.target.value)}>
              <option value="">None</option>
              {orgs.map(o => <option key={o.id} value={o.id}>{o.name}</option>)}
            </select>
          </div>
          <div>
            <label className="label">Service Name</label>
            <input className="input" value={form.service_name} onChange={e => f('service_name', e.target.value)} placeholder="Shown to callers" />
          </div>
        </div>

        <div>
          <label className="label">Description</label>
          <input className="input" value={form.description} onChange={e => f('description', e.target.value)} placeholder="Optional description" />
        </div>

        {showEns && (
          <div>
            <label className="label">ENS Configuration</label>
            <select className="input" value={form.ens_configuration_id} onChange={e => f('ens_configuration_id', e.target.value)}>
              <option value="">None</option>
              {ensList.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
          </div>
        )}

        {showErs && (
          <div>
            <label className="label">ERS Configuration</label>
            <select className="input" value={form.ers_configuration_id} onChange={e => f('ers_configuration_id', e.target.value)}>
              <option value="">None</option>
              {ersList.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
          </div>
        )}

        {showIvr && (
          <div>
            <label className="label">IVR Flow</label>
            <select className="input" value={form.ivr_flow_id} onChange={e => f('ivr_flow_id', e.target.value)}>
              <option value="">None</option>
              {(flowList || []).map(fl => <option key={fl.flow_uuid} value={fl.id}>{fl.name}</option>)}
            </select>
          </div>
        )}

        <div className="grid grid-cols-3 gap-3">
          <div>
            <label className="label">Icon</label>
            <select className="input" value={form.icon} onChange={e => f('icon', e.target.value)}>
              {ICONS.map(i => <option key={i} value={i}>{i}</option>)}
            </select>
          </div>
          <div>
            <label className="label">Color</label>
            <select className="input" value={form.color} onChange={e => f('color', e.target.value)}>
              {COLORS.map(c => <option key={c} value={c}>{c}</option>)}
            </select>
          </div>
          <div>
            <label className="label">Sort Order</label>
            <input className="input" type="number" min="0" value={form.sort_order} onChange={e => f('sort_order', Number(e.target.value))} />
          </div>
        </div>

        <div className="flex items-center gap-2">
          <input type="checkbox" id="svcActive" checked={form.is_active} onChange={e => f('is_active', e.target.checked)} />
          <label htmlFor="svcActive" className="text-sm text-text-primary cursor-pointer">Active</label>
        </div>

        {error && <p className="text-sm text-red-500">{error}</p>}
        <div className="flex gap-2 justify-end pt-2">
          <button onClick={onClose} className="btn-secondary">Cancel</button>
          <button onClick={save} disabled={saving} className="btn-primary">
            {saving ? 'Saving…' : editRow?.id ? 'Update' : 'Register'}
          </button>
        </div>
      </div>
    </Modal>
  );
}

// ── Page ──────────────────────────────────────────────────────────────────────

export default function ServiceRegistry() {
  const [services, setServices]   = useState([]);
  const [orgs,     setOrgs]       = useState([]);
  const [ensList,  setEnsList]    = useState([]);
  const [ersList,  setErsList]    = useState([]);
  const [flowList, setFlowList]   = useState([]);
  const [loading,  setLoading]    = useState(true);
  const [error,    setError]      = useState('');
  const [filter,   setFilter]     = useState('ALL');
  const [trigger,  setTrigger]    = useState(null);
  const [editRow,  setEditRow]    = useState(null);   // null = closed, {} = create, row = edit
  const [success,  setSuccess]    = useState(null);

  const load = useCallback(async () => {
    setLoading(true); setError('');
    try {
      const [svc, o, ens, ers, ivr] = await Promise.all([
        api.services.list(),
        api.orgs.list(),
        api.ens.list(),
        api.ers.list(),
        api.ivr.list({ limit: 1000 }),
      ]);
      setServices(svc.services || []);
      setOrgs(o.organizations || []);
      setEnsList(ens.configurations || []);
      setErsList(ers.configurations || []);
      setFlowList(ivr.flows || []);
    } catch (e) { setError(e.message); } finally { setLoading(false); }
  }, []);

  useEffect(() => { load(); }, [load]);

  const visible = filter === 'ALL' ? services : services.filter(s => s.service_type === filter);

  const ensCount  = services.filter(s => s.service_type === 'ENS').length;
  const ersCount  = services.filter(s => s.service_type === 'ERS').length;
  const activeEns = services.filter(s => s.service_type === 'ENS' && s.active_campaigns > 0).length;
  const activeErs = services.filter(s => s.service_type === 'ERS' && s.active_incidents > 0).length;

  function onTriggerSuccess(campaign) {
    setTrigger(null);
    setSuccess(`Campaign started — ID: ${campaign.id?.slice(0, 8) || campaign.campaign_id}… · ${campaign.total_destinations ?? 0} destinations`);
    setTimeout(() => setSuccess(null), 6000);
    load();
  }

  async function onDelete(service) {
    if (!confirm(`Delete service number "${service.trigger_number} — ${service.service_name || service.service_type}"?`)) return;
    try { await api.services.remove(service.id); load(); } catch (e) { alert(e.message); }
  }

  return (
    <div className="p-6 max-w-6xl mx-auto">
      {/* Header */}
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-xl font-bold text-text-primary">Service Registry</h1>
          <p className="text-sm text-text-muted mt-0.5">All registered emergency trigger numbers</p>
        </div>
        <div className="flex items-center gap-2">
          <button onClick={load} disabled={loading} className="btn-ghost flex items-center gap-1.5">
            <RefreshCw size={14} className={loading ? 'animate-spin' : ''} /> Refresh
          </button>
          <button onClick={() => setEditRow({})} className="btn-primary flex items-center gap-1.5">
            <Plus size={15} /> Register Number
          </button>
        </div>
      </div>

      {/* Summary bar */}
      <div className="grid grid-cols-4 gap-3 mb-6">
        {[
          { label: 'Total Services', value: services.length, icon: ShieldAlert },
          { label: 'ENS Services',   value: ensCount,  icon: Bell,     sub: activeEns > 0 ? `${activeEns} active` : null, warn: activeEns > 0 },
          { label: 'ERS Services',   value: ersCount,  icon: Phone,    sub: activeErs > 0 ? `${activeErs} active` : null, warn: activeErs > 0 },
          { label: 'Live Activity',  value: activeEns + activeErs, icon: Activity, warn: (activeEns + activeErs) > 0 },
        ].map(({ label, value, icon: Icon, sub, warn }) => (
          <div key={label} className="bg-surface-panel border border-surface-border rounded-xl p-4">
            <div className="flex items-start justify-between">
              <div>
                <p className="text-xs text-text-muted mb-1">{label}</p>
                <p className={`text-2xl font-bold ${warn && value > 0 ? 'text-red-400' : 'text-text-primary'}`}>{value}</p>
                {sub && <p className="text-[10px] text-red-400 mt-0.5">{sub}</p>}
              </div>
              <Icon size={16} className="text-text-muted mt-0.5" />
            </div>
          </div>
        ))}
      </div>

      {success && (
        <div className="mb-4 flex items-center gap-2 bg-green-500/10 border border-green-500/20 text-green-400 text-sm rounded-lg px-4 py-2.5">
          <Activity size={14} />{success}
        </div>
      )}

      {/* Filter tabs */}
      <div className="flex gap-1 mb-4 bg-surface-raised rounded-lg p-1 w-fit">
        {['ALL', 'ENS', 'ERS', 'IVR'].map(t => (
          <button key={t} onClick={() => setFilter(t)}
            className={`px-4 py-1.5 rounded-md text-sm font-medium transition-colors ${filter === t ? 'bg-surface-panel text-text-primary shadow-sm' : 'text-text-muted hover:text-text-secondary'}`}>
            {t} {t === 'ALL' ? `(${services.length})` : t === 'ENS' ? `(${ensCount})` : t === 'ERS' ? `(${ersCount})` : `(${services.filter(s => s.service_type === 'IVR').length})`}
          </button>
        ))}
      </div>

      {error && (
        <div className="flex items-center gap-2 text-red-400 bg-red-500/10 border border-red-500/20 rounded-lg p-3 text-sm mb-4">
          <AlertCircle size={14} />{error}
        </div>
      )}

      {loading ? (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
          {[...Array(6)].map((_, i) => <div key={i} className="bg-surface-panel border border-surface-border rounded-xl p-4 h-28 animate-pulse" />)}
        </div>
      ) : visible.length === 0 ? (
        <div className="text-center py-16 text-text-muted">
          <ShieldAlert size={32} className="mx-auto mb-3 opacity-30" />
          <p className="text-sm">No {filter !== 'ALL' ? filter : ''} services registered</p>
          <button onClick={() => setEditRow({})} className="mt-3 btn-primary text-sm">
            <Plus size={13} className="inline mr-1" /> Register first service
          </button>
        </div>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
          {visible.map(s => (
            <ServiceCard
              key={s.id}
              service={s}
              onTrigger={setTrigger}
              onEdit={setEditRow}
              onDelete={onDelete}
            />
          ))}
        </div>
      )}

      {trigger && <TriggerModal service={trigger} onClose={() => setTrigger(null)} onSuccess={onTriggerSuccess} />}

      {editRow !== null && (
        <ServiceModal
          editRow={editRow?.id ? editRow : null}
          orgs={orgs}
          ensList={ensList}
          ersList={ersList}
          flowList={flowList}
          onClose={() => setEditRow(null)}
          onSaved={() => { setEditRow(null); load(); }}
        />
      )}
    </div>
  );
}
