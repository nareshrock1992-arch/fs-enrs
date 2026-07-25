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
import { lookupEslParam } from '../catalogs/eventSocketCatalog.js';
import { checkXmlAttributeValue } from '../xml/XmlAttributeUtil.js';

/**
 * EventSocketProvider — manages FreeSWITCH event_socket.conf.xml.
 *
 * event_socket.conf.xml configures mod_event_socket, the ESL listener that
 * ENRS depends on for all FreeSWITCH control-plane communication.
 *
 * Deployment strategy: RELOAD_XML.
 * Framework limitation: RELOAD_MODULE/RESTART_MODULE require moduleName in
 * context.strategyContext, but providers cannot inject strategyContext — it
 * comes from the HTTP request body. Until that gap is closed in a future
 * framework hardening pass, this provider uses RELOAD_XML (writes the file
 * and runs reloadxml). Params that require a mod_event_socket restart
 * (listen-ip, listen-port, password) are flagged restartRequired:true in the
 * catalog so the UI can surface the warning to the operator.
 *
 * Parser reuse: SwitchConfParser handles <param name="K" value="V"/> format —
 * the same format used by event_socket.conf.xml and switch.conf.xml.
 */
export class EventSocketProvider extends ConfigurationProvider {

  constructor(driver) {
    super(driver);
  }

  // ── Identity ──────────────────────────────────────────────────────────────────

  get id()          { return 'event-socket'; }
  get name()        { return 'Event Socket'; }
  get description() { return 'ESL listener settings — event_socket.conf.xml'; }

  get deploymentStrategy() { return DeploymentStrategies.RELOAD_XML; }

  get deploymentMeta() {
    return {
      action:               'reloadxml',
      actionLabel:          'Reload XML Configuration',
      description:
        'Writes event_socket.conf.xml and runs reloadxml. ' +
        'Changes to listen-ip, listen-port, and password require a ' +
        'mod_event_socket restart (unload + load) to take effect — reloadxml alone is insufficient for ESL params.',
      affectedServices:     ['mod_event_socket', 'ESL Connection', 'ENRS Backend'],
      restartRequired:      false,
      estimatedDowntime:    'None (file write + reloadxml). Manual mod_event_socket restart required for binding changes.',
      riskLevel:            'high',
      requiresConfirmation: false,
    };
  }

  // ── Path ──────────────────────────────────────────────────────────────────────

  getFilePath() {
    return this.driver.resolveConfigPath('autoload_configs/event_socket.conf.xml');
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
      ...lookupEslParam(key),
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
      ...lookupEslParam(key),
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

    const port = doc.entries?.find(e => e.key === 'listen-port' && e.enabled);
    if (port) {
      const n = parseInt(port.value, 10);
      if (isNaN(n) || n < 1 || n > 65535) {
        errors.push(
          `listen-port '${port.value}' is not a valid TCP port (must be 1–65535).`
        );
      }
    }

    const pwd = doc.entries?.find(e => e.key === 'password' && e.enabled);
    if (pwd && pwd.value === 'ClueCon') {
      warnings.push(
        "ESL password is set to the FreeSWITCH default 'ClueCon'. " +
        "Change this before deploying to a non-development environment."
      );
    }

    const listenIp = doc.entries?.find(e => e.key === 'listen-ip' && e.enabled);
    if (listenIp && (listenIp.value === '0.0.0.0' || listenIp.value === '::')) {
      warnings.push(
        `listen-ip is '${listenIp.value}' — ESL is exposed on all network interfaces ` +
        "(IPv4 and IPv6). Use 127.0.0.1 unless the ENRS backend runs on a separate host, " +
        "and ensure apply-inbound-acl is configured to restrict access."
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
