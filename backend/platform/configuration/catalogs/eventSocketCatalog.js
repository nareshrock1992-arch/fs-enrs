/**
 * event_socket.conf.xml parameter catalog.
 *
 * event_socket.conf.xml configures mod_event_socket — the ESL listener that
 * ENRS uses for all FreeSWITCH control plane communication (call origination,
 * event subscription, global variable reads). Every ENRS backend operation
 * that touches a call flows through the ESL connection defined here.
 *
 * Security note: listen-ip, listen-port, and password directly control access
 * to the FreeSWITCH control plane. Changes require a mod_event_socket restart
 * (unload + load) to take effect — reloadxml alone is insufficient.
 */
import { applyMetaDefaults } from '../metadata/metadataSchema.js';

export const eventSocketCatalog = {

  // ── Connection › Binding ─────────────────────────────────────────────────

  'listen-ip': {
    category:    'Connection',
    group:       'Binding',
    label:       'Listen IP',
    description: 'IP address mod_event_socket binds to for inbound ESL connections.',
    purpose:     'Controls which network interface the ESL listener accepts connections on. 127.0.0.1 restricts ESL to the loopback interface (localhost only), which is correct for ENRS where the backend and FreeSWITCH run on the same host. 0.0.0.0 exposes ESL on all interfaces — a significant security risk.',
    notes:       'Keep at 127.0.0.1 unless the ENRS backend runs on a separate host. If remote access is needed, restrict inbound connections using apply-inbound-acl instead of exposing ESL publicly. Changing this param requires a mod_event_socket restart to take effect.',
    type:        'ip',
    example:     '127.0.0.1',
    defaultValue:     '127.0.0.1',
    recommendedValue: '127.0.0.1',
    visibility:  'basic',
    riskLevel:   'high',
    restartRequired: true,
    estimatedDowntime: 'Brief (mod_event_socket restart required)',
    affectedServices:  ['ESL Connection', 'ENRS Backend', 'FreeSWITCH Control Plane'],
    aliases:          ['esl ip', 'esl bind ip', 'event socket ip', 'esl listen address'],
  },

  'listen-port': {
    category:    'Connection',
    group:       'Binding',
    label:       'Listen Port',
    description: 'TCP port mod_event_socket listens on for ESL connections.',
    purpose:     'The TCP port the ESL server listens on. ENRS connects to FreeSWITCH via modesl on this port. The ENRS backend env var ESL_PORT must match.',
    notes:       'The standard FreeSWITCH ESL port is 8021. Only change if a port conflict exists and update ESL_PORT in the ENRS backend environment to match. Changing requires a mod_event_socket restart.',
    type:        'port',
    example:     '8021',
    defaultValue:     '8021',
    recommendedValue: '8021',
    visibility:  'basic',
    riskLevel:   'high',
    restartRequired: true,
    estimatedDowntime: 'Brief (mod_event_socket restart required)',
    affectedServices:  ['ESL Connection', 'ENRS Backend'],
    aliases:          ['esl port', 'event socket port', 'esl tcp port', '8021'],
    usedBy:           ['ENRS ESL Service (ESL_PORT env var)'],
  },

  password: {
    category:    'Connection',
    group:       'Authentication',
    label:       'ESL Password',
    description: 'Password required to authenticate ESL client connections.',
    purpose:     'ESL clients (including the ENRS backend) must present this password in the ESL auth command before they can send API commands or subscribe to events. The ENRS backend env var ESL_PASSWORD must match.',
    notes:       'The FreeSWITCH default is "ClueCon" — change this in every non-development deployment. The ENRS backend reads ESL_PASSWORD from its .env file; both must stay in sync. Changing requires a mod_event_socket restart.',
    type:        'string',
    example:     'your-strong-esl-password',
    defaultValue:     'ClueCon',
    recommendedValue: 'A strong random string (see ESL_PASSWORD in backend .env)',
    visibility:  'basic',
    riskLevel:   'high',
    restartRequired: true,
    estimatedDowntime: 'Brief (mod_event_socket restart required)',
    affectedServices:  ['ESL Connection', 'ENRS Backend'],
    aliases:          ['esl password', 'esl auth password', 'event socket password', 'clucon'],
    usedBy:           ['ENRS ESL Service (ESL_PASSWORD env var)'],
  },

  // ── Connection › NAT ─────────────────────────────────────────────────────

  'nat-map': {
    category:    'Connection',
    group:       'NAT',
    label:       'NAT Map',
    description: 'Whether to apply NAT mapping to inbound ESL connections.',
    purpose:     'When enabled, FreeSWITCH applies NAT address translation to ESL connection source addresses. Not relevant for loopback connections (127.0.0.1) — this is only meaningful when ESL is exposed on a public interface.',
    notes:       'Leave false for standard ENRS deployments where ESL is loopback-only. Only relevant if ESL is exposed on a NAT-traversed interface.',
    type:        'boolean',
    example:     'false',
    defaultValue:     'false',
    recommendedValue: 'false',
    visibility:  'expert',
    riskLevel:   'low',
    restartRequired: false,
    affectedServices:  ['ESL Connection'],
    aliases:          ['nat mapping', 'esl nat', 'nat traversal esl'],
  },

  // ── Security › ACL ───────────────────────────────────────────────────────

  'apply-inbound-acl': {
    category:    'Security',
    group:       'Access Control',
    label:       'Inbound ACL',
    description: 'ACL profile name to apply to inbound ESL connections.',
    purpose:     'When set, FreeSWITCH checks each inbound ESL connection source IP against the named ACL profile (defined in acl.conf.xml). Connections from IPs not in the ACL are rejected before password authentication.',
    notes:       'Use "loopback.auto" to restrict ESL to localhost IPs only. Set a custom ACL if the ENRS backend connects from a separate host. Leave unset (disabled) only if listen-ip already restricts access sufficiently.',
    type:        'string',
    example:     'loopback.auto',
    defaultValue:     '',
    recommendedValue: 'loopback.auto (when ESL is on 127.0.0.1)',
    visibility:  'advanced',
    riskLevel:   'medium',
    restartRequired: false,
    affectedServices:  ['ESL Connection', 'Security'],
    aliases:          ['esl acl', 'inbound acl', 'access control list esl', 'loopback.auto'],
  },

  // ── Connection › Startup ─────────────────────────────────────────────────

  'stop-on-bind-error': {
    category:    'Connection',
    group:       'Startup',
    label:       'Stop on Bind Error',
    description: 'Whether FreeSWITCH halts startup if the ESL port cannot be bound.',
    purpose:     'If mod_event_socket cannot bind to the configured listen-port (e.g. port already in use), this param controls whether FreeSWITCH aborts startup with an error or continues running without ESL. Enabling this prevents ENRS from connecting to a FreeSWITCH instance with a broken ESL configuration.',
    notes:       'Recommended: enable in production so a misconfigured ESL port surfaces as a hard startup failure rather than a silent connectivity gap. Disable only if ESL is intentionally optional.',
    type:        'boolean',
    example:     'true',
    defaultValue:     'false',
    recommendedValue: 'true',
    visibility:  'advanced',
    riskLevel:   'low',
    restartRequired: true,
    estimatedDowntime: 'Brief (mod_event_socket restart required)',
    affectedServices:  ['FreeSWITCH Startup', 'ESL Connection'],
    aliases:          ['bind error', 'esl startup error', 'fail on bind error'],
  },
};

// ── Lookup ─────────────────────────────────────────────────────────────────────

/**
 * Return the complete ConfigurationEntry for an event_socket.conf.xml param.
 *
 * Always returns a normalised ConfigurationEntry via applyMetaDefaults().
 * Unknown params receive a synthesised generic entry.
 *
 * @param {string} key  — param name attribute value (e.g. 'password')
 * @returns {object}    — ConfigurationEntry fields + { metadata: ConfigurationEntry }
 */
export function lookupEslParam(key) {
  const raw = eventSocketCatalog[key] ?? {
    category:    'Other',
    label:       key,
    description: 'Custom parameter — not in the catalog. Read/write/toggle is fully supported.',
    type:        'string',
    visibility:  'advanced',
    notes:       'This parameter exists in event_socket.conf.xml but has no catalog entry.',
  };

  const meta = applyMetaDefaults(raw);
  return { ...meta, metadata: meta };
}

/** All distinct categories in the catalog, in definition order. */
export const eventSocketCategories = [
  ...new Set(Object.values(eventSocketCatalog).map(e => e.category)),
];
