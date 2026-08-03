/**
 * Widget registry for the Conference Monitoring Center.
 *
 * Defines which widgets to render for each conference type, and
 * provides the type-detection function that drives WidgetRenderer.
 *
 * To add a new conference type:
 *   1. Add a new key to WIDGET_LAYOUTS with an ordered widget array.
 *   2. Update getConferenceType() to detect the new type.
 *   3. Register the widget component in WidgetRenderer.jsx.
 */

/** Detect the operational type of a conference from its runtime state. */
export function getConferenceType(conf) {
  if (!conf) return 'STANDARD';
  // ERS conferences always have an incident object with an ers_name
  if (conf.incident?.ers_name || conf.incident?.incident_uuid) return 'ERS';
  return 'STANDARD';
}

/**
 * Ordered list of widget IDs rendered in the main workspace for each type.
 * IDs must match keys in the WIDGET_COMPONENTS map in WidgetRenderer.jsx.
 */
export const WIDGET_LAYOUTS = {
  ERS: [
    'IncidentWidget',       // top: ERS incident summary
    'NowSpeakingWidget',    // left: floor holder panel
    'ParticipantTableWidget', // main: grouped participant table
  ],
  STANDARD: [
    'ConferenceInfoWidget',   // top: conference metadata
    'NowSpeakingWidget',      // left: floor holder panel
    'ParticipantTableWidget', // main: participant table
  ],
};

/**
 * Which widgets appear in the collapsible right-panel per conference type.
 * These are supplementary — the action controls (lock, mute, record, invite,
 * terminate) are always present in RightDetailsPanel regardless of type.
 */
export const RIGHT_PANEL_EXTRAS = {
  ERS:      ['IncidentMetaSection', 'RecordingSection'],
  STANDARD: ['StatisticsSection',   'RecordingSection'],
};
