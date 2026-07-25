import { ConfigurationProvider } from '../ConfigurationProvider.js';
import { DeploymentStrategies } from '../deploy/DeploymentStrategy.js';
import {
  parse as scParse,
  serialize as scSerialize,
  buildIndex,
  groupByKey,
  applyChanges as scApplyChanges,
  toEntries,
  diffEntries,
} from '../parsers/SwitchConfParser.js';
import { lookupParam } from '../catalogs/switchCatalog.js';
import { checkXmlAttributeValue } from '../xml/XmlAttributeUtil.js';

/**
 * SwitchCoreProvider — manages FreeSWITCH switch.conf.xml (Core Switch Settings).
 *
 * switch.conf.xml lives in autoload_configs/ and controls core switch behaviour:
 * RTP port ranges, session caps, timeouts, loglevel, DTMF, and ESL heartbeat.
 *
 * Deployment strategy: RELOAD_XML.
 * Note: params rtp-start-port, rtp-end-port, and rtp-ip require a FreeSWITCH
 * process restart to take effect. The catalog flags these with restartRequired.
 */
export class SwitchCoreProvider extends ConfigurationProvider {

  constructor(driver) {
    super(driver);
  }

  // ── Identity ──────────────────────────────────────────────────────────────────

  get id()          { return 'switch-core'; }
  get name()        { return 'Switch Core'; }
  get description() { return 'Core FreeSWITCH settings — switch.conf.xml'; }

  get deploymentStrategy() { return DeploymentStrategies.RELOAD_XML; }

  get deploymentMeta() {
    return {
      action:               'reloadxml',
      actionLabel:          'Reload XML Configuration',
      description:          'Applies switch.conf.xml changes via reloadxml. RTP port range and rtp-ip changes require a FreeSWITCH process restart.',
      affectedServices:     ['FreeSWITCH Core', 'RTP Media Engine', 'ESL'],
      restartRequired:      false,
      estimatedDowntime:    'None (most params). Brief restart required for RTP port / IP changes.',
      riskLevel:            'medium',
      requiresConfirmation: false,
    };
  }

  // ── Path ──────────────────────────────────────────────────────────────────────

  getFilePath() {
    return this.driver.resolveConfigPath('autoload_configs/switch.conf.xml');
  }

  // ── Parse ─────────────────────────────────────────────────────────────────────

  /**
   * @param {string} rawContent
   * @returns {{ segments, index, entries, checksum }}
   */
  parse(rawContent) {
    const { segments, checksum } = scParse(rawContent);
    const index   = buildIndex(segments);
    const entries = groupByKey(segments).map(({ key, primary, alternatives }) => ({
      key,
      value:        primary.value,
      enabled:      primary.enabled,
      definitionId: primary.definitionId,
      ...lookupParam(key),
      alternatives: alternatives.map(alt => ({
        value:        alt.value,
        enabled:      alt.enabled,
        definitionId: alt.definitionId,
        disabledHint: 'XML comment',
      })),
    }));
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
    const newEntries  = groupByKey(newSegments).map(({ key, primary, alternatives }) => ({
      key,
      value:        primary.value,
      enabled:      primary.enabled,
      definitionId: primary.definitionId,
      ...lookupParam(key),
      alternatives: alternatives.map(alt => ({
        value:        alt.value,
        enabled:      alt.enabled,
        definitionId: alt.definitionId,
        disabledHint: 'XML comment',
      })),
    }));
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

      if (entry.value) {
        const valCheck = checkXmlAttributeValue(entry.value);
        if (!valCheck.valid) {
          errors.push(`Parameter '${entry.key}' value ${valCheck.reason}.`);
        }
      }
    }

    // Validate RTP port range coherence.
    const rtpStart = doc.entries?.find(e => e.key === 'rtp-start-port' && e.enabled);
    const rtpEnd   = doc.entries?.find(e => e.key === 'rtp-end-port'   && e.enabled);
    if (rtpStart && rtpEnd) {
      const start = parseInt(rtpStart.value, 10);
      const end   = parseInt(rtpEnd.value,   10);
      if (!isNaN(start) && !isNaN(end) && end <= start) {
        errors.push(
          `rtp-end-port (${end}) must be greater than rtp-start-port (${start}).`
        );
      }
      const range = end - start;
      if (!isNaN(range) && range < 100) {
        warnings.push(
          `RTP port range is very narrow (${range} ports). A minimum of 200 ports is recommended.`
        );
      }
    }

    // Warn if sip-trace is enabled (security risk in production).
    const sipTrace = doc.entries?.find(e => e.key === 'sip-trace' && e.enabled);
    if (sipTrace && (sipTrace.value === 'true' || sipTrace.value === 'yes')) {
      warnings.push(
        "sip-trace is enabled — SIP packets (including credentials) will appear in logs. Disable before production."
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
}
