/**
 * vars.xml variable catalog.
 *
 * Each entry describes a known X-PRE-PROCESS variable: its category, group,
 * label, description, purpose, type, validation rules, defaults, visibility
 * level, deployment impact, and cross-references.
 *
 * Variables not in this catalog are still managed (read/write/toggle) via
 * lookupVar()'s generic fallback. They render with synthesised metadata.
 *
 * All entries are normalised by applyMetaDefaults() inside lookupVar().
 * Callers always receive a complete ConfigurationEntry — no field is undefined.
 *
 * Parser note: VarsParser only detects cmd="set" directives. STUN entries
 * (cmd="stun-set") are not classified as entry segments and will not appear
 * in the entry list regardless of their commented status.
 */
import { applyMetaDefaults } from '../metadata/metadataSchema.js';

export const varsCatalog = {

  // ── Network › SIP Domain ──────────────────────────────────────────────────

  domain_name: {
    category:    'Network',
    group:       'SIP Domain',
    label:       'Domain Name',
    description: 'Primary SIP domain. Defaults to local IP when set to $${local_ip_v4}.',
    purpose:     'Defines the primary SIP domain used by FreeSWITCH. This value appears in SIP headers, directory URIs, and registration challenges. Phones register to this domain.',
    notes:       'Changing this requires all registered phones to re-register. If using TLS, the domain must match the certificate CN or SAN. For ENRS, this domain is embedded in SIP gateway configuration.',
    type:        'string',
    example:     'sip.company.com',
    defaultValue:     '$${local_ip_v4}',
    recommendedValue: 'A fully-qualified domain name (FQDN) for any deployment with external SIP access.',
    visibility:  'basic',
    riskLevel:   'medium',
    estimatedDowntime: 'None (reloadxml)',
    affectedServices:  ['SIP Registration', 'SIP Profiles', 'Directory', 'ENRS SIP Gateway'],
    aliases:          ['sip domain', 'sip server', 'fqdn', 'sip server domain'],
    relatedVariables: ['local_ip_v4', 'external_sip_ip'],
    usedBy:           ['SIP Profiles', 'Directory', 'ENRS SIP Gateway'],
  },

  // ── Network › Network Interfaces ─────────────────────────────────────────

  local_ip_v4: {
    category:    'Network',
    group:       'Network Interfaces',
    label:       'Local IPv4',
    description: 'Local interface IP address. Usually auto-detected by FreeSWITCH.',
    purpose:     'Specifies the local network interface IP address that FreeSWITCH uses for SIP binding and internal media routing. The special value "auto" selects the first non-loopback interface automatically.',
    notes:       'On multi-homed servers (multiple NICs), set this explicitly to prevent FreeSWITCH from binding to an unintended interface. Changes take effect after reloadxml, but media binding changes may require a process restart.',
    type:        'ip',
    example:     '192.168.1.100',
    defaultValue:     'auto',
    recommendedValue: 'auto (single-NIC servers) or explicit IP (multi-homed servers)',
    visibility:  'advanced',
    riskLevel:   'medium',
    estimatedDowntime: 'None (reloadxml)',
    affectedServices:  ['SIP Stack', 'RTP Media', 'ESL'],
    aliases:          ['local ip', 'interface ip', 'bind ip', 'local address', 'nic ip'],
    relatedVariables: ['domain_name', 'bind_server_ip', 'external_sip_ip', 'external_rtp_ip'],
  },

  bind_server_ip: {
    category:    'Network',
    group:       'Network Interfaces',
    label:       'Bind Server IP',
    description: 'IP address to bind the SIP stack to. Use "auto" for first non-loopback.',
    purpose:     'The IP address the FreeSWITCH SIP stack listens on for incoming SIP traffic. In most deployments this matches local_ip_v4. On multi-homed servers, explicit binding prevents accepting SIP on unintended interfaces.',
    notes:       'Set to "auto" unless you have multiple network interfaces and need to restrict SIP to a specific one. Incorrect values here will cause FreeSWITCH to fail to start its SIP profiles.',
    type:        'string',
    example:     'auto',
    defaultValue:     'auto',
    recommendedValue: 'auto',
    visibility:  'advanced',
    riskLevel:   'low',
    affectedServices:  ['SIP Stack'],
    aliases:          ['bind ip', 'listen ip', 'sip bind', 'sip listen address'],
    relatedVariables: ['local_ip_v4'],
  },

  // ── Network › NAT & External ─────────────────────────────────────────────

  external_rtp_ip: {
    category:    'Network',
    group:       'NAT & External',
    label:       'External RTP IP',
    description: 'Public IP or STUN server for RTP media in NAT deployments.',
    purpose:     'Specifies the public IP address or STUN server used in SDP media offers. Remote endpoints send media packets to this address. Required for correct media flow when FreeSWITCH is behind NAT.',
    notes:       'Use stun:stun.freeswitch.org for automatic NAT discovery in lab environments. Use a static public IP in production for reliability — STUN adds latency and a third-party dependency to every call setup. If left unset and behind NAT, media will fail to reach remote endpoints.',
    type:        'string',
    example:     'stun:stun.freeswitch.org',
    defaultValue:     null,
    recommendedValue: 'Static public IP (production) or stun:stun.freeswitch.org (lab)',
    visibility:  'basic',
    riskLevel:   'medium',
    estimatedDowntime: 'None (reloadxml)',
    affectedServices:  ['RTP Media', 'SIP Profiles', 'ENRS ERS Conference'],
    aliases:          ['nat rtp', 'public rtp ip', 'external media ip', 'stun rtp', 'rtp nat'],
    relatedVariables: ['external_sip_ip', 'local_ip_v4'],
  },

  external_sip_ip: {
    category:    'Network',
    group:       'NAT & External',
    label:       'External SIP IP',
    description: 'Public IP or STUN server for SIP signalling in NAT deployments.',
    purpose:     'Specifies the public IP address placed in SIP Contact and Via headers when FreeSWITCH is behind NAT. Ensures remote endpoints send SIP responses to the correct public address rather than the private LAN IP.',
    notes:       'Use stun:stun.freeswitch.org for automatic NAT discovery in lab environments. Use a static public IP in production. If this is misconfigured behind NAT, SIP responses will be routed to the private IP and calls will fail to connect.',
    type:        'string',
    example:     'stun:stun.freeswitch.org',
    defaultValue:     null,
    recommendedValue: 'Static public IP (production) or stun:stun.freeswitch.org (lab)',
    visibility:  'basic',
    riskLevel:   'medium',
    estimatedDowntime: 'None (reloadxml)',
    affectedServices:  ['SIP Stack', 'SIP Profiles', 'ENRS SIP Gateway'],
    aliases:          ['nat sip', 'public sip ip', 'external signalling ip', 'stun sip', 'sip nat'],
    relatedVariables: ['external_rtp_ip', 'local_ip_v4'],
  },

  // ── Security ─────────────────────────────────────────────────────────────

  default_password: {
    category:    'Security',
    group:       'Authentication',
    label:       'Default SIP Password',
    description: 'Default registration password for directory user accounts. Change before production.',
    purpose:     'Sets the default password for all SIP endpoint registrations in the directory template. Any directory user created without an explicit password inherits this value. This password authenticates phones and soft clients against the FreeSWITCH SIP server.',
    notes:       'CRITICAL: This password protects all SIP endpoints that use the directory template. A weak or default value allows any device on the network to register and potentially make outbound calls. The deployment validator checks for the known-weak value "1234". Must be changed before any external SIP exposure.',
    type:        'password',
    sensitive:   true,
    example:     'YourSecurePassword123!',
    visibility:  'basic',
    riskLevel:   'high',
    estimatedDowntime: 'None (reloadxml)',
    affectedServices:  ['Directory', 'SIP Registration', 'All SIP Endpoints'],
    aliases:          ['sip password', 'registration password', 'endpoint password', 'auth password', 'directory password'],
    relatedVariables: ['domain_name'],
    usedBy:           ['Directory template', 'SIP endpoint registration'],
  },

  // ── Media ─────────────────────────────────────────────────────────────────

  hold_music: {
    category:    'Media',
    group:       'Audio',
    label:       'Hold Music',
    description: 'Default hold music stream URI.',
    purpose:     'The audio stream played to callers while they are on hold. Uses the local_stream:// URI scheme to reference a FreeSWITCH local stream configured in conference.conf.xml.',
    notes:       'The default local_stream://moh stream plays from the bundled hold music directory. To use custom audio, configure a new local stream in conference.conf.xml and reference it here. The stream plays continuously — it is not a one-shot file.',
    type:        'string',
    example:     'local_stream://moh',
    defaultValue:     'local_stream://moh',
    recommendedValue: 'local_stream://moh',
    visibility:  'basic',
    riskLevel:   'low',
    affectedServices:  ['SIP Stack', 'Hold Processing'],
    aliases:          ['moh', 'music on hold', 'hold audio', 'hold stream', 'on hold music'],
    relatedVariables: ['sound_prefix'],
  },

  sound_prefix: {
    category:    'Media',
    group:       'Audio',
    label:       'Sound Prefix',
    description: 'Root directory for bundled FreeSWITCH sounds.',
    purpose:     'Base path used when resolving relative sound file references in IVR, conference, and dialplan operations. FreeSWITCH prepends this path to any relative audio file URI.',
    notes:       'The default path references the bundled Callie voice pack in English (US). To use a custom or branded voice, place audio files in an alternate directory and update this path. Affects all prompts system-wide including ENRS IVR and ENS playback.',
    type:        'directory',
    example:     '$${base_dir}/sounds/en/us/callie',
    defaultValue:     '$${base_dir}/sounds/en/us/callie',
    recommendedValue: '$${base_dir}/sounds/en/us/callie',
    visibility:  'expert',
    riskLevel:   'medium',
    estimatedDowntime: 'None (reloadxml)',
    affectedServices:  ['IVR', 'Conference', 'ENRS ENS Playback', 'ENRS ERS'],
    aliases:          ['sounds directory', 'prompts path', 'audio library', 'sound files', 'tts path'],
    relatedVariables: ['hold_music'],
    usedBy:           ['ENRS IVR Playback', 'ENRS ENS Playback', 'Conference Prompts'],
  },

  default_ring_tone: {
    category:    'Media',
    group:       'Audio',
    label:       'Default Ring Tone',
    description: 'Ring-back tone played to the caller while the called party rings.',
    purpose:     'The audio signal played to an outbound caller while the destination is ringing. Uses FreeSWITCH tone generation syntax to produce a DTMF-compatible audio waveform.',
    notes:       'Format: %(on_ms,off_ms,freq_hz[,freq_hz2]). The default 440+480 Hz pattern matches the North American ring tone standard. Adjust the frequencies for regional deployments (e.g. UK uses 400+450 Hz) or replace with a custom audio file URI.',
    type:        'string',
    example:     '%(2000,4000,440,480)',
    defaultValue:     '%(2000,4000,440,480)',
    recommendedValue: '%(2000,4000,440,480)',
    visibility:  'advanced',
    riskLevel:   'low',
    affectedServices:  ['SIP Stack', 'Ringback Tone'],
    aliases:          ['ringback', 'ring tone', 'ringtone', 'ring back', 'rbt'],
  },

  // ── Dialling ─────────────────────────────────────────────────────────────

  default_areacode: {
    category:    'Dialling',
    group:       'PSTN',
    label:       'Default Area Code',
    description: '10-digit dialling area code prefix.',
    purpose:     'Area code prepended to 7-digit PSTN numbers in the default dialplan. When a caller dials 7 digits, this area code is added to form a complete E.164-style number before routing to the gateway.',
    notes:       'Only relevant if the default_number_alias or 7-digit dialling feature in the dialplan is active. Has no effect on deployments using fully-qualified E.164 numbers for all PSTN calls.',
    type:        'string',
    example:     '212',
    visibility:  'basic',
    riskLevel:   'low',
    affectedServices:  ['Dialplan', 'PSTN Routing'],
    aliases:          ['area code', 'npa', 'local area code', 'dialling prefix'],
  },

  transfer_fallback_extension: {
    category:    'Dialling',
    group:       'Call Routing',
    label:       'Transfer Fallback Extension',
    description: 'Extension called when a blind transfer destination does not answer.',
    purpose:     'Defines where transferred calls are routed when the transfer destination does not answer or rejects the call. Prevents transferred calls from being silently abandoned.',
    notes:       'Set to "operator" in most deployments to route unanswered transfers to a human operator. Can be any active dialplan extension. If the fallback extension also fails, the call is released.',
    type:        'string',
    example:     'operator',
    defaultValue:     'operator',
    recommendedValue: 'operator',
    visibility:  'advanced',
    riskLevel:   'low',
    affectedServices:  ['Dialplan', 'Call Transfer'],
    aliases:          ['transfer fallback', 'blind transfer fallback', 'transfer failure', 'fallback extension'],
  },

  // ── Codecs ────────────────────────────────────────────────────────────────

  global_codec_prefs: {
    category:    'Codecs',
    group:       'Audio Codecs',
    label:       'Global Codec Preferences',
    description: 'Ordered comma-separated list of codecs offered on outbound calls.',
    purpose:     'Sets the ordered list of audio codecs offered in SDP on all calls. FreeSWITCH selects the first mutually supported codec from this list. The order directly affects codec negotiation and transcoding CPU load.',
    notes:       'G.729 requires a per-channel license for encoding — ensure your FreeSWITCH build includes it if listed. Listing PCMU/PCMA first ensures a baseline without transcoding on any endpoint. G.722 provides 16kHz wideband audio when both endpoints support it.',
    type:        'string',
    example:     'PCMU,PCMA,G729,G722',
    defaultValue:     'PCMU,PCMA,G729,G722,H264,VP8',
    recommendedValue: 'PCMU,PCMA,G722',
    visibility:  'advanced',
    riskLevel:   'low',
    estimatedDowntime: 'None (affects new calls only)',
    affectedServices:  ['SIP Stack', 'RTP Media', 'Transcoding Engine'],
    aliases:          ['codecs', 'audio codecs', 'codec list', 'codec preference', 'codec order'],
    relatedVariables: ['outbound_codec_prefs'],
  },

  outbound_codec_prefs: {
    category:    'Codecs',
    group:       'Audio Codecs',
    label:       'Outbound Codec Preferences',
    description: 'Codec preference list for outbound calls specifically.',
    purpose:     'Overrides global_codec_prefs specifically for calls initiated by FreeSWITCH toward external SIP gateways. Allows restricting outbound calls to codecs supported by the gateway without affecting internal call negotiation.',
    notes:       'If your SIP gateway only supports G.711, set this to PCMU,PCMA. This avoids transcoding on the gateway leg while allowing G.722 for internal endpoints. Leave unset to use global_codec_prefs for all calls.',
    type:        'string',
    example:     'PCMU,PCMA',
    visibility:  'advanced',
    riskLevel:   'low',
    affectedServices:  ['SIP Gateway', 'RTP Media'],
    aliases:          ['outbound codecs', 'gateway codecs', 'trunk codecs', 'egress codecs'],
    relatedVariables: ['global_codec_prefs'],
    usedBy:           ['ENRS SIP Gateway', 'ENRS ENS Outbound Calls'],
  },

  // ── Recording ─────────────────────────────────────────────────────────────

  recording_plugin: {
    category:    'Recording',
    group:       'Recording Engine',
    label:       'Recording Plugin',
    description: 'Module used for recording.',
    purpose:     'Selects the FreeSWITCH module responsible for call recording. The choice determines which audio file formats are supported and how recording is processed (with or without transcoding).',
    notes:       'mod_sndfile supports WAV, MP3, Ogg, and other formats — requires libaudiofile or libsndfile. mod_native_file records without transcoding (lower CPU, higher quality) but only supports the active call codec. For ENRS, mod_sndfile is required for conference recording to produce standard WAV files.',
    type:        'string',
    example:     'mod_sndfile',
    defaultValue:     'mod_sndfile',
    recommendedValue: 'mod_sndfile',
    visibility:  'expert',
    riskLevel:   'medium',
    affectedServices:  ['ENRS Conference Recording', 'ENRS ERS', 'ENRS ENS'],
    aliases:          ['recorder', 'recording module', 'call recording plugin', 'audio recorder'],
    usedBy:           ['ENRS Conference Recording', 'ENRS ERS Incident Recording'],
  },

  // ── System › Performance ─────────────────────────────────────────────────

  max_sessions: {
    category:    'System',
    group:       'Performance',
    label:       'Max Sessions',
    description: 'Maximum simultaneous call sessions. Set to 0 for unlimited (not recommended).',
    purpose:     'Hard limit on concurrent call sessions. Once reached, FreeSWITCH rejects new inbound calls with a SIP 503 response. Protects the server from resource exhaustion during high call volume.',
    notes:       'Set conservatively based on CPU and memory. A typical FreeSWITCH instance handles 50–200 concurrent sessions per CPU core depending on codec and transcoding load. Value 0 disables the limit — risky on production servers as it can exhaust all system memory.',
    type:        'integer',
    min:         1,
    max:         100000,
    validation:  { min: 1, max: 100000 },
    example:     '1000',
    defaultValue:     '1000',
    recommendedValue: '500 (adjust based on server capacity)',
    visibility:  'advanced',
    riskLevel:   'medium',
    affectedServices:  ['FreeSWITCH Core', 'Inbound Calls', 'ENRS ERS Conference'],
    aliases:          ['max calls', 'call limit', 'concurrent sessions', 'session limit', 'max concurrent calls'],
    relatedVariables: ['sessions_per_second'],
  },

  sessions_per_second: {
    category:    'System',
    group:       'Performance',
    label:       'Sessions Per Second',
    description: 'Maximum new call sessions allowed per second.',
    purpose:     'Rate limit for new call session establishment. FreeSWITCH throttles inbound and outbound calls that exceed this rate. Protects against SIP flood attacks and prevents resource exhaustion during sudden call bursts.',
    notes:       'For ENRS emergency notification campaigns, this value determines the maximum call origination rate. A value of 30 means 1800 calls can be started per minute at maximum rate. Increase carefully — higher values increase CPU load and may overwhelm gateway capacity.',
    type:        'integer',
    min:         1,
    max:         10000,
    validation:  { min: 1, max: 10000 },
    example:     '30',
    defaultValue:     '30',
    recommendedValue: '30 (increase to 100+ for high-volume ENS deployments)',
    visibility:  'advanced',
    riskLevel:   'medium',
    affectedServices:  ['FreeSWITCH Core', 'ENRS ENS Campaign Engine', 'Inbound Traffic'],
    aliases:          ['call rate', 'cps', 'calls per second', 'rate limit', 'call throttle'],
    relatedVariables: ['max_sessions'],
    usedBy:           ['ENRS ENS Campaign Engine'],
  },

  // ── System › Logging ─────────────────────────────────────────────────────

  loglevel: {
    category:    'System',
    group:       'Logging',
    label:       'Log Level',
    description: 'Logging verbosity. Values: CONSOLE DEBUG INFO NOTICE WARNING ERR CRIT ALERT.',
    purpose:     'Controls the minimum severity of log messages output by FreeSWITCH. Lower severity levels are inclusive — WARNING also outputs ERR, CRIT, and ALERT. Affects both console and file log sinks.',
    notes:       'Use WARNING or ERR in production for minimal logging overhead. Use DEBUG only when troubleshooting — it generates very high log volume and can impact call processing performance. NOTICE or INFO provides a useful middle ground for staging environments.',
    type:        'enum',
    options:     ['CONSOLE', 'DEBUG', 'INFO', 'NOTICE', 'WARNING', 'ERR', 'CRIT', 'ALERT'],
    validation:  { allowedValues: ['CONSOLE', 'DEBUG', 'INFO', 'NOTICE', 'WARNING', 'ERR', 'CRIT', 'ALERT'] },
    example:     'WARNING',
    defaultValue:     'WARNING',
    recommendedValue: 'WARNING',
    visibility:  'basic',
    riskLevel:   'low',
    affectedServices:  ['FreeSWITCH Logging', 'Log Aggregation'],
    aliases:          ['log verbosity', 'logging level', 'debug level', 'log severity'],
  },

  console_to_json: {
    category:    'System',
    group:       'Logging',
    label:       'Console JSON Output',
    description: 'Emit log lines as JSON for structured log aggregators.',
    purpose:     'When enabled, FreeSWITCH emits all console log lines as structured JSON objects. Enables log aggregators (Elasticsearch, Splunk, Grafana Loki) to parse and index individual log fields for search and alerting.',
    notes:       'Enable in production environments using centralised logging. Disable in development for human-readable console output. Has no effect on file-based log channels — only the console sink is affected.',
    type:        'boolean',
    example:     'false',
    defaultValue:     'false',
    recommendedValue: 'true (production) or false (development)',
    visibility:  'advanced',
    riskLevel:   'low',
    affectedServices:  ['FreeSWITCH Console Logging', 'Log Aggregation'],
    aliases:          ['json logs', 'structured logging', 'log format', 'console format'],
  },

  // ── Caller ID ─────────────────────────────────────────────────────────────

  outbound_caller_id_name: {
    category:    'Caller ID',
    group:       'Caller ID',
    label:       'Outbound Caller ID Name',
    description: 'Default caller name sent on outbound calls.',
    purpose:     'The caller name (CNAM) sent on outbound PSTN calls when no per-call override is specified. Displayed on the recipient phone as the caller name alongside the number.',
    notes:       'PSTN carriers may override this value with their own CNAM lookup. For ENRS emergency notifications, set this to your organisation name (e.g. "City Emergency Alert") to ensure recipients recognise and answer the call.',
    type:        'string',
    example:     'FreeSWITCH',
    defaultValue:     'FreeSWITCH',
    recommendedValue: 'Your organisation name (e.g. "City Emergency Alert")',
    visibility:  'basic',
    riskLevel:   'low',
    affectedServices:  ['SIP Gateway', 'ENRS ENS Notifications'],
    aliases:          ['caller name', 'cnam', 'outbound caller name', 'from name', 'caller id name'],
    relatedVariables: ['outbound_caller_id_number'],
    usedBy:           ['ENRS ENS Campaign Engine'],
  },

  outbound_caller_id_number: {
    category:    'Caller ID',
    group:       'Caller ID',
    label:       'Outbound Caller ID Number',
    description: 'Default caller number (ANI) sent on outbound calls.',
    purpose:     'The caller number (ANI) placed in the SIP From header for outbound PSTN calls when no per-call override is set. This is the number displayed on the recipient phone and used for call-back.',
    notes:       'Must be a number authorised by your PSTN carrier. Presenting unauthorised numbers may violate STIR/SHAKEN regulations. For ENRS emergency notifications, use a recognisable published callback number that recipients can verify before answering.',
    type:        'string',
    example:     '0000000000',
    defaultValue:     '0000000000',
    recommendedValue: 'Your organisation main number or a dedicated ENRS pilot number',
    visibility:  'basic',
    riskLevel:   'low',
    affectedServices:  ['SIP Gateway', 'ENRS ENS Notifications'],
    aliases:          ['caller id', 'ani', 'outbound number', 'from number', 'caller number', 'caller id number'],
    relatedVariables: ['outbound_caller_id_name'],
    usedBy:           ['ENRS ENS Campaign Engine'],
  },
};

// ── Lookup ────────────────────────────────────────────────────────────────────

/**
 * Return the complete ConfigurationEntry for a variable key.
 *
 * Always returns a normalised ConfigurationEntry via applyMetaDefaults().
 * Unknown keys receive a synthesised generic entry rather than being omitted.
 *
 * The returned object is spread FLAT onto the ConfigurationObject by VarsProvider,
 * AND exposed as a nested `metadata` sub-object, giving callers two access paths:
 *   entry.label          (flat — backward compat with existing UI code)
 *   entry.metadata.label (nested — preferred for new Phase 7.3B+ components)
 *
 * @param {string} key
 * @returns {object} ConfigurationEntry fields + { metadata: ConfigurationEntry }
 */
export function lookupVar(key) {
  const raw = varsCatalog[key] ?? {
    category:    'Custom',
    label:       key,
    description: 'Custom variable — not in the catalog. Read/write/toggle is fully supported.',
    type:        'string',
    visibility:  'advanced',
    notes:       'This variable exists in vars.xml but has no catalog entry. It may be a user-defined variable, a FreeSWITCH internal variable, or a variable added by a module.',
  };

  const meta = applyMetaDefaults(raw);

  // Return flat spread (backward compat) + nested metadata sub-object (new contract).
  // Phase 7.3B+ components use entry.metadata.*; existing code uses entry.* directly.
  return { ...meta, metadata: meta };
}

/** All distinct categories in the catalog, in definition order (for sidebar filter). */
export const varCategories = [
  ...new Set(Object.values(varsCatalog).map(e => e.category)),
];
