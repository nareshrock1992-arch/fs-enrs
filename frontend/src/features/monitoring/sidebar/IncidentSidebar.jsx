/**
 * IncidentSidebar — replaces the conference-centric LeftPanel.
 *
 * Receives raw conference + incident data from the parent (Monitoring.jsx)
 * and transforms it into incident-centric view objects for display.
 *
 * The transformation (toIncidentView) is the ONLY place that understands
 * the mapping from conference-centric API data → incident-centric display.
 * All child components receive only normalized IncidentView objects.
 *
 * Props:
 *   conferences  — raw array from GET /monitoring/conferences
 *   selectedConf — currently selected conference room name (string | null)
 *   onSelect     — (id: string) => void  [id = incident_uuid || room name]
 *   now          — Date.now() ticker from parent
 *   loading      — boolean
 */
import { useMemo } from 'react';
import { PhoneCall, Headphones } from 'lucide-react';
import { IncidentCard } from './IncidentCard.jsx';
import { IncidentCardSkeleton } from './IncidentCardSkeleton.jsx';

// ─── Normalize one conference+incident entry → IncidentView ──────────────────
//
// This is the adapter between the current conference-centric API model and the
// incident-centric display model. When the backend is upgraded to return
// incident-first data (Phase 4), only this function needs to change.

function toIncidentView(conf) {
  const inc = conf.incident || null;

  // Canonical ID: incident_uuid when available, otherwise room name.
  // Used as the selection key — must be stable for the life of the incident.
  const id = inc?.incident_uuid || conf.name;

  // Human-readable display ID
  const displayId = inc?.incident_uuid
    ? `INC-${inc.incident_uuid.slice(0, 8).toUpperCase()}`
    : `CONF-${conf.name}`;

  // Commander: first moderator in the member list
  const commander = conf.members?.find(m => m.moderator) ?? null;

  // Last activity: latest joinedAt across all current members, or conference start
  const memberTimestamps = (conf.members || [])
    .map(m => m.joinedAt)
    .filter(Boolean)
    .map(ts => new Date(ts).getTime());
  const lastActivityAt = memberTimestamps.length > 0
    ? new Date(Math.max(...memberTimestamps)).toISOString()
    : null;

  return {
    // Identity
    id,
    incidentUuid:     inc?.incident_uuid    || null,
    displayId,
    ersName:          inc?.ers_name         || conf.name,
    organizationName: inc?.organization_name|| null,
    callerNumber:     inc?.caller_number    || null,
    tier:             inc?.group_type       || 'PRIMARY',

    // Conference transport
    room:             conf.name,
    createdAt:        inc?.started_at       || conf.createdAt,
    locked:           conf.locked,

    // Recording
    recordingState:   conf.recordingState,
    recordingPath:    conf.recordingPath,
    recordingError:   conf.recordingError,

    // Participants
    members:          conf.members          || [],
    participantCount: conf.members?.length  ?? 0,
    commander,

    // Derived
    lastActivityAt,
  };
}

// ─── Component ────────────────────────────────────────────────────────────────

export function IncidentSidebar({ conferences, selectedConf, onSelect, now, loading }) {
  // Transform conferences → incident views. Memoized — only re-runs when
  // the conferences array reference changes (i.e. on every socket event that
  // calls setConferences, which produces a new array).
  const incidents = useMemo(
    () => (conferences || []).map(toIncidentView),
    [conferences]
  );

  // The parent uses room name as the selection key. Map the incident id to the
  // correct selection state: selected when inc.room === selectedConf OR
  // inc.id === selectedConf (covers both old and new key shapes).
  function isSelected(incident) {
    return incident.room === selectedConf || incident.id === selectedConf;
  }

  // When the user selects an incident, pass the room name back to the parent
  // (which still uses room name as the conference selection key).
  // When the backend upgrades to incident-first, swap this to incident_uuid.
  function handleSelect(incidentId) {
    const inc = incidents.find(i => i.id === incidentId);
    onSelect(inc ? inc.room : incidentId);
  }

  return (
    <div className="flex flex-col h-full">

      {/* Header */}
      <div className="flex items-center gap-2 mb-2.5 shrink-0">
        <PhoneCall size={12} className="text-emerald-500" />
        <span className="text-xs font-bold text-text-primary">Active Incidents</span>
        <span className={[
          'ml-1 text-[10px] px-1.5 py-px rounded-full font-bold',
          incidents.length > 0
            ? 'bg-red-500/15 text-red-500'
            : 'bg-surface-hover text-text-muted',
        ].join(' ')}>
          {incidents.length}
        </span>
      </div>

      {/* List */}
      <div className="flex-1 overflow-y-auto space-y-2 pr-0.5">
        {loading ? (
          <>
            <IncidentCardSkeleton />
            <IncidentCardSkeleton />
            <IncidentCardSkeleton />
          </>
        ) : incidents.length === 0 ? (
          <div className="flex flex-col items-center gap-3 py-12 text-center">
            <Headphones size={22} className="text-text-muted/25" />
            <div>
              <p className="text-xs font-medium text-text-secondary">No Active Incidents</p>
              <p className="text-[10px] text-text-muted mt-0.5">Waiting for FreeSWITCH…</p>
            </div>
            <span className="w-2 h-2 rounded-full bg-emerald-500 animate-pulse" />
          </div>
        ) : (
          incidents.map(incident => (
            <IncidentCard
              key={incident.id}
              incident={incident}
              selected={isSelected(incident)}
              onSelect={handleSelect}
              now={now}
            />
          ))
        )}
      </div>
    </div>
  );
}
