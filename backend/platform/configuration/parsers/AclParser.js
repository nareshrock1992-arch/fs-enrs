import crypto from 'crypto';
import {
  buildIndex,
  buildGroupMap,
  groupByKey,
  applyChanges,
  toEntries,
  diffEntries,
} from './SegmentUtils.js';

// Re-export so AclProvider can import everything from one place.
export { buildIndex, buildGroupMap, groupByKey, applyChanges, toEntries, diffEntries };

/**
 * AclParser — parses and serialises FreeSWITCH acl.conf.xml.
 *
 * acl.conf.xml has a nested list→node structure, not the flat
 * <param name="K" value="V"/> format used by switch.conf.xml and
 * event_socket.conf.xml.  The segment model is extended with _aclType,
 * _listName, _nodeAttr, and _address fields to carry the structural
 * information needed for lossless serialisation.
 *
 * Segment model:
 *   { type: 'entry', key, value, enabled, indent, original, modified,
 *     _aclType: 'list', _listName }
 *     key   = '_list___${listName}'
 *     value = default policy ('allow' | 'deny')
 *
 *   { type: 'entry', key, value, enabled, indent, original, modified,
 *     _aclType: 'node', _listName, _nodeAttr, _address }
 *     key      = '${listName}___${address}'
 *     value    = node policy ('allow' | 'deny')
 *     _nodeAttr = 'cidr' | 'domain'
 *     _address  = cidr or domain string
 *
 *   { type: 'other', content }   — preserved verbatim
 *   { type: 'deleted' }          — produced by applyChanges
 *
 * Key separator '___' (triple underscore) does not appear in list names,
 * CIDR strings, domain names, or FreeSWITCH variable expressions.
 *
 * Disabled nodes are wrapped in XML comments.  Two forms are recognised:
 *   <!--<node .../>-->          canonical (no spaces)
 *   <!-- <node .../> -->        FreeSWITCH default (spaces inside markers)
 * Unmodified disabled entries are round-tripped verbatim via `original`.
 * Modified or newly-disabled entries regenerate in canonical (no-space) form.
 *
 * Auto-generated ACLs (rfc1918.auto, nat.auto, localnet.auto, loopback.auto)
 * are FreeSWITCH runtime constructs — they are NOT present in acl.conf.xml
 * and are never surfaced by this parser.
 */

// ── Regexes ───────────────────────────────────────────────────────────────────

// <list name="NAME" default="POLICY">
const RE_LIST_OPEN = /^(\s*)<list\s+name="([^"]+)"\s+default="([^"]+)"\s*>/;

// </list>
const RE_LIST_CLOSE = /^(\s*)<\/list\s*>/;

// <node type="POLICY" cidr="CIDR"/>
const RE_NODE_CIDR   = /^(\s*)<node\s+type="([^"]+)"\s+cidr="([^"]+)"\s*\/>/;

// <node type="POLICY" domain="DOMAIN"/>
const RE_NODE_DOMAIN = /^(\s*)<node\s+type="([^"]+)"\s+domain="([^"]+)"\s*\/>/;

// <!--<node type="POLICY" cidr="CIDR"/>-->  (optional spaces inside markers)
const RE_DIS_NODE_CIDR   = /^(\s*)<!--\s*<node\s+type="([^"]+)"\s+cidr="([^"]+)"\s*\/>\s*-->/;

// <!--<node type="POLICY" domain="DOMAIN"/>-->  (optional spaces inside markers)
const RE_DIS_NODE_DOMAIN = /^(\s*)<!--\s*<node\s+type="([^"]+)"\s+domain="([^"]+)"\s*\/>\s*-->/;

// ── Key helpers ───────────────────────────────────────────────────────────────

const SEP = '___';

/** Compound key for a node entry: 'listName___address'. */
export function nodeKey(listName, address) {
  return `${listName}${SEP}${address}`;
}

/** Key for a list-header entry: '_list___listName'. */
export function listKey(listName) {
  return `_list${SEP}${listName}`;
}

/** Extract list name from a list-header key. */
export function listNameFromKey(key) {
  return key.slice(`_list${SEP}`.length);
}

/** Extract [listName, address] from a node key. */
export function nodePartsFromKey(key) {
  const idx = key.indexOf(SEP);
  return [key.slice(0, idx), key.slice(idx + SEP.length)];
}

/** Returns true if key is a list-header key. */
export function isListKey(key) {
  return key.startsWith(`_list${SEP}`);
}

// ── Parse ─────────────────────────────────────────────────────────────────────

/**
 * @param {string} rawContent
 * @returns {{ segments: Array, checksum: string }}
 */
export function parse(rawContent) {
  const lines    = rawContent.split('\n');
  const segments = [];
  let   inBlock  = false;
  let   currentList = null; // name of the <list> we are currently inside

  for (let i = 0; i < lines.length; i++) {
    const line    = lines[i];
    const trimmed = line.trim();

    // ── Inside a multi-line block comment ────────────────────────────────────
    if (inBlock) {
      if (trimmed.endsWith('-->')) inBlock = false;
      segments.push({ type: 'other', content: line });
      continue;
    }

    // ── Multi-line block comment start (does not close on the same line) ─────
    if (trimmed.startsWith('<!--') && !trimmed.endsWith('-->')) {
      inBlock = true;
      segments.push({ type: 'other', content: line });
      continue;
    }

    // ── </list> — closes the current list scope ───────────────────────────────
    if (RE_LIST_CLOSE.test(line)) {
      currentList = null;
      segments.push({ type: 'other', content: line });
      continue;
    }

    // ── <list name="..." default="..."> ───────────────────────────────────────
    const listMatch = RE_LIST_OPEN.exec(line);
    if (listMatch) {
      const name          = listMatch[2];
      const defaultPolicy = listMatch[3];
      currentList = name;
      segments.push({
        type:      'entry',
        key:       listKey(name),
        value:     defaultPolicy,
        enabled:   true,
        indent:    listMatch[1],
        original:  line,
        modified:  false,
        _aclType:  'list',
        _listName: name,
      });
      continue;
    }

    // ── Node lines (only recognised inside a <list> block) ───────────────────
    if (currentList !== null) {
      // Active cidr node
      const nodeCidrMatch = RE_NODE_CIDR.exec(line);
      if (nodeCidrMatch) {
        const address = nodeCidrMatch[3];
        segments.push({
          type:      'entry',
          key:       nodeKey(currentList, address),
          value:     nodeCidrMatch[2],
          enabled:   true,
          indent:    nodeCidrMatch[1],
          original:  line,
          modified:  false,
          _aclType:  'node',
          _listName: currentList,
          _nodeAttr: 'cidr',
          _address:  address,
        });
        continue;
      }

      // Active domain node
      const nodeDomainMatch = RE_NODE_DOMAIN.exec(line);
      if (nodeDomainMatch) {
        const address = nodeDomainMatch[3];
        segments.push({
          type:      'entry',
          key:       nodeKey(currentList, address),
          value:     nodeDomainMatch[2],
          enabled:   true,
          indent:    nodeDomainMatch[1],
          original:  line,
          modified:  false,
          _aclType:  'node',
          _listName: currentList,
          _nodeAttr: 'domain',
          _address:  address,
        });
        continue;
      }

      // Disabled cidr node
      const disCidrMatch = RE_DIS_NODE_CIDR.exec(line);
      if (disCidrMatch) {
        const address = disCidrMatch[3];
        segments.push({
          type:      'entry',
          key:       nodeKey(currentList, address),
          value:     disCidrMatch[2],
          enabled:   false,
          indent:    disCidrMatch[1],
          original:  line,
          modified:  false,
          _aclType:  'node',
          _listName: currentList,
          _nodeAttr: 'cidr',
          _address:  address,
        });
        continue;
      }

      // Disabled domain node
      const disDomainMatch = RE_DIS_NODE_DOMAIN.exec(line);
      if (disDomainMatch) {
        const address = disDomainMatch[3];
        segments.push({
          type:      'entry',
          key:       nodeKey(currentList, address),
          value:     disDomainMatch[2],
          enabled:   false,
          indent:    disDomainMatch[1],
          original:  line,
          modified:  false,
          _aclType:  'node',
          _listName: currentList,
          _nodeAttr: 'domain',
          _address:  address,
        });
        continue;
      }
    }

    segments.push({ type: 'other', content: line });
  }

  return { segments, checksum: sha256(rawContent) };
}

// ── Serialize ─────────────────────────────────────────────────────────────────

/**
 * Serialise segments back to the original XML string.
 * Entry segments are regenerated; other segments are output verbatim;
 * deleted segments are skipped.
 *
 * @param {Array} segments
 * @returns {string}
 */
export function serialize(segments) {
  const lines = [];

  for (const seg of segments) {
    if (seg.type === 'deleted') continue;

    if (seg.type === 'other') {
      lines.push(seg.content);
      continue;
    }

    // type === 'entry'
    const indent = seg.indent != null ? seg.indent : '    ';

    if (seg._aclType === 'list') {
      // List headers are always output as active (no disable convention for lists).
      lines.push(`${indent}<list name="${seg._listName}" default="${seg.value}">`);
      continue;
    }

    if (seg._aclType === 'node') {
      const attr    = seg._nodeAttr ?? 'cidr';
      const address = seg._address  ?? seg.key.slice(seg.key.indexOf(SEP) + SEP.length);
      const nodeXml = `<node type="${seg.value}" ${attr}="${address}"/>`;

      if (seg.enabled) {
        lines.push(`${indent}${nodeXml}`);
      } else if (!seg.modified && seg.original != null) {
        // Unmodified disabled entry: round-trip verbatim to preserve original spacing.
        lines.push(seg.original);
      } else {
        // Canonical disabled form (no spaces inside comment markers).
        lines.push(`${indent}<!--${nodeXml}-->`);
      }
      continue;
    }

    // Unknown _aclType — preserve original if available, otherwise skip.
    if (seg.original != null) lines.push(seg.original);
  }

  return lines.join('\n');
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function sha256(str) {
  return crypto.createHash('sha256').update(str, 'utf8').digest('hex');
}
