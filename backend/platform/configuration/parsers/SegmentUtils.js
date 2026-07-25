/**
 * SegmentUtils — format-agnostic segment manipulation utilities.
 *
 * These functions operate on the generic segment model:
 *   { type: 'entry', key, value, enabled, indent, original, modified, ...extras }
 *   { type: 'other', content }
 *   { type: 'deleted' }       ← produced by applyChanges op:'delete'
 *
 * No parser-specific knowledge lives here. All concrete parsers
 * (VarsParser, SwitchConfParser, ...) import from this module.
 *
 * VarsParser re-exports every symbol here for backward compatibility —
 * existing callers that import from VarsParser continue to work.
 */

/**
 * Build a Map<key → segment index> for O(1) key lookups.
 * When a key appears multiple times, the ENABLED definition wins.
 * If all definitions are disabled, the first occurrence wins.
 *
 * @param {Array} segments
 * @returns {Map<string, number>}
 */
export function buildIndex(segments) {
  const idx = new Map();
  segments.forEach((seg, i) => {
    if (seg.type !== 'entry') return;
    const existing = idx.get(seg.key);
    if (existing === undefined) {
      idx.set(seg.key, i);
    } else if (!segments[existing].enabled && seg.enabled) {
      idx.set(seg.key, i); // prefer enabled over disabled
    }
  });
  return idx;
}

/**
 * Build a Map<key → segmentIndex[]> capturing ALL definitions per key.
 *
 * @param {Array} segments
 * @returns {Map<string, number[]>}
 */
export function buildGroupMap(segments) {
  const map = new Map();
  segments.forEach((seg, i) => {
    if (seg.type !== 'entry') return;
    const arr = map.get(seg.key);
    if (arr) arr.push(i);
    else map.set(seg.key, [i]);
  });
  return map;
}

/**
 * Group entry segments by key, returning one group per unique key.
 * Within each group:
 *   primary      — the active definition (first enabled), or the first if all disabled
 *   alternatives — all other definitions for the same key
 *
 * Each definition carries `definitionId` — the 0-based occurrence index of that
 * definition among all definitions of the same key, in file order. Stable identifier:
 * the backend resolves (key, definitionId) → segment index via siblings[definitionId].
 *
 * @param {Array} segments
 * @returns {Array<{ key, primary, alternatives }>}
 */
export function groupByKey(segments) {
  const order  = [];
  const defMap = new Map();

  segments.forEach((seg) => {
    if (seg.type !== 'entry') return;
    const { key } = seg;
    if (!defMap.has(key)) {
      defMap.set(key, []);
      order.push(key);
    }
    defMap.get(key).push({ ...seg });
  });

  return order.map(key => {
    const definitions = defMap.get(key);
    definitions.forEach((def, definitionId) => {
      def.definitionId = definitionId;
    });
    const primaryPos   = definitions.findIndex(d => d.enabled);
    const primary      = definitions[primaryPos === -1 ? 0 : primaryPos];
    const alternatives = definitions.filter(d => d !== primary);
    return { key, primary, alternatives };
  });
}

/**
 * Apply a list of changes to segments, returning a new segments array.
 *
 * Change shapes:
 *   { op: 'set',    key, value, enabled? }   — update existing or add new
 *   { op: 'enable', key, definitionId? }     — enable a definition; if definitionId (0-based
 *                                              occurrence index) is provided, that specific
 *                                              definition becomes active and siblings disabled;
 *                                              absent → the indexed (primary) definition wins
 *   { op: 'disable', key }                   — disable all definitions of key
 *   { op: 'delete',  key }                   — remove all definitions of key
 *
 * @param {Array}  segments
 * @param {Map}    index
 * @param {Array}  changes
 * @returns {Array} new segments array (original is not mutated)
 */
export function applyChanges(segments, index, changes) {
  const result = segments.map(s => ({ ...s }));
  const gMap   = buildGroupMap(result);

  // Last write wins: if the caller sends two changes for the same key, apply only the final one.
  const uniqueChanges = [...new Map(changes.map(c => [c.key, c])).values()];

  for (const change of uniqueChanges) {
    const { op, key } = change;

    if (!key || typeof key !== 'string') {
      throw new Error(`SegmentUtils.applyChanges: change missing 'key' field`);
    }

    const idx      = index.get(key);
    const siblings = gMap.get(key) ?? [];

    if (op === 'set') {
      const value   = String(change.value ?? '');
      const enabled = change.enabled !== undefined ? Boolean(change.enabled) : true;

      if (idx !== undefined) {
        result[idx] = { ...result[idx], value, enabled, modified: true };
        // Enabling clears the non-canonical disabledForm so a subsequent disable
        // produces canonical form rather than z-tag/xx-tag.
        if (enabled) result[idx] = { ...result[idx], disabledForm: null };
      } else {
        // New entry — insert before the first close tag after the last entry.
        const insertAt = findInsertionPoint(result);
        const indent   = guessIndent(result);
        const newSeg   = { type: 'entry', key, value, enabled, indent, original: null, modified: false };
        if (insertAt >= 0) {
          result.splice(insertAt, 0, newSeg);
        } else {
          result.push(newSeg);
        }
      }

    } else if (op === 'enable') {
      let target = idx;
      if (change.definitionId !== undefined) {
        const t = siblings[change.definitionId];
        if (t !== undefined) target = t;
      }
      for (const si of siblings) {
        const active = si === target;
        result[si] = { ...result[si], enabled: active, modified: true,
          ...(active ? { disabledForm: null } : {}) };
      }

    } else if (op === 'disable') {
      for (const si of siblings) {
        result[si] = { ...result[si], enabled: false, modified: true };
      }

    } else if (op === 'delete') {
      for (const si of siblings) {
        result[si] = { type: 'deleted' };
      }

    } else {
      throw new Error(`SegmentUtils.applyChanges: unknown op '${op}'`);
    }
  }

  return result;
}

/**
 * Build a flat entry list from parsed segments.
 *
 * @param {Array} segments
 * @returns {Array<{key, value, enabled}>}
 */
export function toEntries(segments) {
  return segments
    .filter(s => s.type === 'entry')
    .map(({ key, value, enabled }) => ({ key, value, enabled }));
}

/**
 * Generate a human-readable diff between two entry arrays.
 *
 * @param {Array} oldEntries
 * @param {Array} newEntries
 * @returns {string}
 */
export function diffEntries(oldEntries, newEntries) {
  const oldMap = new Map(oldEntries.map(e => [e.key, e]));
  const newMap = new Map(newEntries.map(e => [e.key, e]));
  const lines  = [];

  for (const [key, ne] of newMap) {
    const oe = oldMap.get(key);
    if (!oe) {
      lines.push(`+ ${key}=${ne.value} [${ne.enabled ? 'enabled' : 'disabled'}]`);
    } else if (oe.value !== ne.value) {
      lines.push(`~ ${key}: "${oe.value}" → "${ne.value}"`);
    } else if (oe.enabled !== ne.enabled) {
      lines.push(`~ ${key}: ${oe.enabled ? 'enabled' : 'disabled'} → ${ne.enabled ? 'enabled' : 'disabled'}`);
    }
  }
  for (const key of oldMap.keys()) {
    if (!newMap.has(key)) lines.push(`- ${key}`);
  }

  return lines.join('\n');
}

// ── Private helpers ────────────────────────────────────────────────────────────

/**
 * Find the insertion point for a new entry: the first 'other' segment that
 * begins with '</' that comes AFTER the last entry segment.
 *
 * Works for any XML config file:
 *   vars.xml        → inserts before </include>
 *   switch.conf.xml → inserts before </settings>
 *   event_socket    → inserts before </settings>
 *
 * Falls back to -1 (caller appends at end) if no suitable position is found.
 *
 * @param {Array} segments
 * @returns {number} segment index, or -1
 */
function findInsertionPoint(segments) {
  let lastEntryIdx = -1;
  for (let i = segments.length - 1; i >= 0; i--) {
    if (segments[i].type === 'entry') { lastEntryIdx = i; break; }
  }
  for (let i = lastEntryIdx + 1; i < segments.length; i++) {
    const s = segments[i];
    if (s.type === 'other' && s.content.trimStart().startsWith('</')) return i;
  }
  return -1;
}

/**
 * Guess the indentation of entry segments from the first entry found.
 *
 * @param {Array} segments
 * @returns {string}
 */
export function guessIndent(segments) {
  for (const s of segments) {
    if (s.type === 'entry' && s.indent) return s.indent;
  }
  return '  ';
}
