import crypto from 'crypto';

/**
 * VarsParser — parses and serialises FreeSWITCH vars.xml.
 *
 * vars.xml uses a line-oriented format where each variable is a single
 * X-PRE-PROCESS element. Disabled variables are wrapped in XML comment
 * markers. This parser preserves all other content (block comments, blank
 * lines, the XML declaration, the <include> wrapper) byte-for-byte.
 *
 * Segment model:
 *  { type: 'entry', key, value, enabled, original }
 *  { type: 'other', content }                        ← preserved verbatim
 *
 * NEVER called with cached content — the caller (DeploymentManager) always
 * reads the file fresh from disk before passing rawContent here.
 */

// Matches an active X-PRE-PROCESS set directive.
// Captures (full leading indent, key, value).
const RE_ACTIVE = /^(\s*)<X-PRE-PROCESS\s+cmd="set"\s+data="([^"=]+)=([^"]*)"\s*\/?>/;

// Matches a disabled X-PRE-PROCESS set directive wrapped in an XML comment.
// Handles both <!--<X-PRE-PROCESS ... />--> and <!-- <X-PRE-PROCESS ... /> -->.
const RE_DISABLED = /^(\s*)<!--\s*<X-PRE-PROCESS\s+cmd="set"\s+data="([^"=]+)=([^"]*)"\s*\/?>\s*-->/;

/**
 * Parse rawContent into a list of segments.
 * @param {string} rawContent
 * @returns {{ segments: Array, checksum: string }}
 */
export function parse(rawContent) {
  const lines    = rawContent.split('\n');
  const segments = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // ── Multi-line comment block detection ──────────────────────────────────
    // Handles the FreeSWITCH convention of wrapping a disabled variable in a
    // standalone comment block:
    //   <!--
    //     <X-PRE-PROCESS cmd="set" data="key=value"/>
    //   -->
    //
    // Without this, the inner <X-PRE-PROCESS> line matches RE_ACTIVE and the
    // variable appears as ENABLED in the UI. We detect the exact 3-line
    // pattern (comment opener / single directive / comment closer) and absorb
    // it as one disabled entry, normalising to the single-line format on next
    // save. Only the exact opener/closer pattern is matched to avoid eating
    // multi-content block comments that contain other text.
    if (
      line.trim() === '<!--' &&
      i + 2 < lines.length &&
      lines[i + 2].trim() === '-->'
    ) {
      const innerMatch = RE_ACTIVE.exec(lines[i + 1]);
      if (innerMatch) {
        segments.push({
          type:     'entry',
          key:      innerMatch[2].trim(),
          value:    innerMatch[3],
          enabled:  false,
          indent:   innerMatch[1],
          original: line + '\n' + lines[i + 1] + '\n' + lines[i + 2],
        });
        i += 2; // consume the inner line and the closing -->
        continue;
      }
    }

    const activeMatch   = RE_ACTIVE.exec(line);
    const disabledMatch = !activeMatch && RE_DISABLED.exec(line);

    if (activeMatch) {
      segments.push({
        type:     'entry',
        key:      activeMatch[2].trim(),
        value:    activeMatch[3],
        enabled:  true,
        indent:   activeMatch[1],
        original: line,
      });
    } else if (disabledMatch) {
      segments.push({
        type:     'entry',
        key:      disabledMatch[2].trim(),
        value:    disabledMatch[3],
        enabled:  false,
        indent:   disabledMatch[1],
        original: line,
      });
    } else {
      segments.push({ type: 'other', content: line });
    }
  }

  return {
    segments,
    checksum: sha256(rawContent),
  };
}

/**
 * Build a Map<key → segment index> for O(1) key lookups.
 * @param {Array} segments
 * @returns {Map<string, number>}
 */
export function buildIndex(segments) {
  const idx = new Map();
  segments.forEach((seg, i) => {
    if (seg.type === 'entry') idx.set(seg.key, i);
  });
  return idx;
}

/**
 * Apply a list of changes to segments, returning a new segments array.
 *
 * Change shapes:
 *   { op: 'set',    key, value, enabled? }   — update existing or add new
 *   { op: 'enable', key }                    — enable a disabled variable
 *   { op: 'disable', key }                   — comment out a variable
 *   { op: 'delete', key }                    — remove a variable entirely
 *
 * @param {Array}  segments
 * @param {Map}    index
 * @param {Array}  changes
 * @returns {Array} new segments array (original is not mutated)
 */
export function applyChanges(segments, index, changes) {
  // Clone so we never mutate the original parsed state.
  const result = segments.map(s => ({ ...s }));

  // Last write wins: if the caller sends two changes for the same key
  // (e.g. a value edit followed by a toggle), apply only the final one.
  // This also prevents a new key from being splice-inserted twice when
  // the same key appears more than once and the index hasn't been updated.
  const uniqueChanges = [...new Map(changes.map(c => [c.key, c])).values()];

  for (const change of uniqueChanges) {
    const { op, key } = change;

    if (!key || typeof key !== 'string') {
      throw new Error(`VarsParser.applyChanges: change missing 'key' field`);
    }

    const idx = index.get(key);

    if (op === 'set') {
      const value   = String(change.value ?? '');
      const enabled = change.enabled !== undefined ? Boolean(change.enabled) : true;

      if (idx !== undefined) {
        result[idx] = { ...result[idx], value, enabled };
      } else {
        // New variable — append before the closing </include> tag.
        const closeIdx = findCloseTag(result);
        const indent   = guessIndent(result);
        const newSeg   = { type: 'entry', key, value, enabled, indent, original: null };
        if (closeIdx >= 0) {
          result.splice(closeIdx, 0, newSeg);
          // The index is now stale, but we've built it before this call;
          // the caller does not reuse the index after applyChanges.
        } else {
          result.push(newSeg);
        }
      }
    } else if (op === 'enable') {
      if (idx !== undefined) result[idx] = { ...result[idx], enabled: true };
    } else if (op === 'disable') {
      if (idx !== undefined) result[idx] = { ...result[idx], enabled: false };
    } else if (op === 'delete') {
      if (idx !== undefined) result[idx] = { type: 'deleted' };
    } else {
      throw new Error(`VarsParser.applyChanges: unknown op '${op}'`);
    }
  }

  return result;
}

/**
 * Serialise segments back to a string.
 * Entry segments are regenerated from (key, value, enabled).
 * Other segments are output verbatim. Deleted segments are skipped.
 *
 * @param {Array} segments
 * @returns {string}
 */
export function serialize(segments) {
  const lines = [];
  for (const seg of segments) {
    if (seg.type === 'deleted') continue;

    if (seg.type === 'other') {
      lines.push(seg.content);
      continue;
    }

    // type === 'entry'
    const indent = seg.indent || '  ';
    const data   = `${seg.key}=${seg.value}`;
    if (seg.enabled) {
      lines.push(`${indent}<X-PRE-PROCESS cmd="set" data="${data}"/>`);
    } else {
      lines.push(`${indent}<!--<X-PRE-PROCESS cmd="set" data="${data}"/>-->`);
    }
  }
  return lines.join('\n');
}

/**
 * Build a flat ConfigEntry list from parsed segments.
 * Only returns segments of type 'entry'.
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
 * Generate a unified-diff style summary (not a real unified diff — a concise
 * human-readable list of what changed between oldEntries and newEntries).
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

// ── Helpers ────────────────────────────────────────────────────────────────────

function sha256(str) {
  return crypto.createHash('sha256').update(str, 'utf8').digest('hex');
}

function findCloseTag(segments) {
  for (let i = segments.length - 1; i >= 0; i--) {
    const s = segments[i];
    if (s.type === 'other' && s.content.trimStart().startsWith('</include>')) {
      return i;
    }
  }
  return -1;
}

function guessIndent(segments) {
  for (const s of segments) {
    if (s.type === 'entry' && s.indent) return s.indent;
  }
  return '  ';
}
