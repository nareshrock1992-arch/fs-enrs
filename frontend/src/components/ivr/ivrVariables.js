// Runtime channel-variable catalog for the IVR Builder.
//
// Feeds the "Insert variable" picker on interpolation-capable fields (Say text,
// prompts, etc.). This is authoring-time UI metadata only — the actual values
// are resolved at call time by interp() in the Lua executor.
//
// Mirrors docs/11-variable-reference.md. `availability` tells the author when a
// variable is reliably present, since flow/ERS/ENS/recording variables only
// exist AFTER their producing node has run earlier in the graph.

export const IVR_VARIABLES = [
  // ── Caller ────────────────────────────────────────────────────────────────
  {
    name: 'caller_id_name',
    label: 'Caller Name',
    category: 'Caller',
    description: "The caller's display name as signalled by SIP. Often empty or a raw number for mobile/PSTN callers.",
    example: 'Welcome to Yasref IT Helpdesk ${caller_id_name}. → Welcome to Yasref IT Helpdesk John Smith.',
    availability: 'Present on every call as a variable, but frequently empty/garbage for external callers — pair with a fallback.',
  },
  {
    name: 'effective_caller_id_name',
    label: 'Caller Name (effective)',
    category: 'Caller',
    description: "Mirror of caller_id_name set at IVR entry. Same value as caller_id_name in most flows.",
    example: 'Hello ${effective_caller_id_name}. → Hello John Smith.',
    availability: 'Set at IVR entry; same caveats as Caller Name.',
  },
  {
    name: 'caller_id_number',
    label: 'Caller Number',
    category: 'Caller',
    description: "The caller's phone number (ANI / calling party number).",
    example: 'You are calling from ${caller_id_number}. → You are calling from 19055559999.',
    availability: 'Always present.',
  },
  // ── Call ──────────────────────────────────────────────────────────────────
  {
    name: 'destination_number',
    label: 'Dialled Number',
    category: 'Call',
    description: 'The number the caller dialled (DNIS).',
    example: 'You reached ${destination_number}. → You reached 7501.',
    availability: 'Always present.',
  },
  {
    name: 'uuid',
    label: 'Call ID (UUID)',
    category: 'Call',
    description: 'The unique FreeSWITCH channel ID for this call. Useful for reference numbers.',
    example: 'Your reference is ${uuid}.',
    availability: 'Always present.',
  },
  // ── Flow (context-dependent) ───────────────────────────────────────────────
  {
    name: 'gather_result',
    label: 'Last Gathered Digits',
    category: 'Flow',
    description: 'The digits collected by the most recent Gather node using the default variable name.',
    example: 'You entered ${gather_result}. → You entered 4.',
    availability: 'Only after a Gather node (with the default variable name) has run earlier in the flow.',
  },
  // ── ERS (context-dependent) ────────────────────────────────────────────────
  {
    name: 'ers_incident_uuid',
    label: 'ERS Incident ID',
    category: 'ERS',
    description: 'The incident identifier created by an ERS node.',
    example: 'Your incident number is ${ers_incident_uuid}.',
    availability: 'Only after an ERS / ERS Ring-All node has run earlier in the flow.',
  },
  // ── ENS (context-dependent) ────────────────────────────────────────────────
  {
    name: 'ens_notification_uuid',
    label: 'ENS Notification ID',
    category: 'ENS',
    description: 'The notification identifier produced by an ENS blast / callback.',
    example: 'Notification ${ens_notification_uuid} has been sent.',
    availability: 'Only after an ENS node / callback condition has run earlier in the flow.',
  },
  // ── Recording (context-dependent) ──────────────────────────────────────────
  {
    name: 'recorded_file_path',
    label: 'Recorded File Path',
    category: 'Recording',
    description: 'Filesystem path of the caller recording captured by a Record node.',
    example: '(reference only) ${recorded_file_path}',
    availability: 'Only after a Record node has run earlier in the flow.',
  },
];

// Distinct categories in definition order (for grouping in the picker).
export const IVR_VARIABLE_CATEGORIES = [...new Set(IVR_VARIABLES.map(v => v.category))];

/**
 * Pure cursor-insertion helper (extracted so it is unit-testable without a DOM).
 * Inserts `token` into `value` at [start, end); appends when no selection is given.
 * Returns { text, caret } — caret is the position just after the inserted token.
 */
export function insertAtCursor(value = '', start = null, end = null, token = '') {
  const v = value || '';
  if (start == null || end == null) {
    const text = v + token;
    return { text, caret: text.length };
  }
  const text = v.slice(0, start) + token + v.slice(end);
  return { text, caret: start + token.length };
}
