/**
 * IncidentCard — one card per active emergency incident in the sidebar.
 *
 * Accepts a normalized `incident` view object produced by toIncidentView()
 * in IncidentSidebar.jsx. Never reads raw conference or API data directly.
 */
import { memo } from 'react';
import {
  PhoneCall, Users, Radio, Clock,
  Shield, Square, AlertCircle, CheckCircle,
  Hash,
} from 'lucide-react';

// ─── Duration helpers ─────────────────────────────────────────────────────────

function elapsedSec(iso, now = Date.now()) {
  if (!iso) return 0;
  return Math.max(0, Math.floor((now - new Date(iso)) / 1000));
}

function fmtDur(secs) {
  if (secs < 60)   return `${secs}s`;
  if (secs < 3600) return `${Math.floor(secs / 60)}m ${secs % 60}s`;
  return `${Math.floor(secs / 3600)}h ${Math.floor((secs % 3600) / 60)}m`;
}

function fmtTime(iso) {
  if (!iso) return null;
  const d = new Date(iso);
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

// ─── Tier → severity badge ────────────────────────────────────────────────────

const TIER_CFG = {
  PRIMARY:   { label: 'CRITICAL', short: 'P1', bg: 'bg-red-500',    pill: 'bg-red-500/15 text-red-500 border-red-500/30' },
  SECONDARY: { label: 'HIGH',     short: 'P2', bg: 'bg-amber-500',  pill: 'bg-amber-500/15 text-amber-500 border-amber-500/30' },
  QUEUE:     { label: 'PENDING',  short: 'Q',  bg: 'bg-blue-500',   pill: 'bg-blue-500/15 text-blue-500 border-blue-500/30' },
};

const DEFAULT_TIER = { label: 'UNKNOWN', short: '?', bg: 'bg-surface-border', pill: 'bg-surface-hover text-text-muted border-surface-border' };

// ─── Recording state badge ────────────────────────────────────────────────────

function RecordingBadge({ state }) {
  if (state === 'ACTIVE') {
    return (
      <span className="text-[8px] px-1.5 py-px rounded-full bg-red-500/15 text-red-500
                       font-bold flex items-center gap-0.5 animate-pulse shrink-0">
        <Radio size={6} /> REC
      </span>
    );
  }
  if (state === 'STARTING') {
    return (
      <span className="text-[8px] px-1.5 py-px rounded-full bg-amber-500/15 text-amber-500
                       font-bold flex items-center gap-0.5 animate-pulse shrink-0">
        <Radio size={6} /> START
      </span>
    );
  }
  if (state === 'STOPPING') {
    return (
      <span className="text-[8px] px-1.5 py-px rounded-full bg-slate-500/15 text-slate-400
                       font-bold flex items-center gap-0.5 shrink-0">
        <Square size={6} /> STOP
      </span>
    );
  }
  if (state === 'FAILED') {
    return (
      <span className="text-[8px] px-1.5 py-px rounded-full bg-red-900/20 text-red-400
                       font-bold flex items-center gap-0.5 shrink-0">
        <AlertCircle size={6} /> FAIL
      </span>
    );
  }
  return null;
}

// ─── Component ────────────────────────────────────────────────────────────────

export const IncidentCard = memo(function IncidentCard({ incident, selected, onSelect, now }) {
  const tier    = TIER_CFG[incident.tier] ?? DEFAULT_TIER;
  const secs    = elapsedSec(incident.createdAt, now);
  const live    = incident.members?.filter(m => m.talking).length ?? 0;
  const lastAct = fmtTime(incident.lastActivityAt);

  return (
    <button
      type="button"
      onClick={() => onSelect(incident.id)}
      className={[
        'w-full text-left rounded-xl border transition-all duration-150 cursor-pointer overflow-hidden',
        selected
          ? 'border-primary/50 bg-primary/8 shadow-sm'
          : 'border-surface-border bg-surface-card hover:border-primary/20 hover:bg-surface-hover',
      ].join(' ')}
    >
      {/* Severity stripe */}
      <div className={`h-0.5 w-full ${tier.bg} opacity-70`} />

      <div className="p-3">

        {/* Row 1: Severity pill + Incident name + Recording badge */}
        <div className="flex items-start gap-2 mb-2">
          <span className={`text-[8px] px-1.5 py-px rounded border font-bold shrink-0 mt-px ${tier.pill}`}>
            {tier.short}
          </span>
          <div className="flex-1 min-w-0">
            <p className="text-[11px] font-bold text-text-primary leading-tight truncate">
              {incident.ersName}
            </p>
            <p className="text-[9px] font-mono text-text-muted truncate mt-px">
              {incident.displayId}
            </p>
          </div>
          <RecordingBadge state={incident.recordingState} />
        </div>

        {/* Row 2: Organization */}
        {incident.organizationName ? (
          <div className="flex items-center gap-1 mb-1.5">
            <Hash size={8} className="text-text-muted shrink-0" />
            <span className="text-[9px] text-text-muted truncate">{incident.organizationName}</span>
          </div>
        ) : null}

        {/* Row 3: Commander */}
        <div className="flex items-center gap-1 mb-1.5 min-h-[14px]">
          <Shield size={8} className="text-amber-500 shrink-0" />
          {incident.commander ? (
            <span className="text-[9px] text-amber-500 font-medium truncate">
              {incident.commander.displayName}
            </span>
          ) : (
            <span className="text-[9px] text-text-muted italic">No commander</span>
          )}
        </div>

        {/* Row 4: Participants + live speakers */}
        <div className="flex items-center gap-2 mb-1.5">
          <span className={`flex items-center gap-1 text-[9px] font-medium ${live > 0 ? 'text-green-500' : 'text-text-secondary'}`}>
            <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${live > 0 ? 'bg-green-500 animate-pulse' : 'bg-text-muted/30'}`} />
            <Users size={8} />
            {incident.participantCount}
            {live > 0 && <span className="text-[8px] text-green-400">· {live} live</span>}
          </span>
        </div>

        {/* Row 5: Broadcast Status + Notification Progress */}
        <div className="flex items-center gap-2 mb-2">
          <span className="flex items-center gap-1 text-[9px] text-text-muted">
            <Radio size={8} className="shrink-0" />
            <span>Broadcast: </span>
            <span className="text-text-muted/50 italic">—</span>
          </span>
          <span className="text-text-muted/30 text-[9px]">·</span>
          <span className="flex items-center gap-1 text-[9px] text-text-muted">
            <CheckCircle size={8} className="shrink-0" />
            <span>Notif: </span>
            <span className="text-text-muted/50 italic">—</span>
          </span>
        </div>

        {/* Row 6: Duration + Last activity + Caller */}
        <div className="flex items-center justify-between pt-1.5 border-t border-surface-border/30">
          <span className="flex items-center gap-0.5 text-[9px] font-mono tabular-nums text-text-muted">
            <Clock size={7} />
            {fmtDur(secs)}
          </span>
          {lastAct ? (
            <span className="text-[8px] text-text-muted/60 tabular-nums">
              last {lastAct}
            </span>
          ) : null}
          {incident.callerNumber ? (
            <span className="text-[9px] font-mono text-text-muted/70 flex items-center gap-0.5">
              <PhoneCall size={7} />
              {incident.callerNumber}
            </span>
          ) : null}
        </div>

      </div>
    </button>
  );
});
