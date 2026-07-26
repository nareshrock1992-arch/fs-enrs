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

// Re-export so GatewayFileProvider can import everything from one place.
export { buildIndex, buildGroupMap, groupByKey, applyChanges, toEntries, diffEntries, guessIndent };

/**
 * GatewayParser — parses and serialises FreeSWITCH gateway XML files.
 *
 * Each gateway file contains a single <gateway> block inside <include>:
 *
 *   <include>
 *     <gateway name="NAME">
 *       <param name="K" value="V"/>
 *       <!-- <param name="K" value="V"/> -->
 *     </gateway>
 *   </include>
 *
 * The gateway-name extraction is the only addition over SwitchConfParser —
 * all <param> parsing (active and disabled) is identical in format and is
 * handled by the same line-by-line regex logic used there.
 *
 * Special case — fully disabled gateway (e.g. a documentation template):
 *
 *   <include>
 *     <!--<gateway name="asterlink.com">-->
 *     <!--<param name="username" value="cluecon"/>-->
 *     ...
 *     <!--</gateway>-->
 *   </include>
 *
 * The gateway tag and close tag are 'other' segments (preserved verbatim).
 * The disabled <param> lines match RE_DISABLED and become disabled entries.
 * gatewayMeta.gatewayEnabled is false in this case — validation surfaces a
 * warning so the operator knows the gateway container itself is commented out.
 *
 * Segment model: same contract as SwitchConfParser.
 *   { type: 'entry', key, value, enabled, indent, original, modified }
 *   { type: 'other',   content }
 *   { type: 'deleted' }
 *
 * Round-trip guarantee: unmodified segments serialise verbatim via `original`.
 */

// Active param inside a gateway block.
const RE_ACTIVE   = /^(\s*)<param\s+name="([^"]+)"\s+value="([^"]*)"\s*\/?>/;
// Disabled param (single-line comment form; optional spaces inside markers).
const RE_DISABLED = /^(\s*)<!--\s*<param\s+name="([^"]+)"\s+value="([^"]*)"\s*\/?>\s*-->/;

// Active gateway open tag.
const RE_GATEWAY_OPEN      = /<gateway\s+name="([^"]+)"/;
// Disabled gateway open tag (entire tag commented out).
const RE_GATEWAY_OPEN_DIS  = /<!--[^>]*<gateway\s+name="([^"]+)"/;

/**
 * Extract gateway-level metadata from raw content.
 * Returns { name: string|null, gatewayEnabled: boolean }.
 */
export function extractGatewayMeta(rawContent) {
  // Active tag takes precedence.
  const active = RE_GATEWAY_OPEN.exec(rawContent);
  if (active) return { name: active[1], gatewayEnabled: true };
  // Disabled (template) gateway.
  const disabled = RE_GATEWAY_OPEN_DIS.exec(rawContent);
  if (disabled) return { name: disabled[1], gatewayEnabled: false };
  return { name: null, gatewayEnabled: false };
}

/**
 * Parse a gateway XML file into a document.
 *
 * @param {string} rawContent
 * @returns {{ segments, index, checksum, gatewayMeta }}
 */
export function parse(rawContent) {
  const lines    = rawContent.split('\n');
  const segments = [];
  let   inBlock  = false;

  for (let i = 0; i < lines.length; i++) {
    const line    = lines[i];
    const trimmed = line.trim();

    // ── Inside a multi-line block comment ────────────────────────────────────
    if (inBlock) {
      if (trimmed === '-->' || trimmed.endsWith('-->')) inBlock = false;
      segments.push({ type: 'other', content: line });
      continue;
    }

    // ── 3-line exact block: <!-- / <param.../> / --> ─────────────────────────
    // Normalise to a single disabled entry so the UI can toggle it.
    if (
      trimmed === '<!--' &&
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
      segments.push({ type: 'other', content: line });
      continue;
    }

    // ── Multi-line block comment start ────────────────────────────────────────
    if (trimmed.startsWith('<!--') && !trimmed.endsWith('-->')) {
      inBlock = true;
      segments.push({ type: 'other', content: line });
      continue;
    }

    // ── Per-line entry recognition ─────────────────────────────────────────────
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

  const gatewayMeta = extractGatewayMeta(rawContent);
  const index       = buildIndex(segments);
  return { segments, index, checksum: sha256(rawContent), gatewayMeta };
}

/**
 * Serialise segments back to a string.
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
    const indent = seg.indent != null ? seg.indent : '    ';
    if (seg.enabled) {
      lines.push(`${indent}<param name="${seg.key}" value="${seg.value}"/>`);
    } else if (!seg.modified && seg.original != null) {
      lines.push(seg.original);
    } else {
      lines.push(`${indent}<!--<param name="${seg.key}" value="${seg.value}"/>-->`);
    }
  }
  return lines.join('\n');
}

// ── Helpers ────────────────────────────────────────────────────────────────────

function sha256(str) {
  return crypto.createHash('sha256').update(str, 'utf8').digest('hex');
}
