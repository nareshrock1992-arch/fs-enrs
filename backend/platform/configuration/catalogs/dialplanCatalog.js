/**
 * dialplanCatalog — metadata for FreeSWITCH dialplan applications and condition fields.
 *
 * Consumed by:
 *  - DialplanFileProvider.validate()   (Phase 4) — semantic validation
 *  - Frontend action editors           (Phase 7) — labels, placeholders, help text
 *  - Search indexer                    (Phase 7) — category grouping
 *
 * Shape differs from flat-param catalogs (ConfigurationEntry) — do not import
 * applyMetaDefaults. This catalog works with AppEntry and FieldEntry shapes only.
 *
 * Coverage is intentionally selective. Unknown applications/fields degrade
 * gracefully via the fallback objects returned by the lookup functions.
 * Add entries here as new modules require them — no framework changes needed.
 *
 * @typedef {object} AppEntry
 * @property {string}   label            — Human-readable application name
 * @property {string}   description      — What the application does
 * @property {string}   category         — Grouping for UI pickers and search
 * @property {string}   tooltip          — Compact one-line help (≤ 120 chars)
 * @property {boolean}  dataRequired     — Whether the data argument is mandatory
 * @property {string}   dataDescription  — Description of the data argument
 * @property {string}   dataPlaceholder  — UI placeholder for the data input
 * @property {string[]} dataExamples     — Concrete example data values
 * @property {'low'|'medium'|'high'} riskLevel — Deployment risk classification
 * @property {boolean}  deprecated       — True if this application should be avoided
 * @property {string|null} replacedBy    — Replacement application name (if deprecated)
 *
 * @typedef {object} FieldEntry
 * @property {string}   label       — Human-readable field name
 * @property {string}   description — What this condition field matches
 * @property {string}   category    — Grouping (Routing, Identity, SIP, Time, etc.)
 * @property {string[]} examples    — Example values / expressions
 */

// ── Application Catalog ───────────────────────────────────────────────────────

/**
 * @type {Record<string, AppEntry>}
 */
const APPLICATIONS = {

  // ── Core Routing ─────────────────────────────────────────────────────────────

  answer: {
    label:           'Answer',
    description:     'Answers an incoming call, completing the SIP handshake. '
                   + 'Must be called before playing audio or reading DTMF on inbound legs.',
    category:        'Call Control',
    tooltip:         'Answer the call. Required before playback or DTMF on inbound calls.',
    dataRequired:    false,
    dataDescription: 'Optional: ring delay in milliseconds before answering.',
    dataPlaceholder: '500',
    dataExamples:    ['', '1000'],
    riskLevel:       'low',
    deprecated:      false,
    replacedBy:      null,
  },

  bridge: {
    label:           'Bridge',
    description:     'Bridges the current leg to a destination endpoint. '
                   + 'Supports SIP URIs, gateway dial strings, and channel group targets. '
                   + 'The call continues until the bridge leg hangs up or the call times out.',
    category:        'Call Control',
    tooltip:         'Bridge to an endpoint. Data = dial string (e.g. sofia/gateway/gw1/5551234).',
    dataRequired:    true,
    dataDescription: 'Dial string identifying the target endpoint.',
    dataPlaceholder: 'sofia/gateway/my-gateway/15551234567',
    dataExamples:    [
      'sofia/gateway/my-gateway/15551234567',
      'sofia/internal/1001@${domain_name}',
      'user/1001',
    ],
    riskLevel:       'medium',
    deprecated:      false,
    replacedBy:      null,
  },

  transfer: {
    label:           'Transfer',
    description:     'Transfers the call to another extension, optionally in a different '
                   + 'dialplan context. Ends the current extension execution and re-enters '
                   + 'the dialplan at the target extension.',
    category:        'Call Control',
    tooltip:         'Transfer to extension. Data = "extension [XML] [context]".',
    dataRequired:    true,
    dataDescription: 'Target extension, optional dialplan type, optional context.',
    dataPlaceholder: '5000 XML default',
    dataExamples:    ['5000', '5000 XML default', '5000 XML sales'],
    riskLevel:       'medium',
    deprecated:      false,
    replacedBy:      null,
  },

  execute_extension: {
    label:           'Execute Extension',
    description:     'Executes another extension in-line without ending the current call flow. '
                   + 'Returns to the current extension after the target extension completes. '
                   + 'Useful for common sub-routines (logging, tagging, etc.).',
    category:        'Call Control',
    tooltip:         'Run another extension then return. Data = "extension [context]".',
    dataRequired:    true,
    dataDescription: 'Extension to execute, with optional context.',
    dataPlaceholder: 'common_log XML default',
    dataExamples:    ['common_log', 'tag_inbound XML default'],
    riskLevel:       'low',
    deprecated:      false,
    replacedBy:      null,
  },

  hangup: {
    label:           'Hangup',
    description:     'Terminates the call with an optional SIP/Q.850 cause code. '
                   + 'If no cause is supplied FreeSWITCH uses NORMAL_CLEARING.',
    category:        'Call Control',
    tooltip:         'Hang up the call. Optional cause: NORMAL_CLEARING, USER_BUSY, etc.',
    dataRequired:    false,
    dataDescription: 'Optional SIP/Q.850 hangup cause code.',
    dataPlaceholder: 'NORMAL_CLEARING',
    dataExamples:    ['', 'NORMAL_CLEARING', 'USER_BUSY', 'NO_ANSWER', 'CALL_REJECTED'],
    riskLevel:       'medium',
    deprecated:      false,
    replacedBy:      null,
  },

  park: {
    label:           'Park',
    description:     'Parks the call in a parking lot. The caller hears hold music until '
                   + 'another party retrieves the call with unpark.',
    category:        'Call Control',
    tooltip:         'Park the call. Optional lot name or number.',
    dataRequired:    false,
    dataDescription: 'Optional parking lot identifier.',
    dataPlaceholder: 'my_lot',
    dataExamples:    ['', 'my_lot', '100'],
    riskLevel:       'low',
    deprecated:      false,
    replacedBy:      null,
  },

  // ── Variables ─────────────────────────────────────────────────────────────────

  set: {
    label:           'Set Variable',
    description:     'Sets a channel variable on the current leg. The variable is available '
                   + 'for the remainder of the call in this context.',
    category:        'Variables',
    tooltip:         'Set a channel variable. Data = "variable_name=value".',
    dataRequired:    true,
    dataDescription: 'Variable assignment in the form variable_name=value.',
    dataPlaceholder: 'my_variable=my_value',
    dataExamples:    [
      'effective_caller_id_name=Support',
      'record_session=true',
      'ringback=${us-ring}',
    ],
    riskLevel:       'low',
    deprecated:      false,
    replacedBy:      null,
  },

  unset: {
    label:           'Unset Variable',
    description:     'Removes a channel variable from the current leg. '
                   + 'Reading the variable after unset returns an empty string.',
    category:        'Variables',
    tooltip:         'Remove a channel variable. Data = variable name.',
    dataRequired:    true,
    dataDescription: 'Name of the channel variable to remove.',
    dataPlaceholder: 'my_variable',
    dataExamples:    ['my_variable', 'effective_caller_id_name'],
    riskLevel:       'low',
    deprecated:      false,
    replacedBy:      null,
  },

  export: {
    label:           'Export Variable',
    description:     'Sets a channel variable that will be copied to the B-leg when '
                   + 'the call is bridged. Equivalent to set + setting nolocal:variable on bridge.',
    category:        'Variables',
    tooltip:         'Set a variable that persists across bridge. Data = "var=value".',
    dataRequired:    true,
    dataDescription: 'Variable assignment in the form variable_name=value.',
    dataPlaceholder: 'sip_h_X-Custom-Header=value',
    dataExamples:    [
      'sip_h_X-Custom-Header=value',
      'nolocal:effective_caller_id_name=Support',
    ],
    riskLevel:       'low',
    deprecated:      false,
    replacedBy:      null,
  },

  multiset: {
    label:           'Set Multiple Variables',
    description:     'Sets multiple channel variables in a single action. '
                   + 'Space-separated assignments. More efficient than multiple set actions.',
    category:        'Variables',
    tooltip:         'Set multiple variables at once. Data = space-separated var=val pairs.',
    dataRequired:    true,
    dataDescription: 'Space-separated variable assignments.',
    dataPlaceholder: 'var1=value1 var2=value2',
    dataExamples:    [
      'var1=value1 var2=value2',
      'effective_caller_id_name=Support effective_caller_id_number=5000',
    ],
    riskLevel:       'low',
    deprecated:      false,
    replacedBy:      null,
  },

  // ── Media ─────────────────────────────────────────────────────────────────────

  playback: {
    label:           'Playback',
    description:     'Plays an audio file to the caller. Supports local files, remote HTTP '
                   + 'streams, and FreeSWITCH tone strings. The action blocks until '
                   + 'the file finishes unless interrupted by DTMF.',
    category:        'Media',
    tooltip:         'Play an audio file. Data = file path or tone string.',
    dataRequired:    true,
    dataDescription: 'Path to the audio file or tone description.',
    dataPlaceholder: '/sounds/welcome.wav',
    dataExamples:    [
      '/usr/share/freeswitch/sounds/en/us/callie/misc/8000/please_hold.wav',
      'tone_stream://%(2000,4000,440,480)',
      'http://example.com/hold.wav',
    ],
    riskLevel:       'low',
    deprecated:      false,
    replacedBy:      null,
  },

  record: {
    label:           'Record',
    description:     'Records audio from the caller into a file. Data specifies the '
                   + 'file path, optional max seconds, silence threshold, and silence hits.',
    category:        'Media',
    tooltip:         'Record caller audio to a file.',
    dataRequired:    true,
    dataDescription: 'File path and optional recording parameters.',
    dataPlaceholder: '/recordings/${uuid}.wav',
    dataExamples:    [
      '/recordings/${uuid}.wav',
      '/recordings/${uuid}.wav 60 200 3',
    ],
    riskLevel:       'low',
    deprecated:      false,
    replacedBy:      null,
  },

  record_session: {
    label:           'Record Session',
    description:     'Records the entire call session (both legs) from this point forward. '
                   + 'Unlike record, this captures both sides of the conversation after '
                   + 'the bridge is established.',
    category:        'Media',
    tooltip:         'Record the full session (both legs). Data = file path.',
    dataRequired:    true,
    dataDescription: 'File path for the session recording.',
    dataPlaceholder: '/recordings/${uuid}.wav',
    dataExamples:    ['/recordings/${uuid}.wav', '/recordings/${strftime(%Y%m%d)}/${uuid}.mp3'],
    riskLevel:       'low',
    deprecated:      false,
    replacedBy:      null,
  },

  say: {
    label:           'Say',
    description:     'Speaks information using pre-recorded phrase components. '
                   + 'Supports numbers, dates, times, money, and spell-out. '
                   + 'Requires the say module for the target language.',
    category:        'Media',
    tooltip:         'Speak structured content using phrase files. Data = "module lang type subtype value".',
    dataRequired:    true,
    dataDescription: 'Space-separated: module language say-type say-subtype value.',
    dataPlaceholder: 'en number iterated 12345',
    dataExamples:    [
      'en number iterated 12345',
      'en time general ${epoch}',
      'en money pronounced 15.50',
    ],
    riskLevel:       'low',
    deprecated:      false,
    replacedBy:      null,
  },

  speak: {
    label:           'Speak (TTS)',
    description:     'Synthesises speech from text using a TTS engine. '
                   + 'Data format depends on the engine. Most engines accept '
                   + '"engine|voice|text" or just "text" when defaults are configured.',
    category:        'Media',
    tooltip:         'Text-to-speech. Data = "engine|voice|text" or just text.',
    dataRequired:    true,
    dataDescription: 'TTS engine, voice, and text. Format depends on the configured TTS module.',
    dataPlaceholder: 'flite|kal|Welcome to the system.',
    dataExamples:    [
      'flite|kal|Welcome to the system.',
      'cepstral|David|Your call is being connected.',
      'Your call is important to us.',
    ],
    riskLevel:       'low',
    deprecated:      false,
    replacedBy:      null,
  },

  // ── IVR ───────────────────────────────────────────────────────────────────────

  lua: {
    label:           'Lua Script',
    description:     'Executes a Lua script within the call session. The script has '
                   + 'full access to the FreeSWITCH session API. Commonly used for '
                   + 'database lookups, dynamic routing, and complex IVR logic.',
    category:        'Scripting',
    tooltip:         'Run a Lua script. Data = script path and optional arguments.',
    dataRequired:    true,
    dataDescription: 'Path to the Lua script file, followed by optional arguments.',
    dataPlaceholder: 'my_script.lua arg1 arg2',
    dataExamples:    ['router.lua', 'ivr_menu.lua', 'db_lookup.lua ${destination_number}'],
    riskLevel:       'medium',
    deprecated:      false,
    replacedBy:      null,
  },

  socket: {
    label:           'ESL Socket',
    description:     'Connects the call to an external socket application via the '
                   + 'Event Socket Library. The external app takes full control of '
                   + 'the session until it releases it.',
    category:        'Scripting',
    tooltip:         'Hand off call to an external socket app. Data = "host:port [async|full]".',
    dataRequired:    true,
    dataDescription: 'Socket address with optional mode flag.',
    dataPlaceholder: '127.0.0.1:8084 async full',
    dataExamples:    ['127.0.0.1:8084', '127.0.0.1:8084 async full'],
    riskLevel:       'medium',
    deprecated:      false,
    replacedBy:      null,
  },

  play_and_get_digits: {
    label:           'Play and Get Digits',
    description:     'Plays a prompt and collects DTMF input from the caller. '
                   + 'Stores the result in a channel variable. Retries on timeout or '
                   + 'invalid input up to the configured maximum attempts.',
    category:        'IVR',
    tooltip:         'Play prompt and collect DTMF. See docs for full parameter syntax.',
    dataRequired:    true,
    dataDescription: 'min max tries timeout terminators file var-name invalid-file regex',
    dataPlaceholder: '1 11 3 5000 # prompt.wav result invalid.wav \\d+',
    dataExamples:    [
      '1 11 3 5000 # ivr/enter_account.wav account_number ivr/invalid.wav \\d+',
      '1 1 3 3000 # ivr/press_1.wav menu_choice ivr/invalid.wav [12]',
    ],
    riskLevel:       'low',
    deprecated:      false,
    replacedBy:      null,
  },

  // ── Conference ────────────────────────────────────────────────────────────────

  conference: {
    label:           'Conference',
    description:     'Drops the caller into a conference room. The room is created if it '
                   + 'does not exist. Requires mod_conference. The profile determines '
                   + 'codec, pin, max members, and other room settings.',
    category:        'Conference',
    tooltip:         'Join a conference room. Data = "room-name@profile" or "room+pin@profile".',
    dataRequired:    true,
    dataDescription: 'Conference room name and optional profile.',
    dataPlaceholder: 'my_room@default',
    dataExamples:    [
      'my_room@default',
      'my_room+1234@default',
      '${caller_id_number}@default',
    ],
    riskLevel:       'low',
    deprecated:      false,
    replacedBy:      null,
  },

  // ── Logging ───────────────────────────────────────────────────────────────────

  log: {
    label:           'Log',
    description:     'Writes a message to the FreeSWITCH log at the specified severity level. '
                   + 'Useful for debugging and operational event capture.',
    category:        'Logging',
    tooltip:         'Write to the FS log. Data = "LEVEL message".',
    dataRequired:    true,
    dataDescription: 'Log level followed by the message text.',
    dataPlaceholder: 'INFO Call from ${caller_id_number}',
    dataExamples:    [
      'INFO Inbound call: ${destination_number}',
      'WARNING Unexpected destination: ${destination_number}',
      'DEBUG Variables: ${variable_name}',
    ],
    riskLevel:       'low',
    deprecated:      false,
    replacedBy:      null,
  },
};

// ── Condition Field Catalog ───────────────────────────────────────────────────

/**
 * @type {Record<string, FieldEntry>}
 */
const FIELDS = {

  // ── Routing ───────────────────────────────────────────────────────────────────

  destination_number: {
    label:       'Destination Number',
    description: 'The number or URI the caller dialled. The most commonly matched field '
               + 'in routing extensions. Matched against the expression as a regex.',
    category:    'Routing',
    examples:    ['^5\\d{3}$', '^(\\+1)?2125551234$', '^(sales|support)$'],
  },

  context: {
    label:       'Context',
    description: 'The dialplan context this call is currently executing in. '
               + 'Useful for context-aware routing.',
    category:    'Routing',
    examples:    ['default', 'public', 'sales'],
  },

  // ── Identity ──────────────────────────────────────────────────────────────────

  caller_id_number: {
    label:       'Caller ID Number',
    description: "The caller's reported number (ANI). May differ from the actual originating "
               + 'number if the caller or carrier has overridden it.',
    category:    'Identity',
    examples:    ['^\\+1212', '^5551\\d{6}$', '^$'],
  },

  caller_id_name: {
    label:       'Caller ID Name',
    description: "The caller's reported name. Typically supplied by the carrier. "
               + 'May be empty or absent.',
    category:    'Identity',
    examples:    ['ACME Corp', '^TOLL FREE', 'UNAVAILABLE'],
  },

  username: {
    label:       'Username',
    description: 'The authenticated username of the SIP endpoint. Only populated for '
               + 'calls from registered users — not available for PSTN or unauthenticated calls.',
    category:    'Identity',
    examples:    ['1001', 'alice', 'support_agent'],
  },

  // ── Network ───────────────────────────────────────────────────────────────────

  network_addr: {
    label:       'Network Address',
    description: 'The IP address of the remote SIP peer. Useful for access-control '
               + 'rules that restrict routing based on originating network.',
    category:    'Network',
    examples:    ['^10\\.0\\.0\\.', '^192\\.168\\.', '^172\\.16\\.'],
  },

  sip_from_host: {
    label:       'SIP From Host',
    description: 'The host portion of the SIP From header URI. Matches the domain '
               + 'reported by the originating UA — can differ from network_addr.',
    category:    'SIP',
    examples:    ['sip.example.com', 'pbx.customer.org', '^10\\.'],
  },

  sip_to_host: {
    label:       'SIP To Host',
    description: 'The host portion of the SIP To header URI. Matches the domain '
               + 'the caller was trying to reach.',
    category:    'SIP',
    examples:    ['my-domain.com', 'pbx.example.com'],
  },
};

// ── Lookup functions ──────────────────────────────────────────────────────────

/**
 * Look up metadata for a dialplan application by name.
 * Always returns a complete AppEntry — never throws, never returns null.
 * Unknown applications receive a generic fallback with category 'Unknown'.
 *
 * @param {string} name — application attribute value (e.g. 'bridge', 'lua')
 * @returns {AppEntry & { name: string }}
 */
export function lookupApplication(name) {
  const entry = APPLICATIONS[name];
  if (entry) return { ...entry, name };
  return {
    name,
    label:           name,
    description:     `FreeSWITCH application '${name}'.`,
    category:        'Unknown',
    tooltip:         '',
    dataRequired:    false,
    dataDescription: 'Application data argument.',
    dataPlaceholder: '',
    dataExamples:    [],
    riskLevel:       'low',
    deprecated:      false,
    replacedBy:      null,
  };
}

/**
 * Look up metadata for a condition field by name.
 * Always returns a complete FieldEntry — never throws, never returns null.
 * Unknown fields receive a generic fallback with category 'Unknown'.
 *
 * @param {string} name — condition field attribute value (e.g. 'destination_number')
 * @returns {FieldEntry & { name: string }}
 */
export function lookupField(name) {
  const entry = FIELDS[name];
  if (entry) return { ...entry, name };
  return {
    name,
    label:       name,
    description: `FreeSWITCH channel variable or condition field '${name}'.`,
    category:    'Unknown',
    examples:    [],
  };
}

/**
 * Return all catalogued applications grouped by category.
 * Suitable for building category-grouped application pickers in the UI.
 *
 * @returns {Record<string, Array<AppEntry & { name: string }>>}
 */
export function applicationsByCategory() {
  const result = {};
  for (const [name, entry] of Object.entries(APPLICATIONS)) {
    const { category } = entry;
    if (!result[category]) result[category] = [];
    result[category].push({ ...entry, name });
  }
  return result;
}

/**
 * Return all catalogued fields grouped by category.
 *
 * @returns {Record<string, Array<FieldEntry & { name: string }>>}
 */
export function fieldsByCategory() {
  const result = {};
  for (const [name, entry] of Object.entries(FIELDS)) {
    const { category } = entry;
    if (!result[category]) result[category] = [];
    result[category].push({ ...entry, name });
  }
  return result;
}

/**
 * Return the names of all catalogued applications.
 * Used by validation to distinguish "known unknown" from "unknown unknown".
 *
 * @returns {string[]}
 */
export function knownApplicationNames() {
  return Object.keys(APPLICATIONS);
}

/**
 * Return the names of all catalogued condition fields.
 *
 * @returns {string[]}
 */
export function knownFieldNames() {
  return Object.keys(FIELDS);
}
