/**
 * metadataUtils.js — Pure utility functions for ConfigurationEntry metadata.
 *
 * All functions are pure (no side effects, no imports). They operate on
 * ConfigurationObject/ConfigurationEntry shapes as returned by the read() API.
 *
 * Access pattern: functions check entry.metadata first, then fall back to
 * direct entry fields. This supports both the enriched format (Phase 7.3A+,
 * where metadata is nested under entry.metadata) and legacy flat access.
 *
 * Consumed by Phase 7.3B components:
 *   isVisible      → ConfigSection, ConfigFilters
 *   shouldShow     → ConfigSection
 *   getSearchText  → ConfigFilters (in-provider search)
 *   groupByHierarchy → ConfigPage / ConfigSection tree
 *   describeChange → ChangeSummary in DeployModal
 *   getDisplayName → ConfigCard, DetailsPanel
 */

// ── Visibility levels ─────────────────────────────────────────────────────────

/** Numeric rank for each visibility level. hidden = -1 (never shown). */
const VISIBILITY_RANK = { basic: 0, advanced: 1, expert: 2, hidden: -1 };

/**
 * Determine whether an entry should be shown at the current visibility level.
 *
 * 'basic'    shows: basic
 * 'advanced' shows: basic + advanced
 * 'expert'   shows: basic + advanced + expert
 * 'hidden'   never shown regardless of user level
 *
 * @param {object} entry         - ConfigurationObject from the API.
 * @param {string} visibilityLevel - 'basic' | 'advanced' | 'expert'
 * @returns {boolean}
 */
export function isVisible(entry, visibilityLevel = 'basic') {
  const meta = entry.metadata ?? entry;
  const entryRank = VISIBILITY_RANK[meta.visibility ?? 'basic'] ?? 0;
  const userRank  = VISIBILITY_RANK[visibilityLevel  ?? 'basic'] ?? 0;
  return entryRank >= 0 && entryRank <= userRank;
}

// ── Conditional visibility ─────────────────────────────────────────────────────

/**
 * Determine whether an entry passes its showIf condition.
 *
 * Returns true when:
 *  - No showIf condition is declared (entry is always shown), OR
 *  - The referenced key in currentValues equals the condition value.
 *
 * This is a single-equality condition only. The full condition engine
 * with operators (eq, neq, in, gt, etc.) is deferred to Phase 7.4.
 *
 * @param {object} entry         - ConfigurationObject from the API.
 * @param {object} currentValues - Map of key → current display value.
 * @returns {boolean}
 */
export function shouldShow(entry, currentValues = {}) {
  const meta   = entry.metadata ?? entry;
  const showIf = meta.showIf;
  if (!showIf || !showIf.key) return true;
  // Compare as strings — all values are strings in the vars model.
  return String(currentValues[showIf.key] ?? '') === String(showIf.value ?? '');
}

// ── Search ────────────────────────────────────────────────────────────────────

/**
 * Build a lowercase search index string for an entry.
 * Includes all human-readable text fields and aliases.
 * Used by ConfigFilters for in-provider search (no API call needed).
 *
 * @param {object} entry - ConfigurationObject from the API.
 * @returns {string} Lowercased space-joined searchable text.
 */
export function getSearchText(entry) {
  const meta = entry.metadata ?? entry;
  return [
    entry.key,
    meta.label,
    meta.description,
    meta.purpose,
    meta.notes,
    ...(meta.aliases          ?? []),
    ...(meta.relatedVariables ?? []),
    ...(meta.usedBy           ?? []),
  ]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();
}

// ── Grouping ──────────────────────────────────────────────────────────────────

const UNGROUPED = '__ungrouped';

/**
 * Group an array of entries into a two-level hierarchy:
 *   { [category]: { [group | '__ungrouped']: entry[] } }
 *
 * Preserves insertion order within each group.
 * ConfigSection renders this structure as collapsible accordions.
 *
 * @param {object[]} entries - Array of ConfigurationObjects.
 * @returns {object} Two-level grouped map.
 */
export function groupByHierarchy(entries) {
  const result = {};
  for (const entry of entries) {
    const meta     = entry.metadata ?? entry;
    const category = meta.category || 'Other';
    const group    = meta.group    || UNGROUPED;

    if (!result[category])        result[category]        = {};
    if (!result[category][group]) result[category][group] = [];

    result[category][group].push(entry);
  }
  return result;
}

/**
 * Sentinel value used as the group key when an entry has no group.
 * Exported so ConfigSection can detect and suppress the group header.
 */
export { UNGROUPED };

// ── Display name ──────────────────────────────────────────────────────────────

/**
 * Get the best human-readable display name for an entry.
 * Falls back: label → key → empty string.
 *
 * @param {object} entry - ConfigurationObject from the API.
 * @returns {string}
 */
export function getDisplayName(entry) {
  const meta = entry.metadata ?? entry;
  return meta.label || entry.key || '';
}

// ── Change description ────────────────────────────────────────────────────────

/**
 * Build a structured change description for the deploy summary modal.
 *
 * @param {object}      entry    - ConfigurationObject from the API.
 * @param {string|null} oldValue - Value before the change (null = was disabled/unset).
 * @param {string|null} newValue - Value after the change (null = being disabled/deleted).
 * @returns {{
 *   key:             string,
 *   label:           string,
 *   from:            string,
 *   to:              string,
 *   restartRequired: boolean,
 *   riskLevel:       string,
 *   sensitive:       boolean,
 * }}
 */
export function describeChange(entry, oldValue, newValue) {
  const meta = entry.metadata ?? entry;
  return {
    key:             entry.key,
    label:           meta.label           || entry.key,
    from:            oldValue  ?? '(unset)',
    to:              newValue  ?? '(unset)',
    restartRequired: meta.restartRequired ?? false,
    riskLevel:       meta.riskLevel       ?? 'low',
    sensitive:       meta.sensitive       ?? false,
  };
}
