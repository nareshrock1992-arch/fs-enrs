import path from 'path';
import { ConfigurationProvider } from '../ConfigurationProvider.js';
import { DeploymentStrategies } from '../deploy/DeploymentStrategy.js';
import {
  parse as vpParse,
  buildIndex,
  applyChanges as vpApplyChanges,
  serialize as vpSerialize,
  toEntries,
  diffEntries,
} from '../parsers/VarsParser.js';
import { varsCatalog, lookupVar } from '../catalogs/varsCatalog.js';
import { checkXmlAttributeValue }  from '../xml/XmlAttributeUtil.js';

/**
 * VarsProvider — manages FreeSWITCH vars.xml (System Variables).
 *
 * vars.xml contains X-PRE-PROCESS directives that set global FreeSWITCH
 * variables. Both active and commented-out variables are surfaced in the UI.
 *
 * Internal document shape (returned by parse(), passed to serialize()):
 *   { segments: Segment[], index: Map<key → segIdx>, entries: ConfigEntry[], checksum }
 *
 * No FreeSWITCH-specific path is hardcoded here. The file path is resolved
 * via the injected driver which delegates to freeSwitchPathService.
 */
export class VarsProvider extends ConfigurationProvider {

  constructor(driver) {
    super(driver);
  }

  // ── Identity ──────────────────────────────────────────────────────────────────

  get id()          { return 'vars'; }
  get name()        { return 'System Variables'; }
  get description() { return 'Global FreeSWITCH variables — vars.xml'; }

  get deploymentStrategy() { return DeploymentStrategies.RELOAD_XML; }

  get deploymentMeta() {
    return {
      action:               'reloadxml',
      actionLabel:          'Reload XML Configuration',
      description:          'Reloads all FreeSWITCH XML configuration files. Active calls are not interrupted.',
      affectedServices:     ['FreeSWITCH XML Parser', 'Global Variables'],
      restartRequired:      false,
      estimatedDowntime:    'None',
      riskLevel:            'low',
      requiresConfirmation: false,
    };
  }

  get catalog() { return varsCatalog; }

  // ── Path ──────────────────────────────────────────────────────────────────────

  getFilePath() {
    return this.driver.resolveConfigPath('vars.xml');
  }

  // ── Parse ─────────────────────────────────────────────────────────────────────

  /**
   * @param {string} rawContent
   * @returns {{ segments, index, entries, checksum }}
   */
  parse(rawContent) {
    const { segments, checksum } = vpParse(rawContent);
    const index   = buildIndex(segments);
    const entries = toEntries(segments).map(e => ({
      ...e,
      ...lookupVar(e.key),
    }));
    return { segments, index, entries, checksum };
  }

  // ── Serialize ─────────────────────────────────────────────────────────────────

  /**
   * @param {{ segments }} doc
   * @returns {string}
   */
  serialize(doc) {
    return vpSerialize(doc.segments);
  }

  // ── Apply changes ─────────────────────────────────────────────────────────────

  /**
   * @param {{ segments, index }} doc
   * @param {Array} changes   — [{ op, key, value?, enabled? }]
   * @returns {{ segments, index, entries, checksum: null }}
   */
  applyChanges(doc, changes) {
    const newSegments = vpApplyChanges(doc.segments, doc.index, changes);
    const newIndex    = buildIndex(newSegments);
    const newEntries  = toEntries(newSegments).map(e => ({
      ...e,
      ...lookupVar(e.key),
    }));
    return { segments: newSegments, index: newIndex, entries: newEntries, checksum: null };
  }

  // ── Validate ──────────────────────────────────────────────────────────────────

  validate(doc) {
    const errors   = [];
    const warnings = [];

    for (const entry of doc.entries ?? []) {
      if (!entry.key || typeof entry.key !== 'string') {
        errors.push('Found a variable with an empty or invalid key.');
        continue;
      }

      const keyCheck = checkXmlAttributeValue(entry.key);
      if (!keyCheck.valid) {
        errors.push(`Variable key '${entry.key}' ${keyCheck.reason}.`);
      }

      if (entry.value) {
        const valCheck = checkXmlAttributeValue(entry.value);
        if (!valCheck.valid) {
          errors.push(`Variable '${entry.key}' value ${valCheck.reason}.`);
        }
      }
    }

    // Warn if default_password looks like the known-weak default.
    const pwEntry = doc.entries?.find(e => e.key === 'default_password');
    if (pwEntry?.enabled && pwEntry.value === '1234') {
      warnings.push("default_password is set to '1234' — change this before production.");
    }

    return { valid: errors.length === 0, errors, warnings };
  }

  // ── Diff ──────────────────────────────────────────────────────────────────────

  diff(oldRaw, newRaw) {
    const { segments: oldSeg } = vpParse(oldRaw);
    const { segments: newSeg } = vpParse(newRaw);
    const oldEntries = toEntries(oldSeg);
    const newEntries = toEntries(newSeg);
    return diffEntries(oldEntries, newEntries) || '(no variable changes)';
  }

  // ── Verification ──────────────────────────────────────────────────────────────

  async verifyDeployment(driver, changes) {
    const checks = [];
    let passed = true;

    // Spot-check: verify that the first 'set' change is visible via global_getvar.
    const setChange = changes?.find(c => c.op === 'set' && c.enabled !== false);
    if (setChange) {
      const actual = await driver.getGlobalVar(setChange.key);
      const ok = actual !== null;
      if (!ok) passed = false;
      checks.push({
        key:      setChange.key,
        expected: setChange.value,
        actual:   actual ?? '(not found)',
        passed:   ok,
      });
    }

    return { passed, checks };
  }
}
