import { ConfigurationProvider } from '../ConfigurationProvider.js';
import { DeploymentStrategies }  from '../deploy/DeploymentStrategy.js';
import {
  parse as scParse,
  serialize as scSerialize,
  buildIndex,
  groupByKey,
  applyChanges as scApplyChanges,
  toEntries,
  diffEntries,
} from '../parsers/SwitchConfParser.js';
import { lookupSofiaParam } from '../catalogs/sofiaCatalog.js';

/**
 * SofiaProvider — manages FreeSWITCH sofia.conf.xml (global_settings section).
 *
 * sofia.conf.xml controls mod_sofia, the FreeSWITCH SIP endpoint module.
 * This provider manages the <global_settings> section only.  The <profiles>
 * section contains a single X-PRE-PROCESS include directive that points to
 * individual sip_profiles/*.xml files — these will be managed through
 * separate profile providers when those files are available.
 *
 * The <global_settings> section uses the identical <param name="K" value="V"/>
 * format as switch.conf.xml and event_socket.conf.xml, so SwitchConfParser
 * can be reused without modification.
 *
 * Deployment strategy: RELOAD_XML.
 * After reloadxml, a 'sofia reload' may be needed for certain params; params
 * that require a full mod_sofia reload are flagged in the catalog.
 */
export class SofiaProvider extends ConfigurationProvider {

  constructor(driver) {
    super(driver);
  }

  // ── Identity ──────────────────────────────────────────────────────────────────

  get id()          { return 'sip-profiles'; }
  get name()        { return 'SIP Global Settings'; }
  get description() { return 'mod_sofia global settings — sofia.conf.xml'; }

  get deploymentStrategy() { return DeploymentStrategies.RELOAD_XML; }

  get deploymentMeta() {
    return {
      action:               'reloadxml',
      actionLabel:          'Reload XML Configuration',
      description:
        'Writes sofia.conf.xml and runs reloadxml. ' +
        'Most global_settings params take effect after a mod_sofia reload ' +
        '(sofia reload in fs_cli). Params marked restartRequired need a ' +
        'FreeSWITCH restart to take effect.',
      affectedServices:     ['mod_sofia', 'SIP Profiles', 'SIP Signalling'],
      restartRequired:      false,
      estimatedDowntime:    'None for log/debug params. mod_sofia reload needed for most; full restart for startup params.',
      riskLevel:            'medium',
      requiresConfirmation: false,
    };
  }

  // ── Path ──────────────────────────────────────────────────────────────────────

  getFilePath() {
    return this.driver.resolveConfigPath('autoload_configs/sofia.conf.xml');
  }

  // ── Parse ─────────────────────────────────────────────────────────────────────

  /**
   * @param {string} rawContent
   * @returns {{ segments, index, entries, checksum }}
   */
  parse(rawContent) {
    const { segments, checksum } = scParse(rawContent);
    const index   = buildIndex(segments);
    const entries = this._buildEntries(segments);
    return { segments, index, entries, checksum };
  }

  // ── Serialize ─────────────────────────────────────────────────────────────────

  /**
   * @param {{ segments }} doc
   * @returns {string}
   */
  serialize(doc) {
    return scSerialize(doc.segments);
  }

  // ── Apply changes ─────────────────────────────────────────────────────────────

  /**
   * @param {{ segments, index }} doc
   * @param {Array} changes
   * @returns {{ segments, index, entries, checksum: null }}
   */
  applyChanges(doc, changes) {
    const newSegments = scApplyChanges(doc.segments, doc.index, changes);
    const newIndex    = buildIndex(newSegments);
    const newEntries  = this._buildEntries(newSegments);
    return { segments: newSegments, index: newIndex, entries: newEntries, checksum: null };
  }

  // ── Validate ──────────────────────────────────────────────────────────────────

  validate(doc) {
    const errors   = [];
    const warnings = [];

    for (const entry of doc.entries ?? []) {
      if (!entry.key || typeof entry.key !== 'string') {
        errors.push('Found a parameter with an empty or invalid name.');
        continue;
      }
    }

    // log-level and debug-presence must be integers in [0, 9].
    for (const param of ['log-level', 'debug-presence']) {
      const entry = doc.entries?.find(e => e.key === param && e.enabled);
      if (entry && entry.value !== undefined && entry.value !== '') {
        const n = parseInt(entry.value, 10);
        if (isNaN(n) || n < 0 || n > 9) {
          errors.push(
            `'${param}' value '${entry.value}' is not valid — must be an integer from 0 to 9.`
          );
        }
      }
    }

    // Warn when capture-server is active — it adds latency to every SIP transaction.
    const captureServer = doc.entries?.find(e => e.key === 'capture-server' && e.enabled);
    if (captureServer && captureServer.value) {
      warnings.push(
        `capture-server is active ('${captureServer.value}'). ` +
        'HEP capture adds a network hop to every SIP transaction. ' +
        'Disable when not actively troubleshooting.'
      );
    }

    return { valid: errors.length === 0, errors, warnings };
  }

  // ── Diff ──────────────────────────────────────────────────────────────────────

  diff(oldRaw, newRaw) {
    const { segments: oldSeg } = scParse(oldRaw);
    const { segments: newSeg } = scParse(newRaw);
    return diffEntries(toEntries(oldSeg), toEntries(newSeg)) || '(no parameter changes)';
  }

  // ── Private ───────────────────────────────────────────────────────────────────

  _buildEntries(segments) {
    return groupByKey(segments).map(({ key, primary, alternatives }) => ({
      key,
      value:        primary.value,
      enabled:      primary.enabled,
      definitionId: primary.definitionId,
      ...lookupSofiaParam(key),
      alternatives: alternatives.map(alt => ({
        value:        alt.value,
        enabled:      alt.enabled,
        definitionId: alt.definitionId,
        disabledHint: 'XML comment',
      })),
    }));
  }
}
