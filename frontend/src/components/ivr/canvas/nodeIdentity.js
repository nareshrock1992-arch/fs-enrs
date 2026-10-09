// Shared, deterministic node display-identity resolution.
//
// PRESENTATION ONLY — nothing here is persisted or read by the Lua/XML
// generator or the runtime. It unifies how a node is *named* across the
// canvas card, the destination picker, and validation messages, so the same
// node reads the same way everywhere (fixes the "every Transfer looks like
// 'Transfer'" ambiguity in destination menus).
//
// Identity precedence (approved Phase 1):
//   1. administrator nickname   (node.nickname)
//   2. legacy label             (node.label — read-only migration; never written)
//   3. meaningful config summary (summaryTemplate rendered from config)
//   4. node-type display label  (cfg.label) — always present
//
// A short, stable node-id suffix is used ONLY as a last-resort tie-breaker in
// the destination picker, where otherwise-identical options must be told apart.
// It is computed at render time and never stored.

import { renderSummaryTemplate } from './nodeSubtitle.js';

const trimmed = (v) => (typeof v === 'string' ? v.trim() : '');

// A summary is "meaningful" only when it rendered to a non-empty string with no
// unresolved placeholder ("?" is renderSummaryTemplate's missing-field marker).
function meaningfulSummary(node, cfg, resolvers) {
  let s;
  try {
    s = renderSummaryTemplate(node, cfg, resolvers);
  } catch {
    s = null; // never let a malformed template crash identity resolution
  }
  s = trimmed(s);
  if (!s || s.includes('?')) return '';
  return s;
}

/**
 * Single best human-readable name for a node.
 * @param {object} node       the flow node (may be malformed/partial)
 * @param {object} cfg        the node type's registry entry (may be {})
 * @param {object} resolvers  optional id→name resolvers for summaryTemplate
 * @param {object} opts       { withSummary = true } — when false, skips the
 *                            config-summary level (used by the canvas card,
 *                            which already shows the summary as a subtitle, so
 *                            folding it into the title would duplicate it).
 */
export function nodeDisplayName(node, cfg = {}, resolvers = {}, opts = {}) {
  const withSummary = opts.withSummary !== false;
  const nn = trimmed(node?.nickname);
  if (nn) return nn;
  const legacy = trimmed(node?.label);
  if (legacy) return legacy;
  if (withSummary) {
    const summ = meaningfulSummary(node, cfg, resolvers);
    if (summ) return summ;
  }
  return trimmed(cfg?.label) || trimmed(node?.type) || 'Node';
}

/**
 * The disambiguating detail line (the node's config summary), or '' when none.
 * Used alongside the name in destination options so two same-type nodes with
 * different destinations/queues/prompts are distinguishable.
 */
export function nodeDisplayDetail(node, cfg = {}, resolvers = {}) {
  return meaningfulSummary(node, cfg, resolvers);
}

/**
 * Header hierarchy for a canvas card (Phase 2b): the prominent title plus the
 * node-type eyebrow. The type line is returned only when it is NOT redundant
 * with the title (i.e. a real configured name/summary is shown) — so a named
 * node reads "Route to Support / TRANSFER" while an unnamed one shows just the
 * type once, never "Transfer / Transfer". Presentation-only.
 */
export function nodeHeaderParts(node, cfg = {}, resolvers = {}) {
  const title = nodeDisplayName(node, cfg, resolvers, { withSummary: false });
  const typeLabel = trimmed(cfg?.label) || trimmed(node?.type);
  return { title, typeLabel: (typeLabel && title !== typeLabel) ? typeLabel : null };
}

/** Last 6 characters of the stable node id (render-time tie-breaker only). */
export function shortNodeId(node) {
  const id = String(node?.id ?? '');
  return id ? id.slice(-6) : '';
}

/**
 * Full option label for a destination/branch picker.
 * Format: "<icon> <primary> — <typeLabel>"
 *   primary = nickname | legacy label | meaningful summary | "#<shortId>"
 * The primary never collapses to the bare type: when nothing distinguishing
 * exists it falls to the stable short id, so no two different nodes can render
 * identical option text.
 */
export function nodeOptionLabel(node, cfg = {}, resolvers = {}) {
  const nn = trimmed(node?.nickname);
  const legacy = trimmed(node?.label);
  const summ = meaningfulSummary(node, cfg, resolvers);
  const primary = nn || legacy || summ || `#${shortNodeId(node)}`;
  const typeLabel = trimmed(cfg?.label) || trimmed(node?.type) || 'Node';
  const icon = cfg?.icon ? `${cfg.icon} ` : '';
  // Avoid "Transfer — Transfer" when the primary already equals the type label.
  const suffix = primary === typeLabel ? '' : ` — ${typeLabel}`;
  return `${icon}${primary}${suffix}`.trim();
}
