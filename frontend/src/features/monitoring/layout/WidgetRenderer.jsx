/**
 * WidgetRenderer — renders the main workspace content for a selected conference.
 *
 * Dispatches to the correct set of widgets based on conference type (ERS or STANDARD).
 * Widgets are lazy-imported to avoid loading ERS widgets for STANDARD conferences.
 *
 * Layout (both types):
 *   ┌─────────────────────────────────────────────────────┐
 *   │ Top info widget (type-specific)                      │
 *   ├──────────────┬──────────────────────────────────────┤
 *   │ NowSpeaking  │ ParticipantTable                     │
 *   │ (fixed 192px)│ (flex-1, scrollable)                 │
 *   └──────────────┴──────────────────────────────────────┘
 */
import { lazy, Suspense } from 'react';
import { Monitor } from 'lucide-react';
import { getConferenceType } from '../config/widgetRegistry.js';
import { NowSpeakingWidget } from '../widgets/NowSpeakingWidget.jsx';
import { ParticipantTableWidget } from '../widgets/ParticipantTableWidget.jsx';

const IncidentWidget      = lazy(() => import('../widgets/ers/IncidentWidget.jsx')
  .then(m => ({ default: m.IncidentWidget })));
const ConferenceInfoWidget = lazy(() => import('../widgets/standard/ConferenceInfoWidget.jsx')
  .then(m => ({ default: m.ConferenceInfoWidget })));

// Minimal skeleton used while lazy widget loads
function WidgetSkeleton() {
  return (
    <div className="card !p-3 shrink-0 animate-pulse">
      <div className="h-3 bg-surface-hover rounded w-1/3 mb-2" />
      <div className="h-2 bg-surface-hover rounded w-2/3" />
    </div>
  );
}

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

  const confType = getConferenceType(conf);

  return (
    <div className="h-full flex flex-col gap-3 overflow-hidden">

      {/* Top info widget — type-specific */}
      <Suspense fallback={<WidgetSkeleton />}>
        {confType === 'ERS'
          ? <IncidentWidget conf={conf} now={now} />
          : <ConferenceInfoWidget conf={conf} now={now} />
        }
      </Suspense>

      {/* Main workspace — NowSpeaking (pinned left) + ParticipantTable (flex-1) */}
      <div className="flex-1 flex gap-3 overflow-hidden min-h-0">
        <NowSpeakingWidget conf={conf} now={now} />
        <ParticipantTableWidget conf={conf} now={now} talkTracker={talkTracker} />
      </div>

    </div>
  );
}
