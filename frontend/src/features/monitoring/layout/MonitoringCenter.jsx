/**
 * MonitoringCenter — the main layout shell for the Conference Monitoring Center.
 *
 * Arranges:
 *   Left  : ConferenceSidebar  (IncidentSidebar, existing component)
 *   Center: ConferenceHeader + WidgetRenderer (type-aware workspace)
 *   Right : RightDetailsPanel  (collapsible)
 *   Bottom: BottomTimeline     (collapsible)
 *
 * State owned here: UI-only — which panels are collapsed.
 * All data (conferences, events, talkTracker, now) is received as props
 * from Monitoring.jsx via useConferenceState().
 */
import { useState } from 'react';
import { ChevronLeft } from 'lucide-react';
import { IncidentSidebar } from '../sidebar/IncidentSidebar.jsx';
import { ConferenceHeader } from './ConferenceHeader.jsx';
import { WidgetRenderer } from './WidgetRenderer.jsx';
import { RightDetailsPanel } from './RightDetailsPanel.jsx';
import { BottomTimeline } from './BottomTimeline.jsx';

export function MonitoringCenter({
  conferences,
  selectedConf,
  setSelectedConf,
  selectedConference,
  now,
  talkTracker,
  events,
  loading,
}) {
  const [rightCollapsed,    setRightCollapsed]    = useState(false);
  const [timelineCollapsed, setTimelineCollapsed] = useState(false);

  function toggleSelect(name) {
    setSelectedConf(s => s === name ? null : name);
  }

  return (
    <div className="flex flex-col gap-3">

      {/* Three-column main grid */}
      <div
        className="grid gap-3"
        style={{
          gridTemplateColumns: rightCollapsed
            ? '288px 1fr auto'
            : '288px 1fr 272px',
          minHeight: '520px',
          maxHeight: 'calc(100vh - 280px)',
        }}>

        {/* Left — Conference Sidebar */}
        <div className="card !p-4 overflow-hidden flex flex-col">
          <IncidentSidebar
            conferences={conferences}
            selectedConf={selectedConf}
            onSelect={toggleSelect}
            now={now}
            loading={loading}
          />
        </div>

        {/* Center — Header + Widget workspace */}
        <div className="card !p-4 overflow-hidden flex flex-col min-w-0">
          <ConferenceHeader conf={selectedConference} />
          <div className="flex-1 min-h-0 overflow-hidden">
            <WidgetRenderer
              conf={selectedConference}
              now={now}
              talkTracker={talkTracker}
            />
          </div>
        </div>

        {/* Right — collapsible controls panel */}
        {rightCollapsed ? (
          /* Collapsed: show a thin expand button */
          <div className="flex items-start pt-2">
            <button
              onClick={() => setRightCollapsed(false)}
              title="Expand controls panel"
              className="flex flex-col items-center gap-1 px-2 py-3 rounded-xl
                         border border-surface-border text-text-muted
                         hover:text-text-primary hover:bg-surface-hover transition-colors text-[9px]">
              <ChevronLeft size={12} />
              <span style={{ writingMode: 'vertical-rl' }} className="font-bold uppercase tracking-widest">
                Controls
              </span>
            </button>
          </div>
        ) : (
          <div className="card !p-4 overflow-hidden flex flex-col">
            <RightDetailsPanel
              conf={selectedConference}
              talkTracker={talkTracker}
              onCollapse={() => setRightCollapsed(true)}
            />
          </div>
        )}
      </div>

      {/* Bottom — collapsible event timeline */}
      <BottomTimeline
        events={events}
        collapsed={timelineCollapsed}
        onCollapse={() => setTimelineCollapsed(c => !c)}
      />

    </div>
  );
}
