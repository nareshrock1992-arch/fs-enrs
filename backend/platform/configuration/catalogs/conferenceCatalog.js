import { applyMetaDefaults } from '../metadata/metadataSchema.js';

/**
 * conferenceCatalog — metadata for conference.conf.xml profile parameters.
 *
 * Keys are param names only (without the profile prefix).
 * lookupConferenceParam(key) accepts both plain param names and compound
 * 'profileName___paramName' keys — it strips the profile prefix automatically.
 */

const SEP = '___';

const conferenceCatalog = {
  // ── Identity / Presence ───────────────────────────────────────────────────
  domain: {
    category:    'Identity',
    label:       'Domain',
    description: 'SIP domain for conference presence advertisements.',
    type:        'string',
    visibility:  'standard',
    restartRequired: false,
  },
  'caller-id-name': {
    category:    'Identity',
    label:       'Caller ID Name',
    description: 'Default caller ID name for outbound conference calls.',
    type:        'string',
    visibility:  'standard',
    restartRequired: false,
  },
  'caller-id-number': {
    category:    'Identity',
    label:       'Caller ID Number',
    description: 'Default caller ID number for outbound conference calls.',
    type:        'string',
    visibility:  'standard',
    restartRequired: false,
  },

  // ── Audio ─────────────────────────────────────────────────────────────────
  rate: {
    category:    'Audio',
    label:       'Sample Rate (Hz)',
    description: 'Audio sample rate in Hz. Common values: 8000 (narrowband), 16000 (wideband), 32000 (ultrawideband), 48000 (CD quality).',
    type:        'integer',
    visibility:  'standard',
    restartRequired: false,
    validation:  { min: 8000, max: 48000 },
  },
  interval: {
    category:    'Audio',
    label:       'Frame Interval (ms)',
    description: 'Number of milliseconds per audio frame. Default is 20ms.',
    type:        'integer',
    visibility:  'standard',
    restartRequired: false,
    validation:  { min: 10, max: 60 },
  },
  'energy-level': {
    category:    'Audio',
    label:       'Energy Level (VAD)',
    description: 'Voice activity detection threshold. Audio below this level is treated as silence. Range 0–1800; higher values require louder audio to be transmitted.',
    type:        'integer',
    visibility:  'standard',
    restartRequired: false,
    validation:  { min: 0, max: 1800 },
  },
  'comfort-noise': {
    category:    'Audio',
    label:       'Comfort Noise',
    description: 'Generate comfort noise during silence to avoid dead air for participants.',
    type:        'boolean',
    visibility:  'standard',
    restartRequired: false,
  },
  channels: {
    category:    'Audio',
    label:       'Channels',
    description: 'Number of audio channels. 1 = mono, 2 = stereo. Stereo requires a codec that supports it.',
    type:        'integer',
    visibility:  'advanced',
    restartRequired: false,
    validation:  { min: 1, max: 2 },
  },

  // ── Sound Files ───────────────────────────────────────────────────────────
  'muted-sound': {
    category:    'Sound Files',
    label:       'Muted Sound',
    description: 'Audio file played to a participant when they are muted.',
    type:        'string',
    visibility:  'standard',
    restartRequired: false,
  },
  'unmuted-sound': {
    category:    'Sound Files',
    label:       'Unmuted Sound',
    description: 'Audio file played to a participant when they are unmuted.',
    type:        'string',
    visibility:  'standard',
    restartRequired: false,
  },
  'alone-sound': {
    category:    'Sound Files',
    label:       'Alone Sound',
    description: 'Audio file played when a participant is alone in the conference.',
    type:        'string',
    visibility:  'standard',
    restartRequired: false,
  },
  'moh-sound': {
    category:    'Sound Files',
    label:       'Music on Hold',
    description: 'Audio file or stream played as music on hold when alone. Use "silence" to disable.',
    type:        'string',
    visibility:  'standard',
    restartRequired: false,
  },
  'enter-sound': {
    category:    'Sound Files',
    label:       'Enter Sound',
    description: 'Audio played to all participants when someone joins the conference.',
    type:        'string',
    visibility:  'standard',
    restartRequired: false,
  },
  'exit-sound': {
    category:    'Sound Files',
    label:       'Exit Sound',
    description: 'Audio played to all participants when someone leaves the conference.',
    type:        'string',
    visibility:  'standard',
    restartRequired: false,
  },
  'kicked-sound': {
    category:    'Sound Files',
    label:       'Kicked Sound',
    description: 'Audio played to a participant when they are ejected from the conference.',
    type:        'string',
    visibility:  'standard',
    restartRequired: false,
  },
  'locked-sound': {
    category:    'Sound Files',
    label:       'Locked Sound',
    description: 'Audio played when the conference is locked.',
    type:        'string',
    visibility:  'standard',
    restartRequired: false,
  },
  'is-locked-sound': {
    category:    'Sound Files',
    label:       'Is-Locked Sound',
    description: 'Audio played when a caller tries to join a locked conference.',
    type:        'string',
    visibility:  'standard',
    restartRequired: false,
  },
  'is-unlocked-sound': {
    category:    'Sound Files',
    label:       'Is-Unlocked Sound',
    description: 'Audio played when the conference is unlocked during a call.',
    type:        'string',
    visibility:  'standard',
    restartRequired: false,
  },
  'pin-sound': {
    category:    'Sound Files',
    label:       'PIN Prompt Sound',
    description: 'Audio file prompting participants to enter the conference PIN.',
    type:        'string',
    visibility:  'standard',
    restartRequired: false,
  },
  'bad-pin-sound': {
    category:    'Sound Files',
    label:       'Bad PIN Sound',
    description: 'Audio played when a participant enters an incorrect PIN.',
    type:        'string',
    visibility:  'standard',
    restartRequired: false,
  },
  'ack-sound': {
    category:    'Sound Files',
    label:       'Acknowledge Sound',
    description: 'Audio played to acknowledge a successful action.',
    type:        'string',
    visibility:  'advanced',
    restartRequired: false,
  },
  'nack-sound': {
    category:    'Sound Files',
    label:       'Negative Acknowledge Sound',
    description: 'Audio played to acknowledge a failed action.',
    type:        'string',
    visibility:  'advanced',
    restartRequired: false,
  },
  'perpetual-sound': {
    category:    'Sound Files',
    label:       'Perpetual Sound',
    description: 'Audio file played endlessly, preventing anyone from talking.',
    type:        'string',
    visibility:  'advanced',
    restartRequired: false,
  },
  'sound-prefix': {
    category:    'Sound Files',
    label:       'Sound Prefix Path',
    description: 'Override the base path for relative sound file references. Defaults to the first caller\'s sound_prefix.',
    type:        'string',
    visibility:  'advanced',
    restartRequired: false,
  },
  'auto-record': {
    category:    'Sound Files',
    label:       'Auto-Record Path',
    description: 'When set, automatically records every conference to this path. Supports strftime patterns and conference_name variable.',
    type:        'string',
    visibility:  'advanced',
    restartRequired: false,
  },
  'cdr-log-dir': {
    category:    'Sound Files',
    label:       'CDR Log Directory',
    description: 'Directory for conference CDR files. "auto" = $PREFIX/logs/conference_cdr/. Relative paths are under $PREFIX/logs/.',
    type:        'string',
    visibility:  'advanced',
    restartRequired: false,
  },

  // ── Security / PIN ────────────────────────────────────────────────────────
  pin: {
    category:    'Security',
    label:       'Conference PIN',
    description: 'PIN required to join this conference profile. Leave unset for no PIN.',
    type:        'string',
    visibility:  'standard',
    restartRequired: false,
  },
  'moderator-pin': {
    category:    'Security',
    label:       'Moderator PIN',
    description: 'Separate PIN that grants moderator role to the caller.',
    type:        'string',
    visibility:  'standard',
    restartRequired: false,
  },
  'pin-retries': {
    category:    'Security',
    label:       'PIN Retry Limit',
    description: 'Maximum number of times a caller can re-enter an incorrect PIN before being disconnected.',
    type:        'integer',
    visibility:  'standard',
    restartRequired: false,
    validation:  { min: 1, max: 10 },
  },

  // ── Behavior / Flags ──────────────────────────────────────────────────────
  'member-flags': {
    category:    'Behavior',
    label:       'Member Flags',
    description: 'Pipe-delimited flags applied to every conference member. Options: waste, mute, deaf, dist-dtmf.',
    type:        'string',
    visibility:  'advanced',
    restartRequired: false,
  },
  'conference-flags': {
    category:    'Behavior',
    label:       'Conference Flags',
    description: 'Pipe-delimited flags controlling conference behaviour. Common: audio-always, livearray-sync, wait-mod, video-floor-only, rfc-4579.',
    type:        'string',
    visibility:  'advanced',
    restartRequired: false,
  },
  'caller-controls': {
    category:    'Behavior',
    label:       'Caller Controls Group',
    description: 'Name of the caller-controls group to use for DTMF key bindings. Use "none" to disable.',
    type:        'string',
    visibility:  'advanced',
    restartRequired: false,
  },
  'moderator-controls': {
    category:    'Behavior',
    label:       'Moderator Controls Group',
    description: 'Name of the caller-controls group for moderators.',
    type:        'string',
    visibility:  'advanced',
    restartRequired: false,
  },
  'suppress-events': {
    category:    'Behavior',
    label:       'Suppress Events',
    description: 'Comma-delimited list of conference events to suppress, e.g. start-talking,stop-talking.',
    type:        'string',
    visibility:  'advanced',
    restartRequired: false,
  },
  'ivr-dtmf-timeout': {
    category:    'Behavior',
    label:       'IVR DTMF Timeout (ms)',
    description: 'Milliseconds to wait between DTMF digits for caller-control matching.',
    type:        'integer',
    visibility:  'advanced',
    restartRequired: false,
    validation:  { min: 100, max: 5000 },
  },
  'ivr-input-timeout': {
    category:    'Behavior',
    label:       'IVR Input Timeout (ms)',
    description: 'Milliseconds to wait for the first DTMF. 0 = wait forever.',
    type:        'integer',
    visibility:  'advanced',
    restartRequired: false,
    validation:  { min: 0, max: 60000 },
  },
  'endconf-grace-time': {
    category:    'Behavior',
    label:       'End Conference Grace Time (s)',
    description: 'Seconds to wait before terminating an empty conference.',
    type:        'integer',
    visibility:  'advanced',
    restartRequired: false,
    validation:  { min: 0, max: 3600 },
  },

  // ── TTS ───────────────────────────────────────────────────────────────────
  'tts-engine': {
    category:    'TTS',
    label:       'TTS Engine',
    description: 'Text-to-speech engine for sound params prefixed with "say:". e.g. flite, cepstral.',
    type:        'string',
    visibility:  'advanced',
    restartRequired: false,
  },
  'tts-voice': {
    category:    'TTS',
    label:       'TTS Voice',
    description: 'Voice name for the configured TTS engine.',
    type:        'string',
    visibility:  'advanced',
    restartRequired: false,
  },

  // ── Video ─────────────────────────────────────────────────────────────────
  'video-mode': {
    category:    'Video',
    label:       'Video Mode',
    description: 'MCU video mixing mode. "mux" = composite layout; "passthrough" = unmodified.',
    type:        'string',
    visibility:  'advanced',
    restartRequired: false,
  },
  'video-layout-name': {
    category:    'Video',
    label:       'Video Layout',
    description: 'Named layout for MCU video mixing, e.g. "3x3" or "group:grid". Multiple values select fallback layouts.',
    type:        'string',
    visibility:  'advanced',
    restartRequired: false,
  },
  'video-canvas-size': {
    category:    'Video',
    label:       'Video Canvas Size',
    description: 'Composite video canvas resolution, e.g. "1920x1080", "1280x720", "640x480".',
    type:        'string',
    visibility:  'advanced',
    restartRequired: false,
  },
  'video-canvas-bgcolor': {
    category:    'Video',
    label:       'Canvas Background Colour',
    description: 'Background colour of the MCU video canvas in #RRGGBB hex format.',
    type:        'string',
    visibility:  'advanced',
    restartRequired: false,
  },
  'video-layout-bgcolor': {
    category:    'Video',
    label:       'Layout Background Colour',
    description: 'Background colour of unused regions in the video layout in #RRGGBB hex format.',
    type:        'string',
    visibility:  'advanced',
    restartRequired: false,
  },
  'video-codec-bandwidth': {
    category:    'Video',
    label:       'Video Codec Bandwidth',
    description: 'Target video codec bandwidth, e.g. "2mb", "3mb". Controls MCU encoding quality.',
    type:        'string',
    visibility:  'advanced',
    restartRequired: false,
  },
  'video-fps': {
    category:    'Video',
    label:       'Video Frame Rate (fps)',
    description: 'Frames per second for MCU video encoding.',
    type:        'integer',
    visibility:  'advanced',
    restartRequired: false,
    validation:  { min: 1, max: 60 },
  },
  'video-auto-floor-msec': {
    category:    'Video',
    label:       'Video Auto-Floor Delay (ms)',
    description: 'Milliseconds of audio activity before a member is automatically given the video floor.',
    type:        'integer',
    visibility:  'advanced',
    restartRequired: false,
    validation:  { min: 0, max: 10000 },
  },
};

export const conferenceCategories = [
  'Identity',
  'Audio',
  'Sound Files',
  'Security',
  'Behavior',
  'TTS',
  'Video',
  'Other',
];

/**
 * Look up catalog metadata for a conference param.
 * Accepts either a plain param name ('rate') or a compound key ('default___rate').
 *
 * @param {string} key  - plain param name or profileName___paramName
 * @returns {object}    - ConfigurationEntry metadata (with applyMetaDefaults applied)
 */
export function lookupConferenceParam(key) {
  const paramName = key.includes(SEP) ? key.slice(key.indexOf(SEP) + SEP.length) : key;
  const raw = conferenceCatalog[paramName] ?? {
    category:    'Other',
    label:       paramName,
    description: 'Conference parameter — not in the catalog.',
    type:        'string',
    visibility:  'advanced',
  };
  const meta = applyMetaDefaults(raw);
  return { ...meta, metadata: meta };
}
