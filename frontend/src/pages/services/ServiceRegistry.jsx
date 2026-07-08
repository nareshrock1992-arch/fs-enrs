import { useEffect, useState, useCallback } from 'react';
import {
  ShieldAlert, Phone, Radio, Activity, AlertCircle,
  Users, RefreshCw, ChevronDown, ChevronRight,
  Siren, Flame, Stethoscope, Shield, Bell
} from 'lucide-react';
import { api } from '../../api/client.js';

// ── Helpers ───────────────────────────────────────────────────────────────────

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

function ServiceIcon({ icon, color, size = 20 }) {
  const Ic = ICON_MAP[icon] || ShieldAlert;
  const col = SERVICE_COLORS[color] || SERVICE_COLORS.red;
  return (
    <div className={`w-10 h-10 rounded-lg border flex items-center justify-center shrink-0 ${col}`}>
      <Ic size={size} />
    </div>
  );
}

function TypeBadge({ type }) {
  return (
    <span className={`
      inline-flex items-center px-2 py-0.5 rounded text-[10px] font-bold tracking-wider uppercase
      ${type === 'ENS'
        ? 'bg-brand/10 text-brand border border-brand/20'
        : 'bg-red-500/10 text-red-500 border border-red-500/20'}
    `}>
      {type}
    </span>
  );
}

function StatusDot({ active, label }) {
  return (
    <div className="flex items-center gap-1.5">
      <span className={`w-2 h-2 rounded-full ${active ? 'bg-green-400' : 'bg-surface-border'}`} />
      <span className="text-xs text-text-muted">{label}</span>
    </div>
  );
}

function LiveCount({ value, label, warn = false }) {
  if (!value) return null;
  return (
    <div className={`
      flex items-center gap-1 px-2 py-0.5 rounded border text-xs font-semibold
      ${warn && value > 0
        ? 'border-red-500/30 bg-red-500/10 text-red-400'
        : 'border-surface-border bg-surface-raised text-text-secondary'}
    `}>
      <Activity size={10} />
      <span>{value}</span>
      <span className="text-text-muted font-normal">{label}</span>
    </div>
  );
}

// ── ENS Campaign Quick Panel ──────────────────────────────────────────────────

function EnsPanel({ service, onTrigger }) {
  return (
    <div className="mt-4 pt-4 border-t border-surface-border">
      <div className="flex items-center justify-between mb-3">
        <span className="text-xs font-semibold text-text-secondary uppercase tracking-wide">
          Campaign Engine
        </span>
        <LiveCount value={service.active_campaigns} label="active" warn />
      </div>
      <div className="grid grid-cols-2 gap-2 text-xs">
        <div className="flex flex-col gap-0.5">
          <span className="text-text-muted">Max Concurrent</span>
          <span className="text-text-primary font-mono">{service.max_concurrent_calls ?? 30}</span>
        </div>
        <div className="flex flex-col gap-0.5">
          <span className="text-text-muted">CPS</span>
          <span className="text-text-primary font-mono">{service.calls_per_second ?? 2}/s</span>
        </div>
        <div className="flex flex-col gap-0.5">
          <span className="text-text-muted">Max Attempts</span>
          <span className="text-text-primary font-mono">{service.max_attempts ?? 4}</span>
        </div>
        <div className="flex flex-col gap-0.5">
          <span className="text-text-muted">Adaptive</span>
          <span className={`font-semibold ${service.adaptive_throttling ? 'text-green-400' : 'text-text-muted'}`}>
            {service.adaptive_throttling ? 'ON' : 'OFF'}
          </span>
        </div>
      </div>
      <button
        onClick={() => onTrigger(service)}
        className="mt-3 w-full btn-primary text-sm py-1.5"
      >
        <Bell size={13} className="inline mr-1.5" />
        Trigger Campaign
      </button>
    </div>
  );
}

// ── ERS Live Panel ────────────────────────────────────────────────────────────

function ErsPanel({ service }) {
  return (
    <div className="mt-4 pt-4 border-t border-surface-border">
      <div className="flex items-center justify-between mb-3">
        <span className="text-xs font-semibold text-text-secondary uppercase tracking-wide">
          Response Status
        </span>
        <div className="flex gap-1.5">
          <LiveCount value={service.active_incidents} label="active" warn />
          {service.queued_ers > 0 && (
            <LiveCount value={service.queued_ers} label="queued" warn />
          )}
        </div>
      </div>
      <div className="grid grid-cols-2 gap-2 text-xs">
        <div className="flex flex-col gap-0.5">
          <span className="text-text-muted">Max Conferences</span>
          <span className="text-text-primary font-mono">{service.max_concurrent_conferences ?? 2}</span>
        </div>
        <div className="flex flex-col gap-0.5">
          <span className="text-text-muted">Queue</span>
          <span className={`font-semibold ${service.queue_enabled ? 'text-green-400' : 'text-text-muted'}`}>
            {service.queue_enabled ? 'Enabled' : 'Disabled'}
          </span>
        </div>
      </div>
    </div>
  );
}

// ── Service Card ──────────────────────────────────────────────────────────────

function ServiceCard({ service, onTrigger }) {
  const [expanded, setExpanded] = useState(false);

  return (
    <div className={`
      bg-surface-panel border rounded-xl overflow-hidden transition-all duration-200
      ${!service.is_active ? 'opacity-50' : 'border-surface-border hover:border-surface-border/80'}
    `}>
      {/* Header */}
      <div
        className="p-4 flex items-start gap-3 cursor-pointer"
        onClick={() => setExpanded(e => !e)}
      >
        <ServiceIcon icon={service.icon || 'shield-alert'} color={service.color || 'red'} />
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="font-mono text-lg font-bold text-text-primary">
              {service.trigger_number}
            </span>
            <TypeBadge type={service.service_type} />
            {!service.is_active && (
              <span className="text-[10px] bg-surface-raised text-text-muted px-1.5 py-0.5 rounded border border-surface-border">
                INACTIVE
              </span>
            )}
          </div>
          <p className="text-sm font-semibold text-text-primary mt-0.5 truncate">
            {service.service_name || (service.service_type === 'ENS' ? service.ens_config_name : service.ers_config_name) || '—'}
          </p>
          {service.description && (
            <p className="text-xs text-text-muted mt-0.5 truncate">{service.description}</p>
          )}
        </div>
        <div className="flex items-center gap-2 shrink-0">
          {service.service_type === 'ENS' && service.active_campaigns > 0 && (
            <span className="w-2 h-2 rounded-full bg-green-400 animate-pulse" title="Active campaigns" />
          )}
          {service.service_type === 'ERS' && service.active_incidents > 0 && (
            <span className="w-2 h-2 rounded-full bg-red-400 animate-pulse" title="Active incidents" />
          )}
          {expanded ? <ChevronDown size={14} className="text-text-muted" /> : <ChevronRight size={14} className="text-text-muted" />}
        </div>
      </div>

      {/* Expanded detail */}
      {expanded && (
        <div className="px-4 pb-4">
          <div className="flex items-center gap-2 text-xs text-text-muted mb-3 border-t border-surface-border pt-3">
            <span>Config:</span>
            <span className="text-text-secondary font-medium">
              {service.service_type === 'ENS' ? service.ens_config_name : service.ers_config_name}
            </span>
            <span className="mx-1">·</span>
            <span>Org:</span>
            <span className="text-text-secondary font-medium">{service.organization_name || '—'}</span>
          </div>

          {service.service_type === 'ENS'
            ? <EnsPanel service={service} onTrigger={onTrigger} />
            : <ErsPanel service={service} />
          }
        </div>
      )}
    </div>
  );
}

// ── Trigger Modal ─────────────────────────────────────────────────────────────

function TriggerModal({ service, onClose, onSuccess }) {
  const [messageText, setMessageText] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  async function submit(e) {
    e.preventDefault();
    if (!messageText.trim()) { setError('Message text is required'); return; }
    setLoading(true);
    setError('');
    try {
      const result = await api.campaigns.trigger({
        ens_configuration_id: service.ens_config_id,
        message_text: messageText,
      });
      onSuccess(result);
    } catch (err) {
      setError(err.message || 'Failed to trigger campaign');
    } finally {
      setLoading(false);
    }
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
            <label className="text-xs font-semibold text-text-secondary block mb-1.5">
              Message (TTS fallback if no audio)
            </label>
            <textarea
              value={messageText}
              onChange={e => setMessageText(e.target.value)}
              placeholder="Emergency notification message text…"
              rows={4}
              className="input-field w-full resize-none text-sm"
            />
          </div>
          {error && (
            <div className="flex items-center gap-2 text-xs text-red-400 bg-red-500/10 border border-red-500/20 rounded p-2">
              <AlertCircle size={13} />
              {error}
            </div>
          )}
          <div className="flex gap-2 pt-1">
            <button type="button" onClick={onClose} className="btn-ghost flex-1">Cancel</button>
            <button type="submit" disabled={loading} className="btn-primary flex-1">
              {loading ? 'Starting…' : 'Launch Campaign'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

// ── Page ──────────────────────────────────────────────────────────────────────

export default function ServiceRegistry() {
  const [services, setServices]   = useState([]);
  const [loading, setLoading]     = useState(true);
  const [error, setError]         = useState('');
  const [filter, setFilter]       = useState('ALL');  // ALL | ENS | ERS
  const [trigger, setTrigger]     = useState(null);   // service being triggered
  const [success, setSuccess]     = useState(null);

  const load = useCallback(async () => {
    setLoading(true); setError('');
    try {
      const data = await api.services.list();
      setServices(data.services || []);
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const visible = filter === 'ALL'
    ? services
    : services.filter(s => s.service_type === filter);

  const ensCount = services.filter(s => s.service_type === 'ENS').length;
  const ersCount = services.filter(s => s.service_type === 'ERS').length;
  const activeEns = services.filter(s => s.service_type === 'ENS' && s.active_campaigns > 0).length;
  const activeErs = services.filter(s => s.service_type === 'ERS' && s.active_incidents > 0).length;

  function onTriggerSuccess(campaign) {
    setTrigger(null);
    setSuccess(`Campaign started — ID: ${campaign.id.slice(0, 8)}… · ${campaign.total_destinations} destinations`);
    setTimeout(() => setSuccess(null), 6000);
    load();
  }

  return (
    <div className="p-6 max-w-6xl mx-auto">
      {/* Header */}
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-xl font-bold text-text-primary">Service Registry</h1>
          <p className="text-sm text-text-muted mt-0.5">
            All emergency trigger numbers — ERS and ENS
          </p>
        </div>
        <button onClick={load} disabled={loading} className="btn-ghost flex items-center gap-1.5">
          <RefreshCw size={14} className={loading ? 'animate-spin' : ''} />
          Refresh
        </button>
      </div>

      {/* Summary bar */}
      <div className="grid grid-cols-4 gap-3 mb-6">
        {[
          { label: 'Total Services', value: services.length, icon: ShieldAlert },
          { label: 'ENS Services',   value: ensCount, icon: Bell, sub: activeEns > 0 ? `${activeEns} active` : null, warn: activeEns > 0 },
          { label: 'ERS Services',   value: ersCount, icon: Phone, sub: activeErs > 0 ? `${activeErs} active` : null, warn: activeErs > 0 },
          { label: 'Live Activity',  value: activeEns + activeErs, icon: Activity, warn: (activeEns + activeErs) > 0 },
        ].map(({ label, value, icon: Icon, sub, warn }) => (
          <div key={label} className="bg-surface-panel border border-surface-border rounded-xl p-4">
            <div className="flex items-start justify-between">
              <div>
                <p className="text-xs text-text-muted mb-1">{label}</p>
                <p className={`text-2xl font-bold ${warn && value > 0 ? 'text-red-400' : 'text-text-primary'}`}>
                  {value}
                </p>
                {sub && <p className="text-[10px] text-red-400 mt-0.5">{sub}</p>}
              </div>
              <Icon size={16} className="text-text-muted mt-0.5" />
            </div>
          </div>
        ))}
      </div>

      {/* Success banner */}
      {success && (
        <div className="mb-4 flex items-center gap-2 bg-green-500/10 border border-green-500/20 text-green-400 text-sm rounded-lg px-4 py-2.5">
          <Activity size={14} />
          {success}
        </div>
      )}

      {/* Filter tabs */}
      <div className="flex gap-1 mb-4 bg-surface-raised rounded-lg p-1 w-fit">
        {['ALL', 'ENS', 'ERS'].map(t => (
          <button
            key={t}
            onClick={() => setFilter(t)}
            className={`px-4 py-1.5 rounded-md text-sm font-medium transition-colors ${
              filter === t
                ? 'bg-surface-panel text-text-primary shadow-sm'
                : 'text-text-muted hover:text-text-secondary'
            }`}
          >
            {t} {t === 'ALL' ? `(${services.length})` : t === 'ENS' ? `(${ensCount})` : `(${ersCount})`}
          </button>
        ))}
      </div>

      {/* Content */}
      {error && (
        <div className="flex items-center gap-2 text-red-400 bg-red-500/10 border border-red-500/20 rounded-lg p-3 text-sm mb-4">
          <AlertCircle size={14} />
          {error}
        </div>
      )}

      {loading ? (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
          {[...Array(6)].map((_, i) => (
            <div key={i} className="bg-surface-panel border border-surface-border rounded-xl p-4 h-28 animate-pulse" />
          ))}
        </div>
      ) : visible.length === 0 ? (
        <div className="text-center py-16 text-text-muted">
          <ShieldAlert size={32} className="mx-auto mb-3 opacity-30" />
          <p className="text-sm">No {filter !== 'ALL' ? filter : ''} services found</p>
          <p className="text-xs mt-1">Add emergency numbers in ENS/ERS configuration</p>
        </div>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
          {visible.map(s => (
            <ServiceCard key={s.id} service={s} onTrigger={setTrigger} />
          ))}
        </div>
      )}

      {/* Trigger modal */}
      {trigger && (
        <TriggerModal
          service={trigger}
          onClose={() => setTrigger(null)}
          onSuccess={onTriggerSuccess}
        />
      )}
    </div>
  );
}
