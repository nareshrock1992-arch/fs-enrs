/**
 * vars.xml variable catalog.
 *
 * Each entry describes a known X-PRE-PROCESS variable: its category,
 * description, type, validation rules, and an optional default.
 *
 * Variables not in this catalog are still managed (read/write/toggle) —
 * they just render with a generic "Custom variable" description in the UI.
 */
export const varsCatalog = {

  // ── Network ───────────────────────────────────────────────────────────────────

  domain_name: {
    category:    'Network',
    label:       'Domain Name',
    description: 'Primary SIP domain. Defaults to local IP when set to $${local_ip_v4}.',
    type:        'string',
    example:     'sip.company.com',
  },
  local_ip_v4: {
    category:    'Network',
    label:       'Local IPv4',
    description: 'Local interface IP. Usually auto-detected by FreeSWITCH.',
    type:        'ip',
  },
  external_rtp_ip: {
    category:    'Network',
    label:       'External RTP IP',
    description: 'Public IP or STUN server for RTP media in NAT deployments.',
    type:        'string',
    example:     'stun:stun.freeswitch.org',
  },
  external_sip_ip: {
    category:    'Network',
    label:       'External SIP IP',
    description: 'Public IP or STUN server for SIP signalling in NAT deployments.',
    type:        'string',
    example:     'stun:stun.freeswitch.org',
  },
  bind_server_ip: {
    category:    'Network',
    label:       'Bind Server IP',
    description: 'IP address to bind the SIP stack to. Use "auto" for first non-loopback.',
    type:        'string',
    example:     'auto',
  },

  // ── SIP ───────────────────────────────────────────────────────────────────────

  default_password: {
    category:    'SIP',
    label:       'Default SIP Password',
    description: 'Default registration password for directory user accounts. Change before production.',
    type:        'password',
    example:     'YourSecurePassword',
    sensitive:   true,
  },
  hold_music: {
    category:    'SIP',
    label:       'Hold Music',
    description: 'Default hold music stream URI.',
    type:        'string',
    example:     'local_stream://moh',
  },
  default_areacode: {
    category:    'SIP',
    label:       'Default Area Code',
    description: '10-digit dialling area code prefix.',
    type:        'string',
    example:     '212',
  },
  transfer_fallback_extension: {
    category:    'SIP',
    label:       'Transfer Fallback Extension',
    description: 'Extension called when a blind transfer destination does not answer.',
    type:        'string',
    example:     'operator',
  },

  // ── Codec / Media ─────────────────────────────────────────────────────────────

  global_codec_prefs: {
    category:    'Codecs',
    label:       'Global Codec Preferences',
    description: 'Ordered comma-separated list of codecs offered on outbound calls.',
    type:        'string',
    example:     'PCMU,PCMA,G729,G722',
  },
  outbound_codec_prefs: {
    category:    'Codecs',
    label:       'Outbound Codec Preferences',
    description: 'Codec preference list for outbound calls specifically.',
    type:        'string',
    example:     'PCMU,PCMA',
  },
  sound_prefix: {
    category:    'Media',
    label:       'Sound Prefix',
    description: 'Root directory for bundled FreeSWITCH sounds.',
    type:        'string',
    example:     '$${base_dir}/sounds/en/us/callie',
  },
  default_ring_tone: {
    category:    'Media',
    label:       'Default Ring Tone',
    description: 'Ring-back tone played to the caller while the called party rings.',
    type:        'string',
    example:     '%(2000,4000,440,480)',
  },

  // ── Recording ─────────────────────────────────────────────────────────────────

  recording_plugin: {
    category:    'Recording',
    label:       'Recording Plugin',
    description: 'Module used for recording.',
    type:        'string',
    example:     'mod_sndfile',
  },

  // ── Security ──────────────────────────────────────────────────────────────────

  console_to_json: {
    category:    'System',
    label:       'Console to JSON',
    description: 'Emit log lines as JSON for structured log aggregators.',
    type:        'boolean',
    example:     'false',
  },

  // ── Outbound caller ID ────────────────────────────────────────────────────────

  outbound_caller_id_name: {
    category:    'Caller ID',
    label:       'Outbound Caller ID Name',
    description: 'Default caller name sent on outbound calls.',
    type:        'string',
    example:     'FreeSWITCH',
  },
  outbound_caller_id_number: {
    category:    'Caller ID',
    label:       'Outbound Caller ID Number',
    description: 'Default caller number (ANI) sent on outbound calls.',
    type:        'string',
    example:     '0000000000',
  },

  // ── System ────────────────────────────────────────────────────────────────────

  max_sessions: {
    category:    'System',
    label:       'Max Sessions',
    description: 'Maximum simultaneous call sessions. Set to 0 for unlimited (not recommended).',
    type:        'integer',
    min:         1,
    max:         100000,
    example:     '1000',
  },
  sessions_per_second: {
    category:    'System',
    label:       'Sessions Per Second',
    description: 'Maximum new call sessions allowed per second.',
    type:        'integer',
    min:         1,
    max:         10000,
    example:     '30',
  },
  loglevel: {
    category:    'System',
    label:       'Log Level',
    description: 'Logging verbosity. Values: CONSOLE DEBUG INFO NOTICE WARNING ERR CRIT ALERT.',
    type:        'enum',
    options:     ['CONSOLE', 'DEBUG', 'INFO', 'NOTICE', 'WARNING', 'ERR', 'CRIT', 'ALERT'],
    example:     'WARNING',
  },
};

/** Return the catalog entry for a key, or a generic fallback. */
export function lookupVar(key) {
  return varsCatalog[key] ?? {
    category:    'Custom',
    label:       key,
    description: 'Custom variable.',
    type:        'string',
  };
}

/** All distinct categories in the catalog (for sidebar filter). */
export const varCategories = [
  ...new Set(Object.values(varsCatalog).map(e => e.category))
];
