// Presentation-only field sectioning for the properties inspector.
//
// Groups a node's configSchema fields under collapsible headers purely for
// readability. It NEVER changes field keys, values, order-within-section,
// showWhen, validation, or the schema — it only decides which header a field is
// drawn under and whether that header starts open. Grouping is derived from the
// field KEY (no new registry metadata required).
//
// Default-open policy (important): routing, content, input, and outputs stay
// OPEN so critical routing and failure-handling destinations are never hidden.
// Only lengthy numeric "Timeouts & retries" blocks (and a reserved "Advanced"
// bucket) collapse by default to reduce scrolling on large forms.

export const SECTION_ORDER = [
  // Generic (key-derived) sections, then explicit per-field `section` titles a
  // node may declare (e.g. queue_wait). Any title not listed here still renders,
  // appended in first-seen order, and is open unless COLLAPSED_BY_DEFAULT.
  'General', 'Content', 'Input', 'Routing', 'Retries', 'Timeouts',
  'Queue', 'Wait timing', 'Business policy', 'Hold & announcements',
  'Outputs', 'Advanced',
];

export function sectionForFieldKey(key = '') {
  const k = String(key);
  // Routing TARGETS (branch/next/goto) — the caller's onward journey.
  if (/^(next|branches|goto|target_node_id|true_node|false_node)$/.test(k)) return 'Outputs';
  // Routing DESTINATIONS / dialplan.
  if (/(destination|dialplan|^context$|queue|extension)/i.test(k)) return 'Routing';
  // Prompts / audio / spoken content — including the per-outcome prompt SOURCE
  // selectors and replay toggles (…_source_type, …_replay_menu), which belong
  // with the prompt they control, not with timing. `hold_` is matched by its
  // prefix so "silence_threshold" (contains "…hold") is NOT misclassified.
  if (/(prompt|_text$|^text$|audio|message|moh|hold_|goodbye|tts|voice|language|source_type|replay_menu)/i.test(k)) return 'Content';
  // Caller input collection.
  if (/^(min_digits|max_digits|num_digits|terminators|variable_name|inter_digit_timeout)$/.test(k)) return 'Input';
  // Retry BEHAVIOR (how many attempts, whether to retry) — kept open by default
  // because it governs caller experience, not merely timing.
  if (/(retry|max_attempts|max_no_answer|reprompt_pause)/i.test(k)) return 'Retries';
  // Pure timing values (secondary) — collapsible.
  if (/(timeout|_delay|wait)/i.test(k)) return 'Timeouts';
  return 'General';
}

const COLLAPSED_BY_DEFAULT = new Set(['Timeouts', 'Advanced']);
export function sectionDefaultOpen(title) {
  return !COLLAPSED_BY_DEFAULT.has(title);
}

/**
 * Group a configSchema into ordered, non-empty sections.
 * @returns {{ title: string, fields: object[] }[]} order-within-section preserved.
 */
export function groupFields(schema = []) {
  const grouped = {};
  const order = [];                       // preserves first-seen order of any title not in SECTION_ORDER
  for (const f of Array.isArray(schema) ? schema : []) {
    // A field may declare an explicit `section` (opt-in, e.g. queue_wait); it
    // overrides the key heuristic. Nodes that don't set it are unaffected.
    const s = (typeof f?.section === 'string' && f.section.trim()) ? f.section.trim() : sectionForFieldKey(f?.key || '');
    if (!(s in grouped)) { grouped[s] = []; order.push(s); }
    grouped[s].push(f);
  }
  const ranked = SECTION_ORDER.filter(s => grouped[s]?.length);
  const extras = order.filter(s => !SECTION_ORDER.includes(s)); // unknown titles keep first-seen order
  return [...ranked, ...extras].map(title => ({ title, fields: grouped[title] }));
}
