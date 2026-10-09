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
  'General', 'Content', 'Input', 'Routing', 'Timeouts & retries', 'Outputs', 'Advanced',
];

export function sectionForFieldKey(key = '') {
  const k = String(key);
  // Routing TARGETS (branch/next/goto) — the caller's onward journey.
  if (/^(next|branches|goto|target_node_id|true_node|false_node)$/.test(k)) return 'Outputs';
  // Routing DESTINATIONS / dialplan.
  if (/(destination|dialplan|^context$|queue|extension)/i.test(k)) return 'Routing';
  // Prompts / audio / spoken content.
  if (/(prompt|_text$|^text$|audio|message|moh|hold|goodbye|tts|voice|language)/i.test(k)) return 'Content';
  // Caller input collection.
  if (/^(min_digits|max_digits|num_digits|terminators|variable_name|inter_digit_timeout)$/.test(k)) return 'Input';
  // Timing / retry counters (collapsible).
  if (/(timeout|retry|max_attempts|no_input|invalid_length|invalid_option|_delay|wait|max_no_answer)/i.test(k)) return 'Timeouts & retries';
  return 'General';
}

const COLLAPSED_BY_DEFAULT = new Set(['Timeouts & retries', 'Advanced']);
export function sectionDefaultOpen(title) {
  return !COLLAPSED_BY_DEFAULT.has(title);
}

/**
 * Group a configSchema into ordered, non-empty sections.
 * @returns {{ title: string, fields: object[] }[]} order-within-section preserved.
 */
export function groupFields(schema = []) {
  const grouped = {};
  for (const f of Array.isArray(schema) ? schema : []) {
    const s = sectionForFieldKey(f?.key || '');
    (grouped[s] ||= []).push(f);
  }
  return SECTION_ORDER.filter(s => grouped[s]?.length).map(title => ({ title, fields: grouped[title] }));
}
