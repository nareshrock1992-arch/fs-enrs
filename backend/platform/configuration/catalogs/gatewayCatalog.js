import { applyMetaDefaults } from '../metadata/metadataSchema.js';

/**
 * gatewayCatalog — metadata for FreeSWITCH SIP gateway parameters.
 *
 * Keys are param names exactly as they appear in <param name="..."/>.
 * lookupGatewayParam(key) returns catalog metadata with applyMetaDefaults applied.
 */

const gatewayCatalog = {

  // ── Identity / Routing ────────────────────────────────────────────────────
  proxy: {
    category:    'Routing',
    label:       'Proxy',
    description: 'SIP proxy host and optional port (e.g. "192.0.2.1:5060" or "sbc.example.com"). Required — no calls can route without this.',
    type:        'string',
    visibility:  'standard',
    restartRequired: false,
  },
  realm: {
    category:    'Routing',
    label:       'Realm',
    description: 'SIP auth realm. Defaults to the gateway name when omitted.',
    type:        'string',
    visibility:  'standard',
    restartRequired: false,
  },
  'from-domain': {
    category:    'Routing',
    label:       'From Domain',
    description: 'Domain used in the SIP From header for outbound calls. Defaults to realm when omitted.',
    type:        'string',
    visibility:  'standard',
    restartRequired: false,
  },
  'register-proxy': {
    category:    'Routing',
    label:       'Register Proxy',
    description: 'Separate proxy to send REGISTER requests to. Defaults to proxy when omitted.',
    type:        'string',
    visibility:  'advanced',
    restartRequired: false,
  },

  // ── Authentication ────────────────────────────────────────────────────────
  username: {
    category:    'Authentication',
    label:       'Username',
    description: 'SIP authentication username. Required when register is true.',
    type:        'string',
    visibility:  'standard',
    restartRequired: false,
  },
  password: {
    category:    'Authentication',
    label:       'Password',
    description: 'SIP authentication password. Required when register is true.',
    type:        'password',
    visibility:  'standard',
    restartRequired: false,
  },
  'from-user': {
    category:    'Authentication',
    label:       'From User',
    description: 'Username in the SIP From header. Defaults to username when omitted.',
    type:        'string',
    visibility:  'advanced',
    restartRequired: false,
  },
  extension: {
    category:    'Authentication',
    label:       'Extension',
    description: 'Extension to use for inbound calls from this gateway. Defaults to username when omitted.',
    type:        'string',
    visibility:  'advanced',
    restartRequired: false,
  },

  // ── Registration ──────────────────────────────────────────────────────────
  register: {
    category:    'Registration',
    label:       'Register',
    description: 'Whether FreeSWITCH should send REGISTER requests to this gateway. Set to false for static trunks (Avaya, SBCs) that do not need registration.',
    type:        'boolean',
    visibility:  'standard',
    restartRequired: false,
  },
  'expire-seconds': {
    category:    'Registration',
    label:       'Registration Expiry (s)',
    description: 'Registration expiry in seconds. Default 3600 when omitted.',
    type:        'integer',
    visibility:  'standard',
    restartRequired: false,
    validation:  { min: 60, max: 86400 },
  },
  'retry-seconds': {
    category:    'Registration',
    label:       'Retry Delay (s)',
    description: 'Seconds to wait before retrying after a registration failure or timeout.',
    type:        'integer',
    visibility:  'standard',
    restartRequired: false,
    validation:  { min: 5, max: 3600 },
  },
  'register-transport': {
    category:    'Registration',
    label:       'Registration Transport',
    description: 'Transport protocol for REGISTER requests. Valid: udp, tcp, tls.',
    type:        'enum',
    options:     ['udp', 'tcp', 'tls'],
    visibility:  'standard',
    restartRequired: false,
  },

  // ── Transport ─────────────────────────────────────────────────────────────
  transport: {
    category:    'Transport',
    label:       'Transport',
    description: 'SIP transport protocol for all calls through this gateway. Valid: udp, tcp, tls. Default is udp when omitted.',
    type:        'enum',
    options:     ['udp', 'tcp', 'tls'],
    visibility:  'standard',
    restartRequired: false,
  },
  'contact-params': {
    category:    'Transport',
    label:       'Contact Params',
    description: 'Extra parameters appended to the SIP Contact header URI, e.g. "transport=udp".',
    type:        'string',
    visibility:  'advanced',
    restartRequired: false,
  },
  'extension-in-contact': {
    category:    'Transport',
    label:       'Extension in Contact',
    description: 'Include the local extension in the Contact header. Required by some PBXs for proper call routing.',
    type:        'boolean',
    visibility:  'advanced',
    restartRequired: false,
  },

  // ── Keepalive ─────────────────────────────────────────────────────────────
  ping: {
    category:    'Keepalive',
    label:       'OPTIONS Ping (s)',
    description: 'Send SIP OPTIONS keepalive every N seconds. A response failure marks the gateway as down. Set to 0 or omit to disable.',
    type:        'integer',
    visibility:  'standard',
    restartRequired: false,
    validation:  { min: 5, max: 300 },
  },
  'ping-max': {
    category:    'Keepalive',
    label:       'Ping Max Failures',
    description: 'Number of consecutive OPTIONS ping failures before the gateway is marked down. Default 1.',
    type:        'integer',
    visibility:  'advanced',
    restartRequired: false,
    validation:  { min: 1, max: 20 },
  },
  'ping-min': {
    category:    'Keepalive',
    label:       'Ping Min Successes',
    description: 'Number of consecutive OPTIONS ping successes required before the gateway is marked up again.',
    type:        'integer',
    visibility:  'advanced',
    restartRequired: false,
    validation:  { min: 1, max: 20 },
  },

  // ── Caller ID ─────────────────────────────────────────────────────────────
  'caller-id-in-from': {
    category:    'Caller ID',
    label:       'Caller ID in From',
    description: 'Pass the inbound caller ID through in the From header for outbound calls via this gateway.',
    type:        'boolean',
    visibility:  'standard',
    restartRequired: false,
  },
  'sip_cid_type': {
    category:    'Caller ID',
    label:       'Caller ID Type',
    description: 'SIP Caller ID presentation method: rpid (Remote-Party-ID) or pai (P-Asserted-Identity).',
    type:        'enum',
    options:     ['rpid', 'pai'],
    visibility:  'advanced',
    restartRequired: false,
  },
  'cid-type': {
    category:    'Caller ID',
    label:       'CID Type (legacy)',
    description: 'Alias for sip_cid_type. Use sip_cid_type on newer installs.',
    type:        'enum',
    options:     ['rpid', 'pai'],
    visibility:  'advanced',
    restartRequired: false,
  },

  // ── TLS ───────────────────────────────────────────────────────────────────
  'tls-verify-policy': {
    category:    'TLS',
    label:       'TLS Verify Policy',
    description: 'TLS certificate verification policy. "none" disables verification (dev/self-signed only). "subject" verifies the subject CN.',
    type:        'string',
    visibility:  'advanced',
    restartRequired: false,
  },
  'tls-version': {
    category:    'TLS',
    label:       'TLS Version',
    description: 'Minimum TLS version: tlsv1, tlsv1.1, tlsv1.2, tlsv1.3. Default tlsv1.2.',
    type:        'string',
    visibility:  'advanced',
    restartRequired: false,
  },
  'tls-ciphers': {
    category:    'TLS',
    label:       'TLS Ciphers',
    description: 'OpenSSL cipher list string, e.g. "ALL:!ADH:!LOW:!EXP:!MD5:@STRENGTH".',
    type:        'string',
    visibility:  'advanced',
    restartRequired: false,
  },

  // ── RFC 5626 ──────────────────────────────────────────────────────────────
  'rfc-5626': {
    category:    'Advanced',
    label:       'RFC 5626 Flow Mode',
    description: 'Enable RFC 5626 SIP Outbound registration flow mode.',
    type:        'boolean',
    visibility:  'advanced',
    restartRequired: false,
  },
  'reg-id': {
    category:    'Advanced',
    label:       'RFC 5626 Reg-ID',
    description: 'Registration ID for RFC 5626 flow mode. Typically 1.',
    type:        'integer',
    visibility:  'advanced',
    restartRequired: false,
    validation:  { min: 1, max: 100 },
  },
  'codec-prefs': {
    category:    'Advanced',
    label:       'Codec Preferences',
    description: 'Ordered comma-separated codec list, e.g. "PCMA,PCMU,G729".',
    type:        'string',
    visibility:  'advanced',
    restartRequired: false,
  },
  'dial-string': {
    category:    'Advanced',
    label:       'Dial String Override',
    description: 'Custom dial string used instead of the default when routing calls through this gateway.',
    type:        'string',
    visibility:  'advanced',
    restartRequired: false,
  },
};

export const gatewayCategories = [
  'Routing',
  'Authentication',
  'Registration',
  'Transport',
  'Keepalive',
  'Caller ID',
  'TLS',
  'Advanced',
  'Other',
];

/**
 * Look up catalog metadata for a gateway param.
 *
 * @param {string} key  — param name as it appears in the XML
 * @returns {object}    — ConfigurationEntry metadata with applyMetaDefaults applied
 */
export function lookupGatewayParam(key) {
  const raw = gatewayCatalog[key] ?? {
    category:    'Other',
    label:       key,
    description: 'Gateway parameter — not in the catalog.',
    type:        'string',
    visibility:  'advanced',
  };
  const meta = applyMetaDefaults(raw);
  return { ...meta, metadata: meta };
}
