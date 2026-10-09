// Presentation-only: bucket a node's validation error strings so the inspector
// can show each one INLINE at the field it concerns, instead of a single opaque
// block. This only re-reads the existing error strings produced by the backend
// validator (format: "node <id>.<field>: message" for field-scoped Zod errors,
// "node <id>: message" for node-level graph errors). It does NOT run or change
// any validation — the semantics and the strings are untouched.

/**
 * @param {string[]} errs  the node's error strings (errors[nodeId])
 * @returns {{ byField: Record<string,string[]>, node: string[] }}
 *   byField — messages scoped to a specific config field key (prefix stripped)
 *   node    — node-level messages with the "node <id>:" prefix stripped
 */
export function bucketNodeErrors(errs = []) {
  const byField = {};
  const node = [];
  for (const raw of Array.isArray(errs) ? errs : []) {
    if (typeof raw !== 'string') continue;
    const field = raw.match(/^node\s+[^.\s:]+\.([A-Za-z0-9_]+)\s*:\s*(.*)$/);
    if (field) {
      const key = field[1];
      const msg = field[2].trim() || raw;
      (byField[key] ||= []).push(msg);
    } else {
      const msg = raw.replace(/^node\s+[^\s:]+\s*:?\s*/, '').trim();
      node.push(msg || raw);
    }
  }
  return { byField, node };
}
