/**
 * IncidentWidget — ERS-only top info card.
 *
 * Shows incident summary (name, organization, caller, UUID, group type,
 * bridge number, duration). Only rendered when confType === 'ERS'.
 */
import { memo } from 'react';
import { AlertCircle, Hash, Phone, Clock, Shield } from 'lucide-react';
import { elapsedSec, fmtDur } from '../../utils/time.js';

const TIER_CFG = {
  PRIMARY:   { label: 'CRITICAL', pill: 'bg-red-500/15 text-red-500 border-red-500/30',     dot: 'bg-red-500'    },
  SECONDARY: { label: 'HIGH',     pill: 'bg-amber-500/15 text-amber-500 border-amber-500/30', dot: 'bg-amber-500'  },
  QUEUE:     { label: 'PENDING',  pill: 'bg-blue-500/15 text-blue-500 border-blue-500/30',   dot: 'bg-blue-500'   },
};
const DEFAULT_TIER = { label: 'UNKNOWN', pill: 'bg-surface-hover text-text-muted border-surface-border', dot: 'bg-surface-border' };

function kv(label, value, mono = false) {
  if (!value) return null;
  return (
    <div className="flex items-center gap-2 py-0.5">
      <span className="text-[9px] text-text-muted w-20 shrink-0">{label}</span>
      <span className={`text-[10px] font-medium text-text-primary flex-1 truncate ${mono ? 'font-mono' : ''}`}>
        {value}
      </span>
    </div>
  );
}

export const IncidentWidget = memo(function IncidentWidget({ conf, now }) {
  const inc  = conf?.incident || null;
  const tier = TIER_CFG[inc?.group_type] ?? DEFAULT_TIER;
  const secs = elapsedSec(inc?.started_at || conf?.createdAt, now);

  // Commander = first moderator
  const commander = conf?.members?.find(m => m.moderator);

  return (
    <div className="card !p-3 shrink-0">
      <div className="flex items-start gap-3">
        {/* Severity indicator */}
        <div className="flex flex-col items-center gap-1 shrink-0 pt-px">
          <span className={`text-[8px] px-1.5 py-px rounded border font-bold ${tier.pill}`}>
            {tier.label}
          </span>
          <span className={`w-2 h-2 rounded-full ${tier.dot}`} />
        </div>

        {/* Incident name + meta */}
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 mb-1.5">
            <AlertCircle size={11} className="text-red-500 shrink-0" />
            <h3 className="text-xs font-bold text-text-primary truncate">
              {inc?.ers_name || conf?.name || 'Emergency Incident'}
            </h3>
          </div>

          <div className="grid grid-cols-2 gap-x-6">
            {kv('Organization', inc?.organization_name)}
            {inc?.caller_number && (
              <div className="flex items-center gap-2 py-0.5">
                <span className="text-[9px] text-text-muted w-20 shrink-0 flex items-center gap-0.5">
                  <Phone size={7} /> Caller
                </span>
                <span className="text-[10px] font-mono text-text-primary">{inc.caller_number}</span>
              </div>
            )}
            {inc?.incident_uuid && kv('UUID', inc.incident_uuid.slice(0, 8).toUpperCase() + '…', true)}
            {inc?.primary_bridge_number && kv('Bridge', inc.primary_bridge_number, true)}
            {commander && (
              <div className="flex items-center gap-2 py-0.5">
                <span className="text-[9px] text-text-muted w-20 shrink-0 flex items-center gap-0.5">
                  <Shield size={7} /> Commander
                </span>
                <span className="text-[10px] font-medium text-amber-500 truncate">
                  {commander.displayName || commander.callerNum}
                </span>
              </div>
            )}
            <div className="flex items-center gap-2 py-0.5">
              <span className="text-[9px] text-text-muted w-20 shrink-0 flex items-center gap-0.5">
                <Clock size={7} /> Duration
              </span>
              <span className="text-[10px] font-mono tabular-nums text-text-primary">
                {fmtDur(secs)}
              </span>
            </div>
          </div>
        </div>

        {/* Conference room chip */}
        <div className="shrink-0 text-right">
          <div className="flex items-center gap-1 text-[9px] text-text-muted">
            <Hash size={8} />
            <span className="font-mono">{conf?.name}</span>
          </div>
        </div>
      </div>
    </div>
  );
});
