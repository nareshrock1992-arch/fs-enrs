import { ShieldAlert, User, Clock } from 'lucide-react';
import { useLiveDuration } from '../../hooks/useLiveDuration.js';
import Badge from '../ui/Badge.jsx';
import PulsingDot from '../ui/PulsingDot.jsx';

function maskPhone(num) {
  if (!num) return '—';
  const digits = String(num).replace(/\D/g, '');
  if (digits.length < 4) return num;
  return digits.slice(0, -4).replace(/./g, 'x') + '-' + digits.slice(-4);
}

function IncidentCard({ incident }) {
  const {
    conference_room, group_type, caller_number,
    ers_name, started_at, responders = [],
  } = incident;

  const duration = useLiveDuration(started_at);
  const joined = responders.filter(r => r.status === 'JOINED' || r.status === 'REJOINED');

  return (
    <div className="border border-surface-border rounded-xl p-4 bg-surface
                    hover:bg-surface-hover transition-colors">
      <div className="flex items-start gap-3">
        <div className="w-8 h-8 rounded-lg bg-red-500/15 flex items-center justify-center shrink-0 mt-0.5">
          <ShieldAlert size={14} className="text-red-500" />
        </div>
        <div className="flex-1 min-w-0">
          {/* Header row */}
          <div className="flex items-center gap-2 mb-1">
            <PulsingDot active size="sm" />
            <p className="text-sm font-semibold text-text-primary truncate">
              {ers_name || 'ERS Incident'}
            </p>
            <Badge variant={group_type === 'primary' ? 'brand' : 'warning'} className="shrink-0 text-[10px]">
              {group_type}
            </Badge>
          </div>

          {/* Meta */}
          <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-xs mt-2">
            <span className="text-text-muted flex items-center gap-1">
              <Clock size={10} /> {duration}
            </span>
            <span className="text-text-muted font-mono truncate">
              {conference_room || '—'}
            </span>
            <span className="text-text-muted">
              Caller: <span className="text-text-primary font-mono">{maskPhone(caller_number)}</span>
            </span>
            <span className="text-text-muted">
              Responders: <strong className="text-text-primary">{joined.length}</strong>
            </span>
          </div>

          {/* Responder chips */}
          {joined.length > 0 && (
            <div className="flex flex-wrap gap-1 mt-3">
              {joined.map((r, i) => (
                <span key={i}
                  className="inline-flex items-center gap-1 text-[10px] px-2 py-0.5
                             rounded-full bg-green-500/10 text-green-600 dark:text-green-400
                             border border-green-500/20">
                  <User size={9} />
                  {maskPhone(r.responder_number)}
                </span>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

export default function ErsActivePanel({ incidents }) {
  const active = Object.values(incidents);
  if (active.length === 0) {
    return (
      <div className="card">
        <h2 className="text-sm font-semibold text-text-primary flex items-center gap-2 mb-3">
          <ShieldAlert size={14} className="text-text-muted" />
          Active ERS Incidents
        </h2>
        <p className="text-xs text-text-muted">No active incidents</p>
      </div>
    );
  }

  return (
    <div className="card space-y-3">
      <h2 className="text-sm font-semibold text-text-primary flex items-center gap-2">
        <ShieldAlert size={14} className="text-red-500" />
        Active ERS Incidents
        <span className="ml-auto badge bg-red-500/15 text-red-500">{active.length}</span>
      </h2>
      {active.map(inc => (
        <IncidentCard key={inc.incident_uuid} incident={inc} />
      ))}
    </div>
  );
}
