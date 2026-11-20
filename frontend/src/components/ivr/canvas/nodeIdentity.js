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
  // An unnamed node is called what the canvas calls it ("Hangup 2"), when the
  // caller supplies the flow's stand-in names (nodeDisplayNames).
  const standIn = standInName(node, resolvers);
  if (standIn) return standIn;
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

// ── Default names for new nodes ────────────────────────────────────────────
// The builder names a node it creates ("Menu 1", "Say 2") so the canvas,
// destination lists and messages never fall back to internal ids. The name is
// an ordinary editable nickname (cosmetic; never read by the runtime).

export const NICKNAME_MAX = 200;   // ivrValidator BASE_NODE_FIELDS.nickname

export const DEFAULT_NAME_BASES = Object.freeze({
  play: 'Play audio', say: 'Say', gather: 'Menu', condition: 'Condition', goto: 'Go to',
  ens: 'ENS', ers: 'ERS', hangup: 'Hangup', record_message: 'Record', set_variable: 'Set variable',
  transfer: 'Transfer', webhook: 'Webhook', rest_api: 'REST API', queue_eligibility: 'Queue check',
  queue_wait: 'Queue wait', ers_ring_all: 'Ring all', ers_overflow_check: 'Overflow check',
  ers_overflow_wait: 'Overflow wait', ens_blast_record: 'ENS blast', ens_playback: 'ENS playback',
});

const escapeRe = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// Builder ids are "node_<ms>_<seq>": order them by creation. Template and
// hand-written ids ("main_menu") sort first, alphabetically.
const BUILDER_ID = /^node_(\d+)_(\d+)$/;
function compareIds(a, b) {
  const ma = BUILDER_ID.exec(a);
  const mb = BUILDER_ID.exec(b);
  if (ma && mb) return (Number(ma[1]) - Number(mb[1])) || (Number(ma[2]) - Number(mb[2]));
  if (ma) return 1;
  if (mb) return -1;
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * The name the builder shows for every node, keyed by node id: the stored name
 * (nickname, then legacy label), else a stand-in such as "Hangup 2" for an
 * unnamed node — numbered per type in creation order and never equal to a name
 * already in the flow. Display only: nothing is written until the
 * administrator types a name. Replaces the old "#<id>" fallback.
 */
export function nodeDisplayNames(nodes, byType = {}) {
  const entries = Object.entries(nodes || {});
  const out = {};
  const used = new Set();
  for (const [id, n] of entries) {
    const name = trimmed(n?.nickname) || trimmed(n?.label);
    if (name) { out[id] = name; used.add(name.toLowerCase()); }
  }
  const unnamed = entries.filter(([id]) => !out[id]).sort(([a], [b]) => compareIds(a, b));
  for (const [id, n] of unnamed) {
    const base = DEFAULT_NAME_BASES[n?.type] || trimmed(byType?.[n?.type]?.label) || trimmed(n?.type) || 'Node';
    let i = 1;
    while (used.has(`${base} ${i}`.toLowerCase())) i++;
    out[id] = `${base} ${i}`;
    used.add(out[id].toLowerCase());
  }
  return out;
}

function standInName(node, resolvers) {
  return typeof resolvers?.displayName === 'function' ? trimmed(resolvers.displayName(node?.id)) : '';
}

// Names a new node must not take: every stored name and every stand-in name.
const usedNames = nodes => new Set(Object.values(nodeDisplayNames(nodes)).map(s => s.toLowerCase()));
function firstFree(make, nodes) {
  const used = usedNames(nodes);
  for (let n = 1; ; n++) {
    const name = make(n);
    if (!used.has(name.toLowerCase())) return name;
  }
}

/** "Menu 1", "Menu 2", …: the first free default name for a new node of this type (undefined for unknown types). */
export function defaultNodeName(type, nodes) {
  const base = DEFAULT_NAME_BASES[type];
  return base ? firstFree(n => `${base} ${n}`, nodes) : undefined;
}

/** True while a node still carries a builder-given default name. */
export function isDefaultNodeName(node) {
  const base = DEFAULT_NAME_BASES[node?.type];
  return !!base && new RegExp(`^${escapeRe(base)} \\d+$`).test(trimmed(node?.nickname));
}

/** Name for a duplicate: the next default name, or "<name> (copy)", "<name> (copy 2)", …; never a name already used. */
export function copyNodeName(source, nodes) {
  const nn = trimmed(source?.nickname);
  if (!nn || isDefaultNodeName(source)) return defaultNodeName(source?.type, nodes) ?? (nn || undefined);
  return firstFree(n => {
    const suffix = n === 1 ? ' (copy)' : ` (copy ${n})`;
    return nn.slice(0, NICKNAME_MAX - suffix.length) + suffix;
  }, nodes);
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
  // A builder-given default name ("Say 2") or an unnamed node's stand-in name
  // says little on its own, so the config summary is kept beside it until the
  // administrator names the node.
  const standIn = nn || legacy ? '' : standInName(node, resolvers);
  const generic = nn ? (isDefaultNodeName(node) ? nn : '') : standIn;
  const named = generic ? (summ ? `${generic} · ${summ}` : generic) : nn;
  const primary = named || legacy || summ || `#${shortNodeId(node)}`;
  const typeLabel = trimmed(cfg?.label) || trimmed(node?.type) || 'Node';
  const icon = cfg?.icon ? `${cfg.icon} ` : '';
  // Avoid "Transfer — Transfer" when the primary already equals the type label.
  const suffix = primary === typeLabel ? '' : ` — ${typeLabel}`;
  return `${icon}${primary}${suffix}`.trim();
}
