/**
 * acl.conf.xml entry catalog.
 *
 * acl.conf.xml defines ACL profiles used by FreeSWITCH to gate inbound
 * SIP connections, ESL connections (via apply-inbound-acl in event_socket.conf.xml),
 * and directory authentication (the "domains" list).
 *
 * Unlike param-based catalogs, ACL entries are dynamic — the specific list
 * names and node addresses come from the file itself.  This catalog provides
 * metadata templates that lookupAclEntry() uses to synthesise a complete
 * ConfigurationEntry for any list-header or node key.
 */
import { applyMetaDefaults }              from '../metadata/metadataSchema.js';
import { isListKey, listNameFromKey,
         nodePartsFromKey }               from '../parsers/AclParser.js';

// ── Metadata templates ────────────────────────────────────────────────────────

const LIST_TEMPLATE = {
  category:         'ACL Lists',
  group:            'Network Lists',
  type:             'enum',
  visibility:       'basic',
  riskLevel:        'medium',
  restartRequired:  false,
  affectedServices: ['FreeSWITCH ACL', 'SIP Authentication', 'ESL Access'],
  validation: {
    allowedValues: ['allow', 'deny'],
  },
  aliases: ['acl default', 'default policy', 'network list'],
};

const NODE_CIDR_TEMPLATE = {
  group:            'Nodes',
  type:             'enum',
  visibility:       'basic',
  riskLevel:        'medium',
  restartRequired:  false,
  affectedServices: ['FreeSWITCH ACL'],
  validation: {
    allowedValues: ['allow', 'deny'],
  },
  aliases: ['cidr', 'ip range', 'subnet', 'network'],
};

const NODE_DOMAIN_TEMPLATE = {
  group:            'Nodes',
  type:             'enum',
  visibility:       'basic',
  riskLevel:        'medium',
  restartRequired:  false,
  affectedServices: ['FreeSWITCH ACL', 'SIP Directory Authentication'],
  validation: {
    allowedValues: ['allow', 'deny'],
  },
  aliases: ['domain', 'directory', 'sip domain'],
};

// ── Lookup ────────────────────────────────────────────────────────────────────

/**
 * Return a complete ConfigurationEntry for an acl.conf.xml entry.
 *
 * Keys follow two patterns:
 *   '_list___${listName}'        — list-header entry
 *   '${listName}___${address}'  — node entry (cidr or domain)
 *
 * @param {string} key
 * @param {{ nodeAttr?: 'cidr'|'domain' }} [ctx]
 * @returns {object} ConfigurationEntry fields + { metadata }
 */
export function lookupAclEntry(key, ctx = {}) {
  if (isListKey(key)) {
    const listName = listNameFromKey(key);
    const meta = applyMetaDefaults({
      ...LIST_TEMPLATE,
      label:            listName,
      description:      `Default access policy for the "${listName}" ACL profile.`,
      purpose:
        `Controls whether connections not matched by any node rule are allowed or denied. ` +
        `"allow" makes the list permissive (deny specific ranges); ` +
        `"deny" makes it restrictive (allow specific ranges).`,
      notes:
        `Changing the default policy affects all unmatched connections through this ACL profile. ` +
        `Run reloadxml for the change to take effect.`,
      example:          'deny',
      defaultValue:     'deny',
      recommendedValue: 'deny',
    });
    return { ...meta, metadata: meta };
  }

  const [listName, address] = nodePartsFromKey(key);
  const nodeAttr = ctx.nodeAttr ?? (address.includes('/') ? 'cidr' : 'domain');
  const isDomain = nodeAttr === 'domain';

  const template = isDomain ? NODE_DOMAIN_TEMPLATE : NODE_CIDR_TEMPLATE;
  const meta = applyMetaDefaults({
    ...template,
    category:         listName,
    label:            address,
    description:      `${isDomain ? 'Domain' : 'CIDR'} node in the "${listName}" ACL: ${address}`,
    purpose:
      isDomain
        ? `When a connecting party's domain matches "${address}", apply the specified ` +
          `policy (allow/deny). The domain= form is used to permit all users in a SIP ` +
          `directory to bypass digest authentication.`
        : `When a connecting IP address falls within "${address}", apply the specified ` +
          `policy (allow/deny). Node rules are evaluated in file order; the first ` +
          `match wins. Unmatched connections fall back to the list default policy.`,
    notes:
      `To change which policy applies, edit the value field (allow/deny). ` +
      `To remove this node, use the delete operation. ` +
      `Run reloadxml for changes to take effect.`,
    example:          'allow',
    defaultValue:     'allow',
    recommendedValue: 'allow',
  });
  return { ...meta, metadata: meta };
}
