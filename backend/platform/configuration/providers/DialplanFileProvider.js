import { ConfigurationProvider } from '../ConfigurationProvider.js';
import { DeploymentStrategies } from '../deploy/DeploymentStrategy.js';
import {
  parse     as dpParse,
  serialize as dpSerialize,
  applyChanges as dpApplyChanges,
  diff      as dpDiff,
} from '../parsers/DialplanParser.js';
import {
  lookupApplication,
  lookupField,
  knownApplicationNames,
  knownFieldNames,
} from '../catalogs/dialplanCatalog.js';

/**
 * DialplanFileProvider — manages one FreeSWITCH dialplan XML file.
 *
 * Provider ID convention:  'dialplan:<basename>'  (no .xml suffix)
 * Example:  default.xml  →  dialplan:default
 *           public.xml   →  dialplan:public
 *
 * Instances are created by the dialplan discovery logic in providers/index.js
 * (Phase 5). No filename is hardcoded here.
 *
 * Document model: DialplanDoc (hierarchical ordered graph — see DialplanParser).
 * docType: 'hierarchical' — the frontend TreeRenderer is used, not ConfigPage.
 *
 * ── entries adapter ────────────────────────────────────────────────────────────
 *
 * ConfigurationManager.read() expects parsed.entries to exist. For flat
 * providers entries is the primary document representation. For this provider
 * the primary document is DialplanDoc, and entries is a compatibility adapter
 * set to doc.nodes so ConfigurationManager receives a non-empty array.
 *
 * Callers that understand hierarchical providers use doc.nodes directly.
 * Callers that only know about entries (dashboard counts, audit log) receive a
 * meaningful value without requiring any change to ConfigurationManager.
 *
 * The parser has no knowledge of entries. The adaptation lives here only.
 *
 * ── Validation contract (frozen) ───────────────────────────────────────────────
 *
 * BLOCKING ERRORS (valid = false, deployment prevented):
 *   - Parser failure (malformed XML that cannot be parsed)
 *   - Duplicate extension names within the context
 *   - Structurally invalid DialplanDoc (missing contextName)
 *
 * NON-BLOCKING WARNINGS (warnings[], valid remains true, deployment allowed):
 *   - Unknown applications  — unknown ≠ invalid; custom modules are common
 *   - Unknown condition fields — unknown ≠ invalid; custom variables are common
 *   - High-risk applications  — surfaced to UI for operator awareness
 *   - Missing data on dataRequired applications — may be intentional
 *   - Disabled extensions     — informational
 *   - Empty dialplan           — an administrator may be building it
 *
 * This distinction must be preserved. Custom FreeSWITCH deployments with
 * proprietary or third-party modules must not be blocked by unknown-application
 * checks. Warnings inform; errors block.
 */
export class DialplanFileProvider extends ConfigurationProvider {

  #filename;

  /**
   * @param {PlatformDriver} driver    — injected platform driver
   * @param {string}         filename  — basename of the XML file (e.g. 'default.xml')
   */
  constructor(driver, filename) {
    super(driver);
    if (!filename || typeof filename !== 'string') {
      throw new Error('DialplanFileProvider: filename is required (e.g. "default.xml")');
    }
    this.#filename = filename;
  }

  // ── Identity ──────────────────────────────────────────────────────────────────

  get id() {
    // Strip .xml suffix for the provider ID.
    const base = this.#filename.endsWith('.xml')
      ? this.#filename.slice(0, -4)
      : this.#filename;
    return `dialplan:${base}`;
  }

  get name() {
    return `Dialplan — ${this.#filename}`;
  }

  get description() {
    return `FreeSWITCH dialplan context from ${this.#filename}`;
  }

  /** Hierarchical document — the frontend uses TreeRenderer, not ConfigPage. */
  get docType() { return 'hierarchical'; }

  get deploymentStrategy() { return DeploymentStrategies.RELOAD_XML; }

  get deploymentMeta() {
    return {
      action:               'reload_xml',
      actionLabel:          'Reload XML Configuration',
      description:
        `Writes ${this.#filename} and runs reloadxml. ` +
        'Active calls are not interrupted.',
      affectedServices:     ['FreeSWITCH Dialplan', 'mod_dialplan_xml'],
      restartRequired:      false,
      estimatedDowntime:    'None',
      riskLevel:            'low',
      requiresConfirmation: false,
    };
  }

  // ── Path ──────────────────────────────────────────────────────────────────────

  getFilePath() {
    return this.driver.resolveConfigurationPath('dialplan', this.#filename);
  }

  // ── Parse ─────────────────────────────────────────────────────────────────────

  /**
   * Parse raw XML into a DialplanDoc.
   *
   * Returns { contextName, contextAttrs, nodes, checksum, entries }
   * where entries = nodes is the compatibility adapter for ConfigurationManager.
   * The parser is unaware of entries — the adaptation is performed here only.
   *
   * @param {string} rawContent
   * @returns {DialplanDoc & { entries: Node[] }}
   */
  parse(rawContent) {
    const doc = dpParse(rawContent);
    return { ...doc, entries: doc.nodes };
  }

  // ── Serialize ─────────────────────────────────────────────────────────────────

  serialize(doc) {
    return dpSerialize(doc);
  }

  // ── Apply changes ─────────────────────────────────────────────────────────────

  /**
   * Apply ordered change operations to produce a new DialplanDoc.
   * Pure — does not mutate the input document.
   *
   * @param {DialplanDoc} doc
   * @param {ChangeOperation[]} ops
   * @returns {DialplanDoc & { entries: Node[] }}
   */
  applyChanges(doc, ops) {
    const newDoc = dpApplyChanges(doc, ops);
    return { ...newDoc, entries: newDoc.nodes };
  }

  // ── Validate ──────────────────────────────────────────────────────────────────

  /**
   * Validate a parsed DialplanDoc.
   *
   * See the validation contract in this file's header comment.
   * Errors block deployment. Warnings inform operators but do not block.
   *
   * @param {DialplanDoc & { entries: Node[] }} doc
   * @returns {{ valid: boolean, errors: string[], warnings: string[] }}
   */
  validate(doc) {
    const errors   = [];
    const warnings = [];

    // ── Structural errors ─────────────────────────────────────────────────────

    if (!doc || typeof doc.contextName !== 'string' || !doc.contextName) {
      errors.push('DialplanDoc is missing a valid contextName. The document cannot be deployed.');
      return { valid: false, errors, warnings };
    }

    if (!Array.isArray(doc.nodes)) {
      errors.push('DialplanDoc.nodes is not an array. The document structure is invalid.');
      return { valid: false, errors, warnings };
    }

    // ── Extension nodes ───────────────────────────────────────────────────────

    const extensions = doc.nodes.filter(n => n.type === 'extension');

    // Empty dialplan — warning only. An administrator may be building it.
    if (extensions.length === 0) {
      warnings.push(
        `Context '${doc.contextName}' contains no extensions. ` +
        'The dialplan will route no calls until at least one extension is added.'
      );
    }

    // Duplicate extension names — blocking error.
    const namesSeen = new Set();
    for (const ext of extensions) {
      const eName = ext.name ?? '';
      if (eName && namesSeen.has(eName)) {
        errors.push(
          `Duplicate extension name '${eName}' in context '${doc.contextName}'. ` +
          'FreeSWITCH matches the first extension with a given name — duplicates are unreachable.'
        );
      }
      namesSeen.add(eName);
    }

    // Disabled extensions — informational warning.
    const disabledCount = extensions.filter(e => e.enabled === false).length;
    if (disabledCount > 0) {
      warnings.push(
        `${disabledCount} extension(s) in context '${doc.contextName}' are disabled ` +
        '(XML-commented out) and will not route calls.'
      );
    }

    // ── Action and condition checks ───────────────────────────────────────────

    const knownApps    = new Set(knownApplicationNames());
    const knownFields  = new Set(knownFieldNames());

    for (const ext of extensions) {
      if (!Array.isArray(ext.conditions)) continue;

      for (const cond of ext.conditions) {

        // Unknown condition field — warning only. Custom variables are common.
        if (cond.field && !knownFields.has(cond.field)) {
          warnings.push(
            `Extension '${ext.name ?? ext.id}': condition field '${cond.field}' is not in ` +
            'the platform catalog. Custom channel variables are valid — verify the field name.'
          );
        }

        const allActions = [
          ...(Array.isArray(cond.actions)     ? cond.actions     : []),
          ...(Array.isArray(cond.antiActions) ? cond.antiActions : []),
        ];

        for (const action of allActions) {
          const appName = action.application ?? '';
          if (!appName) continue;

          if (!knownApps.has(appName)) {
            // Unknown application — warning only. Proprietary and custom modules are valid.
            warnings.push(
              `Extension '${ext.name ?? ext.id}': application '${appName}' is not in ` +
              'the platform catalog. Custom or third-party modules are valid — verify the name.'
            );
          } else {
            const meta = lookupApplication(appName);

            // High-risk application — warning to surface to the operator.
            if (meta.riskLevel === 'high') {
              warnings.push(
                `Extension '${ext.name ?? ext.id}': application '${appName}' is classified ` +
                `as high-risk. Verify the data argument before deploying.`
              );
            }

            // dataRequired but data is empty — warning only; may be intentional.
            if (meta.dataRequired && !action.data?.trim()) {
              warnings.push(
                `Extension '${ext.name ?? ext.id}': application '${appName}' expects a ` +
                'data argument but none is set.'
              );
            }
          }
        }
      }
    }

    return { valid: errors.length === 0, errors, warnings };
  }

  // ── Diff ──────────────────────────────────────────────────────────────────────

  diff(oldRaw, newRaw) {
    return dpDiff(oldRaw, newRaw);
  }

  // ── Accessors ─────────────────────────────────────────────────────────────────

  /** The XML filename this provider manages (e.g. 'default.xml'). */
  get filename() { return this.#filename; }
}
