/**
 * WidgetRenderer — workspace for a selected conference.
 *
 * Layout:
 *   ┌──────────────────────────────────────────────────────────┐
 *   │ NowSpeakingWidget  (horizontal banner, 32–60 px)          │
 *   ├──────────────────────────────────────────────────────────┤
 *   │ ParticipantTableWidget  (fills all remaining height)      │
 *   └──────────────────────────────────────────────────────────┘
 *
 * The top info card (IncidentWidget / ConferenceInfoWidget) has been removed —
 * its content duplicates what the sidebar already shows.
 */
import { Monitor } from 'lucide-react';
import { NowSpeakingWidget } from '../widgets/NowSpeakingWidget.jsx';
import { ParticipantTableWidget } from '../widgets/ParticipantTableWidget.jsx';

export function WidgetRenderer({ conf, now, talkTracker }) {
  if (!conf) {
    return (
      <div className="h-full flex flex-col items-center justify-center gap-4 text-center px-6">
        <div className="w-14 h-14 rounded-2xl bg-surface-hover flex items-center justify-center">
          <Monitor size={22} className="text-text-muted/30" />
        </div>
        <div>
          <p className="text-sm font-semibold text-text-secondary">Select a Conference</p>
          <p className="text-xs text-text-muted mt-1 leading-relaxed">
            Click a conference in the sidebar to view participants and controls
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="h-full flex flex-col overflow-hidden">
      {/* Now Speaking — full-width horizontal banner */}
      <NowSpeakingWidget conf={conf} now={now} />

      {/* Participant table — occupies the rest */}
      <div className="flex-1 min-h-0 overflow-hidden pt-2 px-1">
        <ParticipantTableWidget conf={conf} now={now} talkTracker={talkTracker} />
      </div>
    </div>
  );
}
