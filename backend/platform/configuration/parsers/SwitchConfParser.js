import crypto from 'crypto';
import {
  buildIndex,
  buildGroupMap,
  groupByKey,
  applyChanges,
  toEntries,
  diffEntries,
} from './SegmentUtils.js';

// Re-export so SwitchCoreProvider can import everything from one place.
export { buildIndex, buildGroupMap, groupByKey, applyChanges, toEntries, diffEntries };

/**
 * SwitchConfParser — parses and serialises FreeSWITCH switch.conf.xml.
 *
 * switch.conf.xml uses a <param name="KEY" value="VALUE"/> structure inside
 * a <settings> block. Disabled params are wrapped in XML comment markers.
 *
 * Segment model (identical contract to VarsParser):
 *  { type: 'entry', key, value, enabled, indent, original, modified }
 *  { type: 'other', content }
 *
 * Unlike vars.xml there are no Z-tag or XX-tag disable conventions —
 * only the canonical <!--<param .../> --> comment form is recognised.
 *
 * Unmodified disabled entries are round-tripped verbatim via `original`.
 * Once modified, they regenerate in canonical form.
 */

// Matches an active param directive.
// Captures: (indent, name, value)
const RE_ACTIVE = /^(\s*)<param\s+name="([^"]+)"\s+value="([^"]*)"\s*\/?>/;

// Matches a disabled param directive inside an XML comment.
// Handles both <!--<param.../> --> and <!-- <param.../> -->.
const RE_DISABLED = /^(\s*)<!--\s*<param\s+name="([^"]+)"\s+value="([^"]*)"\s*\/?>\s*-->/;

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

    // Multi-line comment block:
    //   <!--
    //     <param name="key" value="val"/>
    //   -->
    // Normalise to a single disabled entry on the next save.
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
        i += 2;
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
    } else {
      segments.push({ type: 'other', content: line });
    }
  }

  return { segments, checksum: sha256(rawContent) };
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
    const indent = seg.indent != null ? seg.indent : '  ';
    if (seg.enabled) {
      lines.push(`${indent}<param name="${seg.key}" value="${seg.value}"/>`);
    } else if (!seg.modified && seg.original != null) {
      // Unmodified disabled entry: round-trip the exact original line(s).
      lines.push(seg.original);
    } else {
      // Canonical disabled form.
      lines.push(`${indent}<!--<param name="${seg.key}" value="${seg.value}"/>-->`);
    }
  }
  return lines.join('\n');
}

// ── Helpers ────────────────────────────────────────────────────────────────────

function sha256(str) {
  return crypto.createHash('sha256').update(str, 'utf8').digest('hex');
}
