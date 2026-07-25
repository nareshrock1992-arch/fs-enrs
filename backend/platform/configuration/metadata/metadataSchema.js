/**
 * metadataSchema.js — Canonical metadata schema for configuration parameters.
 *
 * Defines:
 *  - JSDoc typedefs for ConfigurationEntry, ConfigurationObject, ConfigurationSnapshot
 *  - applyMetaDefaults(raw) — normalises any partial catalog entry into a
 *    guaranteed-complete ConfigurationEntry
 *
 * All catalog files pass their entries through applyMetaDefaults() via lookupVar().
 * All UI components receive metadata that has been normalised through this function.
 * No UI component needs to null-check individual metadata fields.
 *
 * Backward-compat aliases resolved by applyMetaDefaults():
 *   entry.min      → validation.min       (flat field still preserved on entry)
 *   entry.max      → validation.max       (flat field still preserved on entry)
 *   entry.options  → validation.allowedValues (flat field still preserved)
 *   entry.required → validation.required  (flat field still preserved)
 *   entry.advanced = true → visibility: 'advanced'
 *   entry.adminLevel      → visibility (1:1 mapping)
 */

// ── Typedefs ──────────────────────────────────────────────────────────────────

/**
 * @typedef {object} ValidationRules
 * @property {boolean}  required      - Field must not be empty.
 * @property {number|null} min        - Minimum numeric value.
 * @property {number|null} max        - Maximum numeric value.
 * @property {string|null} pattern    - Regex pattern (string form, JSON-safe).
 * @property {string[]|null} allowedValues - Explicit allowed values (enum).
 * @property {string|null} customMessage   - Override for default error text.
 */

/**
 * @typedef {object} ShowIfCondition
 * @property {string} key   - Key of another entry in the same provider.
 * @property {*}      value - This entry is shown when referenced entry equals value.
 */

/**
 * @typedef {object} ConfigurationEntry
 * Canonical metadata for a single configuration parameter.
 * Produced by applyMetaDefaults(). All fields are guaranteed present.
 *
 * @property {string}  key             - Parameter name (machine-readable).
 * @property {string}  label           - Short display name.
 * @property {string}  category        - Top-level section group.
 * @property {string|null} group       - Sub-section within category.
 *
 * @property {string|null} description     - One-line description.
 * @property {string|null} purpose         - 2–4 sentences on why this parameter exists.
 * @property {string|null} notes           - Caveats, operational guidance.
 * @property {string|null} example         - A realistic sample value.
 * @property {string|null} documentationRef - External URL (FS wiki, RFC, etc.)
 *
 * @property {string}  type - Input control type.
 *   Values: string | integer | port | boolean | enum | password | ip |
 *           hostname | multiline | readonly | directory
 *
 * @property {ValidationRules} validation - Normalised validation rules.
 *
 * @property {string|null} defaultValue     - Engine built-in default.
 * @property {string|null} recommendedValue - Production recommendation.
 *
 * @property {'basic'|'advanced'|'expert'|'hidden'} visibility
 *   Controls what complexity level shows this entry.
 *   Separate from RBAC — visibility is about UI complexity, not user permissions.
 *
 * @property {boolean} editable         - false = rendered as read-only display.
 * @property {boolean} sensitive        - true = password masking applied.
 *
 * @property {boolean}    restartRequired  - true = warn in deploy summary.
 * @property {'low'|'medium'|'high'} riskLevel - Entry-level risk classification.
 * @property {string|null} estimatedDowntime - Human-readable downtime string.
 * @property {string[]} affectedServices  - Services this parameter touches.
 *
 * @property {string[]}  aliases          - Search aliases and alternative names.
 * @property {string[]}  relatedVariables - Keys within the same provider.
 * @property {string[]}  usedBy           - Service names that consume this value.
 *
 * @property {ShowIfCondition|null} showIf
 *   Show this entry only when the referenced entry equals the specified value.
 *   Single equality condition. Full condition engine deferred to Phase 7.4.
 */

/**
 * @typedef {object} AlternativeDefinition
 * One non-primary definition of a configuration key found in the file.
 *
 * @property {string}  value        - The value from this definition.
 * @property {boolean} enabled      - Always false for alternatives (primary is the active one).
 * @property {number}  definitionId - 0-based occurrence index within this key's definitions.
 * @property {string}  disabledHint - Display-only label describing how this definition is
 *                                    disabled (e.g. 'XML comment', 'Z-tag convention').
 *                                    Purely presentational — never branch on this value.
 */

/**
 * @typedef {object} ConfigurationObject
 * A parsed configuration parameter as returned by the read() API.
 * Produced by the Provider's parse() method after merging segments with catalog metadata.
 *
 * @property {string}     key          - Parameter name.
 * @property {string|null} value       - Primary definition's value.
 * @property {boolean}    enabled      - Primary definition's active state.
 * @property {number}     definitionId - 0-based occurrence index of the primary definition
 *                                       among all definitions of this key (file order).
 *                                       Echoed back by the frontend in `enable` changes to
 *                                       target a specific definition for activation.
 * @property {AlternativeDefinition[]} alternatives
 *                                     - All non-primary definitions for this key.
 *                                       Empty array when the key appears exactly once in the file.
 * @property {ConfigurationEntry} metadata - Full enriched metadata from the catalog.
 *
 * Note: All ConfigurationEntry fields are ALSO spread flat onto the object for
 * backward compatibility with existing UI code (entry.label, entry.type, etc.).
 * Prefer entry.metadata.* for new code.
 *
 * The providerId and source (file path) are available at the snapshot level,
 * not per-entry, to avoid redundant data in large entry arrays.
 */

/**
 * @typedef {object} ConfigurationSnapshot
 * The complete response from GET /api/v1/platform/config/:providerId.
 *
 * @property {string}   providerId - The provider ID (e.g. 'vars').
 * @property {string}   filePath   - Absolute path of the source file.
 * @property {string}   parsedAt   - ISO 8601 timestamp of the read.
 * @property {string}   checksum   - SHA-256 of the raw file content.
 * @property {ConfigurationObject[]} entries - All parsed entries (active + disabled).
 */

// ── Core function ─────────────────────────────────────────────────────────────

/**
 * applyMetaDefaults — normalise a partial catalog entry into a complete ConfigurationEntry.
 *
 * Every catalog file calls this via lookupVar() before returning metadata to callers.
 * The result is a guaranteed-complete object: no field will be undefined.
 *
 * Design rules:
 *  1. Raw fields are preserved — existing code reading entry.min, entry.options, etc. still works.
 *  2. Backward-compat aliases are resolved transparently.
 *  3. All new fields default to safe, non-breaking values.
 *  4. This function is pure — no I/O, no side effects.
 *
 * @param {object} raw - Partial catalog entry (any subset of ConfigurationEntry fields).
 * @returns {ConfigurationEntry} Complete, normalised metadata object.
 */
export function applyMetaDefaults(raw) {
  if (!raw || typeof raw !== 'object') raw = {};

  // Resolve visibility from possible backward-compat sources.
  let visibility = raw.visibility;
  if (!visibility) {
    if      (raw.adminLevel)     visibility = raw.adminLevel;
    else if (raw.advanced === true) visibility = 'advanced';
    else                         visibility = 'basic';
  }
  // Clamp to valid values.
  if (!['basic', 'advanced', 'expert', 'hidden'].includes(visibility)) {
    visibility = 'basic';
  }

  // Normalise validation rules into a sub-object.
  // The flat fields (raw.min, raw.max, raw.options, raw.required) are preserved
  // on the returned object via ...raw spread below, so existing code is unaffected.
  const validation = {
    required:      raw.validation?.required      ?? raw.required      ?? false,
    min:           raw.validation?.min           ?? raw.min           ?? null,
    max:           raw.validation?.max           ?? raw.max           ?? null,
    pattern:       raw.validation?.pattern                            ?? null,
    allowedValues: raw.validation?.allowedValues ?? raw.options       ?? null,
    customMessage: raw.validation?.customMessage                      ?? null,
  };

  return {
    // Spread raw FIRST to preserve all existing flat fields (backward compat).
    ...raw,

    // Override/add normalised fields. These take precedence over raw.
    visibility,
    validation,

    // Documentation
    group:            raw.group            ?? null,
    purpose:          raw.purpose          ?? null,
    notes:            raw.notes            ?? null,
    documentationRef: raw.documentationRef ?? null,

    // Defaults
    defaultValue:     raw.defaultValue     ?? null,
    recommendedValue: raw.recommendedValue ?? null,

    // Display control
    editable:         raw.editable         ?? true,
    sensitive:        raw.sensitive        ?? false,

    // Deployment impact
    restartRequired:  raw.restartRequired  ?? false,
    riskLevel:        raw.riskLevel        ?? 'low',
    estimatedDowntime: raw.estimatedDowntime ?? null,
    affectedServices: raw.affectedServices ?? [],

    // Search and cross-references
    aliases:          raw.aliases          ?? [],
    relatedVariables: raw.relatedVariables ?? [],
    usedBy:           raw.usedBy           ?? [],

    // Simple conditional visibility (engine deferred to Phase 7.4)
    showIf:           raw.showIf           ?? null,
  };
}
