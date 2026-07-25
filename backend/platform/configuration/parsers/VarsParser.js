import crypto from 'crypto';
import {
  buildIndex,
  buildGroupMap,
  groupByKey,
  applyChanges,
  toEntries,
  diffEntries,
} from './SegmentUtils.js';

// Re-export for backward compatibility — callers that import these from
// VarsParser (VarsProvider, tests) continue to work without changes.
export { buildIndex, buildGroupMap, groupByKey, applyChanges, toEntries, diffEntries };

/**
 * VarsParser — parses and serialises FreeSWITCH vars.xml.
 *
 * vars.xml uses a line-oriented format where each variable is a single
 * X-PRE-PROCESS element. Disabled variables are wrapped in XML comment
 * markers. This parser preserves all other content (block comments, blank
 * lines, the XML declaration, the <include> wrapper) byte-for-byte.
 *
 * Segment model:
 *  { type: 'entry', key, value, enabled, indent, original, modified, disabledForm? }
 *  { type: 'other', content }   ← preserved verbatim
 *
 * disabledForm values:
 *  undefined / null  — canonical <!--<X-PRE-PROCESS.../>--> form (or enabled)
 *  'z-tag'           — <!--<Z-PRE-PROCESS.../>--> (FreeSWITCH Z-prefix convention)
 *  'xx-tag'          — <XX-PRE-PROCESS.../> (FreeSWITCH XX-prefix convention)
 *
 * modified: false on parse; set to true by applyChanges when the entry is touched.
 * Unmodified z-tag / xx-tag entries are round-tripped verbatim (via original).
 * Once modified (enabled, value changed, re-disabled), they regenerate in the
 * appropriate format. An entry that transitions through enabled clears disabledForm
 * so subsequent disable produces canonical form.
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

// FreeSWITCH Z-prefix convention: <!--<Z-PRE-PROCESS cmd="set" data="key=val"/> -->
// The Z tag inside an XML comment is one of two documented disable mechanisms.
// The trailing --> may have optional whitespace before it.
const RE_Z_TAG = /^(\s*)<!--\s*<Z-PRE-PROCESS\s+cmd="set"\s+data="([^"=]+)=([^"]*)"\s*\/?>\s*-->/;

// FreeSWITCH XX-prefix convention: <XX-PRE-PROCESS cmd="set" data="key=val"/>
// A bare (non-commented) tag with XX prefix — FreeSWITCH ignores tags it
// doesn't recognise. Comments in vars.xml read "change XX to X below to enable".
const RE_XX_TAG = /^(\s*)<XX-PRE-PROCESS\s+cmd="set"\s+data="([^"=]+)=([^"]*)"\s*\/?>/;

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
          modified: false,
        });
        i += 2; // consume the inner line and the closing -->
        continue;
      }
    }

    const activeMatch   = RE_ACTIVE.exec(line);
    const disabledMatch = !activeMatch && RE_DISABLED.exec(line);
    const zTagMatch     = !activeMatch && !disabledMatch && RE_Z_TAG.exec(line);
    const xxTagMatch    = !activeMatch && !disabledMatch && !zTagMatch && RE_XX_TAG.exec(line);

    if (activeMatch) {
      segments.push({
        type:     'entry',
        key:      activeMatch[2].trim(),
        value:    activeMatch[3],
        enabled:  true,
        indent:   activeMatch[1],
        original: line,
        modified: false,
      });
    } else if (disabledMatch) {
      segments.push({
        type:     'entry',
        key:      disabledMatch[2].trim(),
        value:    disabledMatch[3],
        enabled:  false,
        indent:   disabledMatch[1],
        original: line,
        modified: false,
      });
    } else if (zTagMatch) {
      segments.push({
        type:         'entry',
        key:          zTagMatch[2].trim(),
        value:        zTagMatch[3],
        enabled:      false,
        indent:       zTagMatch[1],
        original:     line,
        modified:     false,
        disabledForm: 'z-tag',
      });
    } else if (xxTagMatch) {
      segments.push({
        type:         'entry',
        key:          xxTagMatch[2].trim(),
        value:        xxTagMatch[3],
        enabled:      false,
        indent:       xxTagMatch[1],
        original:     line,
        modified:     false,
        disabledForm: 'xx-tag',
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
    // Use null/undefined check, not falsy, so zero-indent entries ('') are preserved
    // rather than being silently expanded to 2 spaces on the next write.
    const indent = seg.indent != null ? seg.indent : '  ';
    const data   = `${seg.key}=${seg.value}`;
    if (seg.enabled) {
      lines.push(`${indent}<X-PRE-PROCESS cmd="set" data="${data}"/>`);
    } else if (!seg.modified && seg.disabledForm && seg.original != null) {
      // Unmodified z-tag / xx-tag entries: round-trip the exact original line.
      lines.push(seg.original);
    } else if (seg.disabledForm === 'z-tag') {
      // Modified z-tag: regenerate in Z-prefix comment form.
      lines.push(`${indent}<!--<Z-PRE-PROCESS cmd="set" data="${data}"/> -->`);
    } else if (seg.disabledForm === 'xx-tag') {
      // Modified xx-tag: regenerate in XX-prefix bare-tag form.
      lines.push(`${indent}<XX-PRE-PROCESS cmd="set" data="${data}"/>`);
    } else {
      // Canonical disabled form (xml-comment, 3-line-block normalised, or new).
      lines.push(`${indent}<!--<X-PRE-PROCESS cmd="set" data="${data}"/>-->`);
    }
  }
  return lines.join('\n');
}

// ── Helpers ────────────────────────────────────────────────────────────────────

function sha256(str) {
  return crypto.createHash('sha256').update(str, 'utf8').digest('hex');
}
