import { ConfigurationProvider } from '../ConfigurationProvider.js';
import { DeploymentStrategies }  from '../deploy/DeploymentStrategy.js';
import {
  parse as aclParse,
  serialize as aclSerialize,
  buildIndex,
  groupByKey,
  applyChanges as aclApplyChanges,
  toEntries,
  diffEntries,
  isListKey,
} from '../parsers/AclParser.js';
import { lookupAclEntry } from '../catalogs/aclCatalog.js';

/**
 * AclProvider — manages FreeSWITCH acl.conf.xml.
 *
 * acl.conf.xml defines named ACL profiles (network lists) that gate inbound
 * SIP and ESL connections.  Unlike switch.conf.xml and event_socket.conf.xml,
 * acl.conf.xml uses a nested list→node structure rather than flat
 * <param name="K" value="V"/> entries.
 *
 * The AclParser maps this structure onto the standard segment model:
 *   - List headers → entry segments with key '_list___${name}', value = default policy
 *   - Nodes        → entry segments with key '${listName}___${address}', value = policy
 *
 * This allows the unchanged SegmentUtils (buildIndex, applyChanges, groupByKey)
 * to handle all CRUD operations.  AclParser.serialize() regenerates the
 * correct XML from the extended _aclType/_listName/_nodeAttr/_address fields.
 *
 * Deployment strategy: RELOAD_XML.
 * FreeSWITCH re-reads acl.conf.xml on reloadxml and applies the new ACL rules
 * immediately.  No module restart is required.
 */
export class AclProvider extends ConfigurationProvider {

  constructor(driver) {
    super(driver);
  }

  // ── Identity ──────────────────────────────────────────────────────────────────

  get id()          { return 'acl'; }
  get name()        { return 'ACL Rules'; }
  get description() { return 'Network access control lists — acl.conf.xml'; }

  get deploymentStrategy() { return DeploymentStrategies.RELOAD_XML; }

  get deploymentMeta() {
    return {
      action:               'reloadxml',
      actionLabel:          'Reload XML Configuration',
      description:
        'Writes acl.conf.xml and runs reloadxml. ' +
        'FreeSWITCH applies the new ACL rules immediately — no module restart is required.',
      affectedServices:     ['FreeSWITCH ACL Engine', 'SIP Authentication', 'ESL Access'],
      restartRequired:      false,
      estimatedDowntime:    'None (ACL rules are hot-reloaded).',
      riskLevel:            'high',
      requiresConfirmation: false,
    };
  }

  // ── Path ──────────────────────────────────────────────────────────────────────

  getFilePath() {
    return this.driver.resolveConfigPath('autoload_configs/acl.conf.xml');
  }

  // ── Parse ─────────────────────────────────────────────────────────────────────

  /**
   * @param {string} rawContent
   * @returns {{ segments, index, entries, checksum }}
   */
  parse(rawContent) {
    const { segments, checksum } = aclParse(rawContent);
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
    return aclSerialize(doc.segments);
  }

  // ── Apply changes ─────────────────────────────────────────────────────────────

  /**
   * @param {{ segments, index }} doc
   * @param {Array} changes
   * @returns {{ segments, index, entries, checksum: null }}
   */
  applyChanges(doc, changes) {
    const newSegments = aclApplyChanges(doc.segments, doc.index, changes);
    const newIndex    = buildIndex(newSegments);
    const newEntries  = this._buildEntries(newSegments);
    return { segments: newSegments, index: newIndex, entries: newEntries, checksum: null };
  }

  // ── Validate ──────────────────────────────────────────────────────────────────

  validate(doc) {
    const errors   = [];
    const warnings = [];
    const VALID_POLICIES = new Set(['allow', 'deny']);

    for (const entry of doc.entries ?? []) {
      if (!entry.key) {
        errors.push('Found an ACL entry with an empty or invalid key.');
        continue;
      }

      // Validate policy values (both list defaults and node policies).
      if (entry.value && !VALID_POLICIES.has(entry.value)) {
        errors.push(
          `"${entry.key}" has invalid policy value '${entry.value}'. ` +
          `Must be 'allow' or 'deny'.`
        );
      }

      // Validate CIDR notation for node entries.
      if (entry._nodeAttr === 'cidr' && entry.value && entry._address) {
        if (!isValidCidr(entry._address)) {
          errors.push(
            `Node "${entry._address}" in "${entry._listName}" is not a valid CIDR ` +
            `(expected format: x.x.x.x/n or ::x/n).`
          );
        }
      }
    }

    // Warn if a permissive list (default=allow) has no deny nodes — likely unintentional.
    const listEntries = (doc.entries ?? []).filter(e => isListKey(e.key) && e.enabled);
    for (const listEntry of listEntries) {
      if (listEntry.value !== 'allow') continue;
      const listName  = listEntry._listName;
      const denyNodes = (doc.entries ?? []).filter(
        e => e._listName === listName && e._aclType === 'node' && e.value === 'deny' && e.enabled
      );
      if (denyNodes.length === 0) {
        warnings.push(
          `ACL list "${listName}" has default policy 'allow' but no active deny nodes. ` +
          `All connections will be permitted unless deny nodes are added.`
        );
      }
    }

    return { valid: errors.length === 0, errors, warnings };
  }

  // ── Diff ──────────────────────────────────────────────────────────────────────

  diff(oldRaw, newRaw) {
    const { segments: oldSeg } = aclParse(oldRaw);
    const { segments: newSeg } = aclParse(newRaw);
    return diffEntries(toEntries(oldSeg), toEntries(newSeg)) || '(no ACL changes)';
  }

  // ── Private ───────────────────────────────────────────────────────────────────

  _buildEntries(segments) {
    return groupByKey(segments).map(({ key, primary, alternatives }) => {
      const ctx = primary._nodeAttr ? { nodeAttr: primary._nodeAttr } : {};
      return {
        key,
        value:        primary.value,
        enabled:      primary.enabled,
        definitionId: primary.definitionId,
        _aclType:     primary._aclType,
        _listName:    primary._listName,
        _nodeAttr:    primary._nodeAttr,
        _address:     primary._address,
        ...lookupAclEntry(key, ctx),
        alternatives: alternatives.map(alt => ({
          value:        alt.value,
          enabled:      alt.enabled,
          definitionId: alt.definitionId,
          disabledHint: 'XML comment',
        })),
      };
    });
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Returns true if the address is a plausible CIDR string (IPv4 or IPv6).
 * Intentionally lenient — the goal is to catch obvious mistakes, not to
 * validate every edge case of RFC 4291.
 */
function isValidCidr(address) {
  // Allow FreeSWITCH variable expressions like $${local_ip_v4}/32.
  if (address.startsWith('$')) return true;

  const slashPos = address.lastIndexOf('/');
  if (slashPos === -1) return false;

  const ip     = address.slice(0, slashPos);
  const prefix = address.slice(slashPos + 1);
  const prefixN = parseInt(prefix, 10);

  if (isNaN(prefixN) || prefixN < 0) return false;

  // IPv4
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(ip)) {
    return prefixN <= 32 && ip.split('.').every(o => parseInt(o) <= 255);
  }
  // IPv6 — colon present
  if (ip.includes(':')) {
    return prefixN <= 128;
  }
  return false;
}
