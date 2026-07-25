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
  listNameFromKey,
  nodePartsFromKey,
} from '../parsers/AclParser.js';
import { lookupAclEntry } from '../catalogs/aclCatalog.js';

// Matches the closing tag for a <list> element (for orphan cleanup).
const RE_LIST_CLOSE_LINE = /^\s*<\/list\s*>/;

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
    // ── Step 1: expand list-delete changes ─────────────────────────────────────
    // Deleting a list must also delete all its child nodes. Without expansion,
    // only the list-header segment is removed and child nodes + </list> are left
    // orphaned, producing invalid XML.
    const expandedChanges = [];
    const listNamesToDelete = new Set();

    for (const change of changes) {
      expandedChanges.push(change);
      if (change.op === 'delete' && isListKey(change.key)) {
        const listName = listNameFromKey(change.key);
        listNamesToDelete.add(listName);
        // Queue deletes for every child node belonging to this list.
        for (const seg of doc.segments) {
          if (seg.type === 'entry' && seg._listName === listName && seg._aclType === 'node') {
            expandedChanges.push({ op: 'delete', key: seg.key });
          }
        }
      }
    }

    // ── Step 2: record orphan </list> indices before mutation ──────────────────
    // SegmentUtils.applyChanges returns an array of the same length (deletes set
    // type:'deleted', never splice-removes). We can safely use pre-mutation indices
    // for delete-only operations.
    const orphanCloseTagIndices = new Set();
    if (listNamesToDelete.size > 0) {
      let trackingList = null;
      doc.segments.forEach((seg, i) => {
        if (seg.type === 'entry' && seg._aclType === 'list') {
          trackingList = listNamesToDelete.has(seg._listName) ? seg._listName : null;
        }
        if (trackingList !== null &&
            seg.type === 'other' &&
            RE_LIST_CLOSE_LINE.test(seg.content)) {
          orphanCloseTagIndices.add(i);
          trackingList = null;
        }
      });
    }

    // ── Step 3: apply changes via SegmentUtils ──────────────────────────────────
    let newSegments = aclApplyChanges(doc.segments, doc.index, expandedChanges);

    // ── Step 4: remove orphaned </list> close-tags ──────────────────────────────
    if (orphanCloseTagIndices.size > 0) {
      newSegments = newSegments.map((seg, i) =>
        orphanCloseTagIndices.has(i) ? { type: 'deleted' } : seg
      );
    }

    // ── Step 5: inject ACL fields onto new segments ─────────────────────────────
    // SegmentUtils creates new segments as bare { type:'entry', key, value, enabled,
    // indent, original:null, modified:false } objects. Without _aclType/_listName/
    // _nodeAttr/_address, AclParser.serialize would silently drop them.
    // Infer the required fields from the key and any hints on the change object.
    const newKeyHints = new Map();
    for (const change of changes) {
      if (change.op === 'set' && !doc.index.has(change.key)) {
        if (isListKey(change.key)) {
          newKeyHints.set(change.key, {
            _aclType:  'list',
            _listName: listNameFromKey(change.key),
          });
        } else {
          const [listName, address] = nodePartsFromKey(change.key);
          newKeyHints.set(change.key, {
            _aclType:  'node',
            _listName: listName,
            _nodeAttr: change.nodeAttr ?? 'cidr',
            _address:  address,
          });
        }
      }
    }

    if (newKeyHints.size > 0) {
      newSegments = newSegments.map(seg =>
        seg.type === 'entry' && newKeyHints.has(seg.key)
          ? { ...seg, ...newKeyHints.get(seg.key) }
          : seg
      );
    }

    const newIndex   = buildIndex(newSegments);
    const newEntries = this._buildEntries(newSegments);
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
