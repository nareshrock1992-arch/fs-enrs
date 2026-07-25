import crypto from 'crypto';
import {
  buildIndex,
  buildGroupMap,
  groupByKey,
  applyChanges,
  toEntries,
  diffEntries,
  guessIndent,
} from './SegmentUtils.js';

// Re-export so ConferenceProvider can import everything from one place.
export { buildIndex, buildGroupMap, groupByKey, applyChanges, toEntries, diffEntries, guessIndent };

/**
 * ConferenceParser — parses and serialises FreeSWITCH conference.conf.xml.
 *
 * conference.conf.xml has a multi-profile structure:
 *
 *   <profiles>
 *     <profile name="NAME">
 *       <param name="K" value="V"/>
 *       <!-- <param name="K" value="V"/> -->
 *     </profile>
 *   </profiles>
 *
 * Each param entry is keyed as `profileName___paramName` (triple-underscore
 * separator — never appears in profile names or param names).
 *
 * Sections outside <profiles> (<advertise>, <caller-controls>) are preserved
 * verbatim as 'other' segments — this parser only manages profile params.
 *
 * Segment model:
 *   { type: 'entry', key, value, enabled, indent, original, modified,
 *     _profileName, _paramName }
 *   { type: 'other',   content }
 *   { type: 'deleted' }           — produced by SegmentUtils.applyChanges
 *
 * Round-trip guarantee: unmodified segments (disabled or active) serialise
 * verbatim via their `original` field.
 */

const SEP = '___';

// <profile name="NAME">
const RE_PROFILE_OPEN  = /^(\s*)<profile\s+name="([^"]+)"\s*>/;
// </profile>
const RE_PROFILE_CLOSE = /^\s*<\/profile\s*>/;
// Active param: <param name="K" value="V"/>
const RE_ACTIVE  = /^(\s*)<param\s+name="([^"]+)"\s+value="([^"]*)"\s*\/?>/;
// Disabled param: <!-- <param name="K" value="V"/> -->  (optional spaces inside markers)
const RE_DISABLED = /^(\s*)<!--\s*<param\s+name="([^"]+)"\s+value="([^"]*)"\s*\/?>\s*-->/;

/** Compound key: 'profileName___paramName' */
export function paramKey(profileName, paramName) {
  return `${profileName}${SEP}${paramName}`;
}

/** Split a compound key back into { profileName, paramName }. */
export function splitKey(key) {
  const idx = key.indexOf(SEP);
  if (idx < 0) return { profileName: '', paramName: key };
  return { profileName: key.slice(0, idx), paramName: key.slice(idx + SEP.length) };
}

/**
 * Parse rawContent into segments.
 * @param {string} rawContent
 * @returns {{ segments: Array, checksum: string }}
 */
export function parse(rawContent) {
  const lines    = rawContent.split('\n');
  const segments = [];
  let   inBlock        = false;
  let   currentProfile = null;

  for (let i = 0; i < lines.length; i++) {
    const line    = lines[i];
    const trimmed = line.trim();

    // ── Inside a multi-line block comment ────────────────────────────────────
    if (inBlock) {
      if (trimmed === '-->' || trimmed.endsWith('-->')) inBlock = false;
      segments.push({ type: 'other', content: line });
      continue;
    }

    // ── Multi-line block comment start (not a single-line disabled param) ────
    if (trimmed.startsWith('<!--') && !trimmed.endsWith('-->')) {
      inBlock = true;
      segments.push({ type: 'other', content: line });
      continue;
    }

    // ── Profile open tag ──────────────────────────────────────────────────────
    const profileOpenMatch = RE_PROFILE_OPEN.exec(line);
    if (profileOpenMatch) {
      currentProfile = profileOpenMatch[2];
      segments.push({ type: 'other', content: line });
      continue;
    }

    // ── Profile close tag ─────────────────────────────────────────────────────
    if (RE_PROFILE_CLOSE.test(line)) {
      currentProfile = null;
      segments.push({ type: 'other', content: line });
      continue;
    }

    // ── Param entries — only inside a <profile> block ─────────────────────────
    if (currentProfile !== null) {
      const activeMatch   = RE_ACTIVE.exec(line);
      const disabledMatch = !activeMatch && RE_DISABLED.exec(line);

      if (activeMatch) {
        const paramName = activeMatch[2].trim();
        segments.push({
          type:         'entry',
          key:          paramKey(currentProfile, paramName),
          value:        activeMatch[3],
          enabled:      true,
          indent:       activeMatch[1],
          original:     line,
          modified:     false,
          _profileName: currentProfile,
          _paramName:   paramName,
        });
        continue;
      }

      if (disabledMatch) {
        const paramName = disabledMatch[2].trim();
        segments.push({
          type:         'entry',
          key:          paramKey(currentProfile, paramName),
          value:        disabledMatch[3],
          enabled:      false,
          indent:       disabledMatch[1],
          original:     line,
          modified:     false,
          _profileName: currentProfile,
          _paramName:   paramName,
        });
        continue;
      }
    }

    segments.push({ type: 'other', content: line });
  }

  return { segments, checksum: sha256(rawContent) };
}

/**
 * Serialise segments back to a string.
 *
 * Entry segments are regenerated using _paramName (from parse) or split from
 * the compound key (for new segments added via applyChanges).
 * Other segments are output verbatim.  Deleted segments are skipped.
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
    const indent    = seg.indent ?? '      ';
    const paramName = seg._paramName ?? splitKey(seg.key).paramName;

    if (seg.enabled) {
      lines.push(`${indent}<param name="${paramName}" value="${seg.value}"/>`);
    } else if (!seg.modified && seg.original != null) {
      lines.push(seg.original);
    } else {
      lines.push(`${indent}<!--<param name="${paramName}" value="${seg.value}"/>-->`);
    }
  }
  return lines.join('\n');
}

// ── Helpers ────────────────────────────────────────────────────────────────────

function sha256(str) {
  return crypto.createHash('sha256').update(str, 'utf8').digest('hex');
}
