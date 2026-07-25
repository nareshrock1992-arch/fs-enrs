/**
 * switch.conf.xml parameter catalog.
 *
 * Each entry describes a known <param> in switch.conf.xml: its category, group,
 * label, description, type, validation rules, defaults, and deployment impact.
 *
 * Parameters not in this catalog are managed (read/write/toggle) via
 * lookupParam()'s generic fallback with synthesised metadata.
 *
 * Note: some params (max-sessions, sessions-per-second) may reference vars.xml
 * variables via $${varname} in the actual file. The value shown in the UI is
 * whatever string is present in the file — the reference is preserved verbatim.
 */
import { applyMetaDefaults } from '../metadata/metadataSchema.js';

export const switchCatalog = {

  // ── System › Performance ─────────────────────────────────────────────────

  'max-sessions': {
    category:    'System',
    group:       'Performance',
    label:       'Max Sessions',
    description: 'Maximum simultaneous call sessions. Overrides the vars.xml value when set directly here.',
    purpose:     'Hard cap on concurrent call sessions at the core switch level. Once reached, FreeSWITCH rejects new inbound calls with SIP 503. In ENRS deployments this is typically set via $${max_sessions} from vars.xml.',
    notes:       'This param references $${max_sessions} from vars.xml in most ENRS installs. Setting it directly here overrides that. Set conservatively — 0 disables the limit and risks memory exhaustion.',
    type:        'string',
    example:     '$${max_sessions}',
    defaultValue:     '1000',
    recommendedValue: '$${max_sessions} (delegates to vars.xml)',
    visibility:  'advanced',
    riskLevel:   'medium',
    restartRequired: false,
    estimatedDowntime: 'None (reloadxml)',
    affectedServices:  ['FreeSWITCH Core', 'Inbound Calls'],
    aliases:          ['max calls', 'call limit', 'max concurrent', 'session limit'],
    relatedVariables: ['sessions-per-second'],
  },

  'sessions-per-second': {
    category:    'System',
    group:       'Performance',
    label:       'Sessions Per Second',
    description: 'Maximum new call sessions allowed per second.',
    purpose:     'Rate limit for new call session establishment. Protects against SIP flood attacks and prevents resource exhaustion. ENRS ENS campaigns are throttled by this value.',
    notes:       'Typically set via $${sessions_per_second} from vars.xml. A value of 30 allows 1800 new calls per minute at maximum rate.',
    type:        'string',
    example:     '$${sessions_per_second}',
    defaultValue:     '30',
    recommendedValue: '$${sessions_per_second}',
    visibility:  'advanced',
    riskLevel:   'medium',
    restartRequired: false,
    estimatedDowntime: 'None (reloadxml)',
    affectedServices:  ['FreeSWITCH Core', 'ENRS ENS Campaign Engine'],
    aliases:          ['cps', 'calls per second', 'rate limit', 'call rate'],
    relatedVariables: ['max-sessions'],
    usedBy:           ['ENRS ENS Campaign Engine'],
  },

  // ── System › Logging ─────────────────────────────────────────────────────

  loglevel: {
    category:    'System',
    group:       'Logging',
    label:       'Log Level',
    description: 'Core switch log verbosity.',
    purpose:     'Controls the minimum severity of messages written by the FreeSWITCH core. This is the switch.conf.xml counterpart to the console_loglevel variable in vars.xml.',
    notes:       'Use WARNING or ERR in production. DEBUG generates very high volume and can impact call processing latency. NOTICE or INFO is suitable for staging.',
    type:        'enum',
    options:     ['CONSOLE', 'DEBUG', 'INFO', 'NOTICE', 'WARNING', 'ERR', 'CRIT', 'ALERT'],
    validation:  { allowedValues: ['CONSOLE', 'DEBUG', 'INFO', 'NOTICE', 'WARNING', 'ERR', 'CRIT', 'ALERT'] },
    example:     'WARNING',
    defaultValue:     'WARNING',
    recommendedValue: 'WARNING',
    visibility:  'basic',
    riskLevel:   'low',
    restartRequired: false,
    affectedServices:  ['FreeSWITCH Logging'],
    aliases:          ['log level', 'debug level', 'log verbosity', 'logging'],
  },

  'console-to-json': {
    category:    'System',
    group:       'Logging',
    label:       'Console JSON Output',
    description: 'Emit core log lines as JSON for structured log aggregators.',
    purpose:     'When enabled, FreeSWITCH emits all console log lines as structured JSON. Enables log aggregators (Elasticsearch, Grafana Loki) to index individual log fields.',
    notes:       'Enable in production environments using centralised logging. Disable in development for human-readable output.',
    type:        'boolean',
    example:     'false',
    defaultValue:     'false',
    recommendedValue: 'true (production) or false (development)',
    visibility:  'advanced',
    riskLevel:   'low',
    restartRequired: false,
    affectedServices:  ['FreeSWITCH Logging'],
    aliases:          ['json logs', 'structured logging', 'log format'],
  },

  // ── RTP › Port Range ─────────────────────────────────────────────────────

  'rtp-start-port': {
    category:    'RTP',
    group:       'Port Range',
    label:       'RTP Start Port',
    description: 'First UDP port in the RTP media port range.',
    purpose:     'Defines the lower bound of the UDP port range FreeSWITCH uses for RTP media streams. Each active call consumes one or more ports from this range. Must be open on the firewall for media to flow.',
    notes:       'The range rtp-start-port to rtp-end-port must be open on both the server firewall and any intermediate NAT/PAT device. Minimum range of ~1000 ports recommended for production. Changing this requires a FreeSWITCH restart to take effect.',
    type:        'port',
    example:     '16384',
    defaultValue:     '16384',
    recommendedValue: '16384',
    visibility:  'basic',
    riskLevel:   'high',
    restartRequired: true,
    estimatedDowntime: 'Brief (FS restart required)',
    affectedServices:  ['RTP Media', 'ENRS ERS Conference', 'ENRS ENS Outbound'],
    aliases:          ['rtp port start', 'media port start', 'rtp low port', 'udp start port'],
    relatedVariables: ['rtp-end-port'],
  },

  'rtp-end-port': {
    category:    'RTP',
    group:       'Port Range',
    label:       'RTP End Port',
    description: 'Last UDP port in the RTP media port range.',
    purpose:     'Defines the upper bound of the UDP port range. The total number of allocatable RTP ports is (rtp-end-port − rtp-start-port + 1) / 2 per call (one send, one receive).',
    notes:       'Must be greater than rtp-start-port. The deployment validator enforces this. Large deployments supporting hundreds of simultaneous media streams need a wide range (e.g. 16384–32768 = 8192 ports = ~4096 concurrent streams).',
    type:        'port',
    example:     '32768',
    defaultValue:     '32768',
    recommendedValue: '32768',
    visibility:  'basic',
    riskLevel:   'high',
    restartRequired: true,
    estimatedDowntime: 'Brief (FS restart required)',
    affectedServices:  ['RTP Media', 'ENRS ERS Conference', 'ENRS ENS Outbound'],
    aliases:          ['rtp port end', 'media port end', 'rtp high port', 'udp end port'],
    relatedVariables: ['rtp-start-port'],
  },

  // ── RTP › Timeouts ───────────────────────────────────────────────────────

  'rtp-timeout-sec': {
    category:    'RTP',
    group:       'Timeouts',
    label:       'RTP Timeout (seconds)',
    description: 'Seconds of RTP silence before the stream is considered dead.',
    purpose:     'If no RTP packets are received on an active stream for this duration, FreeSWITCH considers the call dead and hangs it up. Prevents zombie calls from consuming resources when media stops flowing.',
    notes:       'Set too low on poor networks and legitimate calls may be dropped. Set too high and dead calls occupy resources. 300s (5 minutes) is a safe default for most deployments.',
    type:        'integer',
    min:         10,
    max:         86400,
    validation:  { min: 10, max: 86400 },
    example:     '300',
    defaultValue:     '300',
    recommendedValue: '300',
    visibility:  'advanced',
    riskLevel:   'low',
    restartRequired: false,
    estimatedDowntime: 'None',
    affectedServices:  ['RTP Media', 'ENRS ERS Conference'],
    aliases:          ['rtp dead timeout', 'media timeout', 'rtp silence timeout', 'call timeout'],
    relatedVariables: ['rtp-hold-timeout-sec'],
  },

  'rtp-hold-timeout-sec': {
    category:    'RTP',
    group:       'Timeouts',
    label:       'RTP Hold Timeout (seconds)',
    description: 'Seconds of RTP silence before a held call is considered abandoned.',
    purpose:     'Controls how long a call can remain on hold with no RTP activity before FreeSWITCH releases it. Held calls generate silence/comfort-noise rather than active media.',
    notes:       'Should be larger than rtp-timeout-sec since held calls intentionally have no active media. 1800s (30 minutes) allows legitimate long holds. Set lower in high-volume contact-centre deployments to reclaim channels.',
    type:        'integer',
    min:         30,
    max:         86400,
    validation:  { min: 30, max: 86400 },
    example:     '1800',
    defaultValue:     '1800',
    recommendedValue: '1800',
    visibility:  'advanced',
    riskLevel:   'low',
    restartRequired: false,
    affectedServices:  ['RTP Media'],
    aliases:          ['hold timeout', 'hold duration', 'rtp hold', 'on hold timeout'],
    relatedVariables: ['rtp-timeout-sec'],
  },

  // ── RTP › Binding ────────────────────────────────────────────────────────

  'rtp-ip': {
    category:    'RTP',
    group:       'Binding',
    label:       'RTP IP',
    description: 'IP address FreeSWITCH binds RTP media sockets to.',
    purpose:     'Specifies which local network interface FreeSWITCH uses when creating RTP sockets. On multi-homed servers, this ensures media is sent from the correct interface.',
    notes:       'Usually the same value as local_ip_v4 in vars.xml. Set explicitly on multi-homed servers to prevent media from egressing on the wrong interface. Most single-NIC deployments can leave this at the default auto-detected value.',
    type:        'ip',
    example:     '$${local_ip_v4}',
    defaultValue:     '$${local_ip_v4}',
    visibility:  'advanced',
    riskLevel:   'medium',
    restartRequired: true,
    estimatedDowntime: 'Brief (FS restart required)',
    affectedServices:  ['RTP Media', 'SIP Stack'],
    aliases:          ['rtp bind ip', 'media ip', 'rtp interface', 'rtp bind address'],
  },

  // ── Diagnostics ──────────────────────────────────────────────────────────

  'sip-trace': {
    category:    'Diagnostics',
    group:       'Tracing',
    label:       'SIP Trace',
    description: 'Log full SIP packet content at DEBUG level.',
    purpose:     'When enabled, FreeSWITCH logs the complete content of every SIP message (INVITE, ACK, BYE, etc.) to the console. Invaluable for diagnosing SIP registration and call signalling issues.',
    notes:       'NEVER enable in production — SIP trace logs contain credentials (passwords in SIP REGISTER) and generates extreme log volume. Enable only temporarily in development or for a specific troubleshooting session.',
    type:        'boolean',
    example:     'false',
    defaultValue:     'false',
    recommendedValue: 'false',
    visibility:  'expert',
    riskLevel:   'medium',
    restartRequired: false,
    affectedServices:  ['SIP Stack', 'FreeSWITCH Logging'],
    aliases:          ['sip debug', 'sip logging', 'sip packet trace', 'debug sip'],
  },

  // ── Telephony › DTMF ─────────────────────────────────────────────────────

  'min-dtmf-duration': {
    category:    'Telephony',
    group:       'DTMF',
    label:       'Min DTMF Duration (ms)',
    description: 'Minimum DTMF tone duration in milliseconds.',
    purpose:     'Clamps any DTMF tone shorter than this value to the minimum before playback. Prevents extremely short tones that some endpoints cannot reliably detect.',
    notes:       'RFC 4733 recommends a minimum of 100ms for reliable DTMF detection across PSTN and VoIP paths. Shorter values may cause missed digits on legacy analog equipment.',
    type:        'integer',
    min:         10,
    max:         2000,
    validation:  { min: 10, max: 2000 },
    example:     '400',
    defaultValue:     '400',
    recommendedValue: '400',
    visibility:  'expert',
    riskLevel:   'low',
    restartRequired: false,
    affectedServices:  ['DTMF Detection', 'ENRS IVR'],
    aliases:          ['dtmf min', 'minimum dtmf', 'dtmf floor'],
    relatedVariables: ['max-dtmf-duration', 'default-dtmf-duration'],
  },

  'max-dtmf-duration': {
    category:    'Telephony',
    group:       'DTMF',
    label:       'Max DTMF Duration (ms)',
    description: 'Maximum DTMF tone duration in milliseconds.',
    purpose:     'Clamps any DTMF tone longer than this value to the maximum. Prevents abnormally long tones from disrupting call flow or confusing DTMF collectors.',
    notes:       'Most endpoints generate DTMF tones in the 100–500ms range. Values above 2000ms are rarely needed.',
    type:        'integer',
    min:         100,
    max:         192000,
    validation:  { min: 100, max: 192000 },
    example:     '192000',
    defaultValue:     '192000',
    recommendedValue: '192000',
    visibility:  'expert',
    riskLevel:   'low',
    restartRequired: false,
    affectedServices:  ['DTMF Detection'],
    aliases:          ['dtmf max', 'maximum dtmf', 'dtmf ceiling'],
    relatedVariables: ['min-dtmf-duration', 'default-dtmf-duration'],
  },

  'default-dtmf-duration': {
    category:    'Telephony',
    group:       'DTMF',
    label:       'Default DTMF Duration (ms)',
    description: 'Default duration for generated DTMF tones in milliseconds.',
    purpose:     'The duration used when FreeSWITCH generates a DTMF tone (e.g. for outbound IVR navigation or tone injection). Must be within [min-dtmf-duration, max-dtmf-duration].',
    notes:       'Should fall between min-dtmf-duration and max-dtmf-duration. 2000ms (20 DTMF clock ticks) is a safe default that works on both PSTN and VoIP paths.',
    type:        'integer',
    min:         100,
    max:         192000,
    validation:  { min: 100, max: 192000 },
    example:     '2000',
    defaultValue:     '2000',
    recommendedValue: '2000',
    visibility:  'expert',
    riskLevel:   'low',
    restartRequired: false,
    affectedServices:  ['DTMF Generation', 'ENRS IVR'],
    aliases:          ['dtmf duration', 'default dtmf', 'dtmf length'],
    relatedVariables: ['min-dtmf-duration', 'max-dtmf-duration'],
  },

  // ── System › ESL Heartbeat ───────────────────────────────────────────────

  'event-heartbeat-interval': {
    category:    'System',
    group:       'ESL',
    label:       'ESL Heartbeat Interval (seconds)',
    description: 'Interval in seconds between HEARTBEAT events sent to ESL clients.',
    purpose:     'FreeSWITCH emits a HEARTBEAT event at this interval to all connected ESL clients. The ENRS backend uses heartbeats to detect ESL connection loss and trigger reconnection.',
    notes:       'Lower values allow faster detection of dropped ESL connections but add minor event processing overhead. The ENRS ESL service default reconnection logic expects heartbeats at 20–60s intervals.',
    type:        'integer',
    min:         1,
    max:         3600,
    validation:  { min: 1, max: 3600 },
    example:     '20',
    defaultValue:     '20',
    recommendedValue: '20',
    visibility:  'advanced',
    riskLevel:   'low',
    restartRequired: false,
    affectedServices:  ['ESL Connection', 'ENRS Backend'],
    aliases:          ['heartbeat interval', 'esl heartbeat', 'keepalive interval', 'fs heartbeat'],
    usedBy:           ['ENRS ESL Service'],
  },

  // ── System › Database ────────────────────────────────────────────────────

  'db-handle-timeout': {
    category:    'System',
    group:       'Database',
    label:       'DB Handle Timeout (seconds)',
    description: 'Seconds before a database handle acquisition times out.',
    purpose:     'Controls how long FreeSWITCH waits when requesting a database connection from its internal pool before declaring a timeout error. Affects the core SQLite/ODBC connection pool.',
    notes:       'Increase if FreeSWITCH logs database handle timeout errors under high call volume. The default of 500 seconds is deliberately generous to avoid false timeouts on busy systems.',
    type:        'integer',
    min:         1,
    max:         3600,
    validation:  { min: 1, max: 3600 },
    example:     '500',
    defaultValue:     '500',
    recommendedValue: '500',
    visibility:  'expert',
    riskLevel:   'low',
    restartRequired: false,
    affectedServices:  ['FreeSWITCH Core', 'Internal DB Pool'],
    aliases:          ['database timeout', 'db timeout', 'handle timeout'],
  },

  // ── System › Language ────────────────────────────────────────────────────

  'default-language': {
    category:    'System',
    group:       'Locale',
    label:       'Default Language',
    description: 'Default language code for TTS and prompt selection.',
    purpose:     'Sets the default language used by FreeSWITCH TTS engines and the sound file selection logic. Affects which audio prompt sub-directory is used when no explicit language is specified.',
    notes:       'Must match a language supported by the configured TTS engine and the installed sound pack. For ENRS, TTS language is typically configured per-flow in the IVR builder.',
    type:        'string',
    example:     'en',
    defaultValue:     'en',
    recommendedValue: 'en',
    visibility:  'advanced',
    riskLevel:   'low',
    restartRequired: false,
    affectedServices:  ['TTS', 'IVR Prompts'],
    aliases:          ['language', 'tts language', 'locale', 'speech language'],
  },
};

// ── Lookup ────────────────────────────────────────────────────────────────────

/**
 * Return the complete ConfigurationEntry for a switch.conf.xml param.
 *
 * Always returns a normalised ConfigurationEntry via applyMetaDefaults().
 * Unknown params receive a synthesised generic entry.
 *
 * @param {string} key   — param name attribute value (e.g. 'loglevel')
 * @returns {object}     — ConfigurationEntry fields + { metadata: ConfigurationEntry }
 */
export function lookupParam(key) {
  const raw = switchCatalog[key] ?? {
    category:    'Other',
    label:       key,
    description: 'Custom parameter — not in the catalog. Read/write/toggle is fully supported.',
    type:        'string',
    visibility:  'advanced',
    notes:       'This parameter exists in switch.conf.xml but has no catalog entry. It may be a custom or module-specific parameter.',
  };

  const meta = applyMetaDefaults(raw);
  return { ...meta, metadata: meta };
}

/** All distinct categories in the catalog, in definition order. */
export const switchCategories = [
  ...new Set(Object.values(switchCatalog).map(e => e.category)),
];
