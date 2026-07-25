/**
 * sofia.conf.xml global_settings parameter catalog.
 *
 * sofia.conf.xml configures mod_sofia — the FreeSWITCH SIP endpoint module.
 * This catalog covers the <global_settings> section only.  Individual SIP
 * profile files (sip_profiles/internal.xml, sip_profiles/external.xml, etc.)
 * are managed through separate provider files.
 *
 * Deployment note: changes to these params require a mod_sofia reload
 * (sofia profile <name> restart or reloadxml + sofia reload) to take effect.
 */
import { applyMetaDefaults } from '../metadata/metadataSchema.js';

export const sofiaCatalog = {

  // ── Diagnostics ──────────────────────────────────────────────────────────────

  'log-level': {
    category:    'Diagnostics',
    group:       'Logging',
    label:       'Log Level',
    description: 'Verbosity of the Sofia SIP stack log output.',
    purpose:
      'Controls how much detail mod_sofia writes to the FreeSWITCH log. ' +
      '0 is silent; higher values add progressively more SIP signalling detail. ' +
      'Values above 6 produce very high log volume and are normally only used ' +
      'during short debugging sessions.',
    notes:
      'This controls the Sofia stack log level independently of the FreeSWITCH ' +
      'core log level in switch.conf.xml. Changes require a mod_sofia reload.',
    type:        'integer',
    example:     '0',
    defaultValue:     '0',
    recommendedValue: '0',
    validation:  { min: 0, max: 9 },
    visibility:  'basic',
    riskLevel:   'low',
    restartRequired: false,
    affectedServices: ['mod_sofia', 'SIP Signalling Log'],
    aliases: ['sofia log', 'sip log level', 'sofia verbosity', 'sip debug level'],
  },

  'debug-presence': {
    category:    'Diagnostics',
    group:       'Presence',
    label:       'Debug Presence',
    description: 'Verbosity of presence-event debug output in the Sofia stack.',
    purpose:
      'Controls debug output for SIP SUBSCRIBE/NOTIFY presence events. ' +
      '0 disables presence debugging; non-zero values write detailed presence ' +
      'state change information to the log. Only enable during presence troubleshooting.',
    notes:
      'Presence debug logging can be high-volume on busy systems. ' +
      'Keep at 0 in production. Changes require a mod_sofia reload.',
    type:        'integer',
    example:     '0',
    defaultValue:     '0',
    recommendedValue: '0',
    validation:  { min: 0, max: 9 },
    visibility:  'advanced',
    riskLevel:   'low',
    restartRequired: false,
    affectedServices: ['mod_sofia', 'SIP Presence'],
    aliases: ['presence debug', 'sip presence log', 'presence verbosity'],
  },

  // ── Network ───────────────────────────────────────────────────────────────────

  'abort-on-empty-external-ip': {
    category:    'Network',
    group:       'Startup',
    label:       'Abort on Empty External IP',
    description: 'Stop FreeSWITCH startup if the external IP address cannot be determined.',
    purpose:
      'When enabled, FreeSWITCH will refuse to start mod_sofia if $${external_rtp_ip} ' +
      'or $${external_sip_ip} cannot be resolved. This prevents SIP profiles from ' +
      'starting with an invalid or empty external IP, which would cause all inbound ' +
      'SIP to fail silently.',
    notes:
      'Useful in cloud deployments where external IP is obtained via STUN or an ' +
      'external service at startup. If disabled and the external IP is empty, SIP ' +
      'profiles will start but remote parties may receive incorrect contact addresses.',
    type:        'boolean',
    example:     'true',
    defaultValue:     null,
    recommendedValue: 'true',
    visibility:  'expert',
    riskLevel:   'low',
    restartRequired: true,
    estimatedDowntime: 'FreeSWITCH restart required',
    affectedServices: ['mod_sofia', 'FreeSWITCH Startup'],
    aliases: ['external ip abort', 'stun abort', 'abort external ip'],
  },

  'auto-restart': {
    category:    'Network',
    group:       'Resilience',
    label:       'Auto Restart',
    description: 'Automatically restart mod_sofia when a SIP profile encounters a fatal error.',
    purpose:
      'When enabled, mod_sofia will attempt to automatically recover from certain ' +
      'fatal error conditions (such as a bound port being released) by restarting ' +
      'the affected profile. This improves availability in flaky network environments ' +
      'but can mask configuration problems.',
    notes:
      'Disable in production to ensure failures surface as visible alerts rather than ' +
      'being silently retried. Enable only if the deployment environment is known to ' +
      'have transient network disruptions.',
    type:        'boolean',
    example:     'false',
    defaultValue:     'false',
    recommendedValue: 'false',
    visibility:  'expert',
    riskLevel:   'low',
    restartRequired: true,
    estimatedDowntime: 'mod_sofia reload required',
    affectedServices: ['mod_sofia'],
    aliases: ['sofia auto restart', 'profile auto restart'],
  },

  // ── Diagnostics › Capture ────────────────────────────────────────────────────

  'capture-server': {
    category:    'Diagnostics',
    group:       'Packet Capture',
    label:       'Capture Server',
    description: 'HEP/Homer server address for SIP packet capture.',
    purpose:
      'Sends a copy of all SIP signalling to a HEP capture server (Homer) for ' +
      'centralised SIP debugging and monitoring. Supports HEPv2 (plain UDP) and ' +
      'HEPv3 (extended, with capture_id). ' +
      'Format: protocol:host:port (HEPv2) or protocol:host:port;hep=3;capture_id=N (HEPv3).',
    notes:
      'Requires a running Homer/HEP server. Keep disabled unless actively capturing SIP. ' +
      'Adds a network hop to every SIP transaction — do not enable in high-throughput production.',
    type:        'string',
    example:     'udp:homer.domain.com:5060;hep=3;capture_id=100',
    defaultValue:     null,
    recommendedValue: null,
    visibility:  'expert',
    riskLevel:   'low',
    restartRequired: false,
    affectedServices: ['mod_sofia', 'SIP Capture', 'Homer'],
    aliases: ['homer', 'hep server', 'sip capture', 'packet capture server'],
  },
};

// ── Lookup ─────────────────────────────────────────────────────────────────────

/**
 * Return the complete ConfigurationEntry for a sofia.conf.xml global_settings param.
 *
 * @param {string} key
 * @returns {object} ConfigurationEntry fields + { metadata }
 */
export function lookupSofiaParam(key) {
  const raw = sofiaCatalog[key] ?? {
    category:    'Other',
    label:       key,
    description: 'Custom parameter — not in the catalog. Read/write/toggle is fully supported.',
    type:        'string',
    visibility:  'advanced',
    notes:       'This parameter exists in sofia.conf.xml but has no catalog entry.',
  };

  const meta = applyMetaDefaults(raw);
  return { ...meta, metadata: meta };
}

/** All distinct categories in the catalog, in definition order. */
export const sofiaCategories = [
  ...new Set(Object.values(sofiaCatalog).map(e => e.category)),
];
