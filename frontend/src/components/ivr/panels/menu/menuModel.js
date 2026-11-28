// Menu (Gather DTMF) inspector: pure view-model logic, no React.
//
// PRESENTATION ONLY. Nothing here changes how a call runs: every rule mirrors
// exec_gather in backend/src/nodeTypes/registry.js and the gather rules in
// backend/src/validators/ivrValidator.js. The panel built on top of this
// module must never write a value just because a node was opened. It only
// writes the patches returned below, in response to an administrator's edit,
// in the stored formats ("yes"/"no" strings, numbers, branch targets).

import {
  gatherBranchKeysFor, gatherCollectsDigits, gatherIsConfigurable, GATHER_INTERNAL_EVENTS, GATHER_LEGACY_KEYS,
} from '../../canvas/nodePorts.js';

// ── Modes ───────────────────────────────────────────────────────────────────
// classic  — no retry_mode and no max_attempts: fixed 3-try behaviour (legacy).
// internal — retry_mode 'internal', or max_attempts set without retry_mode.
// external — retry_mode 'external': one attempt, failures leave the node.
export const MODE = Object.freeze({ CLASSIC: 'classic', INTERNAL: 'internal', EXTERNAL: 'external' });

export function menuMode(node) {
  if (node?.retry_mode === 'external') return MODE.EXTERNAL;
  if (node?.retry_mode === 'internal' || gatherIsConfigurable(node)) return MODE.INTERNAL;
  return MODE.CLASSIC;
}

export const MODE_LABELS = Object.freeze({
  [MODE.INTERNAL]: 'Retry in this node',
  [MODE.EXTERNAL]: 'One attempt — route failures',
  [MODE.CLASSIC]:  'Classic (3 fixed tries)',
});

const isSet = v => v !== undefined && v !== null && v !== '';

/** Stored yes/no/boolean → boolean, with the runtime default when unset. */
export function flag(value, runtimeDefault) {
  if (!isSet(value)) return runtimeDefault;
  return value === true || value === 'yes';
}

/** The stored format the existing selects write. */
export const yesNo = on => (on ? 'yes' : 'no');

// Values exec_gather uses when a field is empty (registry.js). Classic and the
// newer paths differ for the wait time and the prompt source.
const MODE_DEFAULTS = {
  [MODE.CLASSIC]:  { timeout_seconds: 10, prompt_source_type: 'tts' },
  [MODE.INTERNAL]: { timeout_seconds: 5,  prompt_source_type: 'none' },
  [MODE.EXTERNAL]: { timeout_seconds: 5,  prompt_source_type: 'none' },
};
const SHARED_DEFAULTS = {
  min_digits: 1, max_digits: 1, inter_digit_timeout: 2, reprompt_pause_ms: 700,
};

export const FAILURE_SLOTS = ['no_input', 'invalid_length', 'invalid_option'];
export const ANNOUNCEMENT_SLOTS = [...FAILURE_SLOTS, 'max_attempts_exceeded'];
const RETRY_DEFAULTS = Object.fromEntries(GATHER_INTERNAL_EVENTS.map(e => [e.key, e.retryDefault]));

/** Runtime value for one field (the mode's default when the field is empty). */
export function runtimeDefault(node, key) {
  const d = { ...SHARED_DEFAULTS, ...MODE_DEFAULTS[menuMode(node)] };
  return d[key];
}

/** What the call will actually use, per field, for this node in its mode. */
export function effective(node) {
  const mode = menuMode(node);
  const d = { ...SHARED_DEFAULTS, ...MODE_DEFAULTS[mode] };
  const num = k => (isSet(node?.[k]) && Number.isFinite(Number(node[k])) ? Number(node[k]) : d[k]);
  const attemptsSet = isSet(node?.max_attempts);
  let attempts = 3;                                   // classic: fixed
  if (mode === MODE.EXTERNAL) attempts = 1;
  if (mode === MODE.INTERNAL) attempts = attemptsSet ? Math.max(1, Math.floor(Number(node.max_attempts) || 1)) : 1;
  return {
    mode,
    timeout_seconds:     num('timeout_seconds'),
    min_digits:          num('min_digits'),
    max_digits:          num('max_digits'),
    inter_digit_timeout: num('inter_digit_timeout'),
    reprompt_pause_ms:   Math.max(0, num('reprompt_pause_ms')),
    terminators:         isSet(node?.terminators) ? String(node.terminators) : '',
    variable_name:       isSet(node?.variable_name) ? node.variable_name : 'gather_result',
    prompt_source_type:  isSet(node?.prompt_source_type) ? node.prompt_source_type : d.prompt_source_type,
    // Classic ignores allow_barge_in (audio prompts can always be interrupted,
    // text prompts always play in full) — reported as null.
    allow_barge_in:      mode === MODE.CLASSIC ? null : flag(node?.allow_barge_in, true),
    attempts,
    attemptsSet,
    retry:  Object.fromEntries(FAILURE_SLOTS.map(s => [s, flag(node?.[`retry_on_${s}`], RETRY_DEFAULTS[s])])),
    replay: Object.fromEntries(FAILURE_SLOTS.map(s => [s, flag(node?.[`${s}_replay_menu`], true)])),
  };
}

/** Announcement source for a slot ('prompt' = the menu prompt itself). */
export function sourceOf(node, slot) {
  if (slot === 'prompt') return effective(node).prompt_source_type;
  const v = node?.[`${slot}_source_type`];
  return isSet(v) ? v : 'none';
}

// ── Patches (the only writes the panel makes) ──────────────────────────────

export function togglePatch(field, on) {
  return { [field]: yesNo(on) };
}

export function sourcePatch(slot, src) {
  return { [slot === 'prompt' ? 'prompt_source_type' : `${slot}_source_type`]: src };
}

// ── Collect type: a key menu, or a number (PIN, account number) ────────────
// Derived from stored fields — there is no stored "collect type" field.
// Digits = no option keys and more than one digit (nodePorts.gatherCollectsDigits).

export const COLLECT = Object.freeze({ MENU: 'menu', DIGITS: 'digits' });

export function collectType(node) {
  return gatherCollectsDigits(node) ? COLLECT.DIGITS : COLLECT.MENU;
}

/** Length a node gets when an administrator switches it to collecting digits. */
export const DEFAULT_DIGITS_LENGTH = 4;

/**
 * Timing that suits a PIN or account number, written only into fields the
 * administrator has left empty when a node is switched to "Enters a number".
 * A caller needs longer to start typing a PIN than to press one key, and the
 * time between digits is what ends the entry when there is no end key.
 */
export const NUMBER_DEFAULTS = Object.freeze({
  timeout_seconds: 8, inter_digit_timeout: 3, terminators: '#',
});

/**
 * Switching between a key menu and collecting digits writes the digit counts
 * (and, going to digits, removes the option keys — the panel confirms that
 * first) plus NUMBER_DEFAULTS for fields that are still empty. A value the
 * administrator already set is never replaced. Every other exit is kept.
 */
export function collectTypePatch(node, target) {
  const current = collectType(node);
  if (target === current) return null;
  if (target === COLLECT.DIGITS) {
    const options = optionKeys(node);
    const patch = {};
    if (options.length) {
      const rest = { ...(node?.branches || {}) };
      for (const k of options) delete rest[k];
      patch.branches = rest;
    }
    if (effective(node).max_digits <= 1) {
      patch.min_digits = DEFAULT_DIGITS_LENGTH;
      patch.max_digits = DEFAULT_DIGITS_LENGTH;
    }
    for (const [k, v] of Object.entries(NUMBER_DEFAULTS)) if (!isSet(node?.[k])) patch[k] = v;
    return patch;
  }
  if (target === COLLECT.MENU) return { min_digits: 1, max_digits: 1 };
  return null;
}

// ── A key that isn't listed (key menus, Retry in this node) ────────────────
// exec_gather sends an unlisted key to _default ("Any other key") when that is
// connected, and only otherwise to the wrong-key handling. The panel shows the
// two as ONE choice so they can never silently compete.

export const WRONG_KEY = Object.freeze({ RETRY: 'retry', GO: 'go' });

/** What an unlisted key does today: ask again, or go straight to a node. */
export function wrongKeyChoice(node) {
  if (isWired(node, '_default')) return WRONG_KEY.GO;
  return effective(node).retry.invalid_option ? WRONG_KEY.RETRY : WRONG_KEY.GO;
}

/** Which exit the "go straight to" picker edits: _default, unless only an older invalid_option exit is connected. */
export function wrongKeyGoKey(node) {
  return isWired(node, '_default') || !isWired(node, 'invalid_option') ? '_default' : 'invalid_option';
}

/**
 * Ask again = retry_on_invalid_option yes AND no _default (otherwise _default
 * would still take the key). Go straight = retry_on_invalid_option no; the
 * destination is then picked on wrongKeyGoKey.
 */
export function wrongKeyChoicePatch(node, choice) {
  if (choice === WRONG_KEY.RETRY) {
    const patch = togglePatch('retry_on_invalid_option', true);
    if (Object.prototype.hasOwnProperty.call(node?.branches || {}, '_default')) {
      const { _default: _removed, ...rest } = node.branches;
      patch.branches = rest;
    }
    return patch;
  }
  if (choice === WRONG_KEY.GO) return togglePatch('retry_on_invalid_option', false);
  return null;
}

// ── Test an entry: what one caller entry does, step for step like exec_gather ─

/**
 * What the engine does with what a caller types on the first try. `typed` is
 * the keys pressed ('' = nothing). The entry ends at an end key and at the
 * maximum digits, as getDigits does. Returns null for Classic nodes (their
 * engine path is different and is not modelled here).
 *
 * { entry, reason: 'valid'|'no_input'|'invalid_length'|'invalid_option',
 *   action: 'go'|'retry'|'exhausted', exit, target, attempts,
 *   exhausted: { exit, target } }   // where the call goes when every try fails
 */
export function simulateEntry(node, typed) {
  const eff = effective(node);
  if (eff.mode === MODE.CLASSIC) return null;
  const br = node?.branches || {};
  const has = k => isWired(node, k);
  const first = (...keys) => keys.find(has) ?? null;
  let entry = String(typed ?? '');
  const cut = [...entry].findIndex(c => eff.terminators.includes(c));
  if (cut >= 0) entry = entry.slice(0, cut);
  entry = entry.slice(0, eff.max_digits);

  let reason;
  if (entry === '') reason = 'no_input';
  else if (entry.length < eff.min_digits) reason = 'invalid_length';
  else reason = (has(entry) || has('_default')) ? 'valid' : 'invalid_option';

  const out = (action, exit) => ({
    entry, reason, action, exit, target: exit ? br[exit] : null, attempts: eff.attempts,
    exhausted: exhaustedExit(),
  });
  function exhaustedExit() {
    if (eff.mode !== MODE.INTERNAL) return null;
    const exit = first('max_attempts_exceeded', 'timeout', '_default');
    return { exit, target: exit ? br[exit] : null };
  }

  if (reason === 'valid') return out('go', has(entry) ? entry : '_default');

  if (eff.mode === MODE.EXTERNAL) {
    if (reason === 'no_input') return out('go', first('timeout'));
    return out('go', first('invalid'));
  }

  if (!eff.retry[reason]) return out('go', first(reason, '_default', 'timeout', 'invalid'));
  if (eff.attempts > 1) return out('retry', null);
  const ex = exhaustedExit();
  return out('exhausted', ex.exit);
}

function messageText(node, slot) {
  const src = sourceOf(node, slot);
  const text = String(node?.[`${slot}_text`] || '').trim();
  if (src === 'tts' && text) return `says “${text}”`;
  if (src === 'audio' && node?.[`${slot}_audio_url`]) return `plays ${fileName(node[`${slot}_audio_url`])}`;
  return 'no message';
}

/** simulateEntry's result in plain words, one sentence per line. nameOf: node id → display name. */
export function describeEntry(node, r, nameOf) {
  const eff = effective(node);
  const digits = collectType(node) === COLLECT.DIGITS;
  const dest = target => (target ? `goes to ${nameOf(target)}` : 'nothing is connected, so the caller is disconnected');
  const why = {
    no_input: 'Nothing entered',
    invalid_length: `Too few digits (${r.entry.length} of ${eff.min_digits})`,
    invalid_option: digits ? `${r.entry} isn't accepted` : `Key ${r.entry} isn't listed`,
  }[r.reason];
  const lines = [];
  if (r.reason === 'valid') {
    lines.push(`${dest(r.target)}${digits ? `, with ${r.entry} saved as ${eff.variable_name}` : ''}.`);
  } else if (r.action === 'go') {
    lines.push(`${why}: no retry, ${dest(r.target)}.`);
  } else if (r.action === 'retry') {
    const again = eff.replay[r.reason] ? 'the prompt plays again' : 'it waits again';
    lines.push(`${why}: ${messageText(node, r.reason)}, then ${again} (try 2 of ${r.attempts}).`);
  } else {
    lines.push(`${why}: no tries left.`);
  }
  if (r.exhausted && (r.action === 'retry' || r.action === 'exhausted')) {
    const lead = r.action === 'retry' ? `If all ${r.attempts} tries fail` : 'Then';
    lines.push(`${lead}: ${messageText(node, 'max_attempts_exceeded')}, then ${dest(r.exhausted.target)}.`);
  }
  return lines.map(l => l.charAt(0).toUpperCase() + l.slice(1));
}

// ── Retries (shown as retries, stored as attempts) ─────────────────────────

/** Retries after the first try, or null when the node has no adjustable retries (classic, one attempt). */
export function retriesOf(node) {
  const eff = effective(node);
  if (eff.mode !== MODE.INTERNAL || !eff.attemptsSet) return null;
  return eff.attempts - 1;
}

/** "Retries: n" is stored as max_attempts = n + 1 (the validator allows 1–10 attempts). */
export function retriesPatch(retries) {
  const n = Math.floor(Number(retries));
  if (!Number.isFinite(n) || n < 0 || n > 9) return null;
  return { max_attempts: n + 1 };
}

/**
 * Switching failure handling. Classic is never written: going back would mean
 * deleting stored retry settings (and leaving retry fields without max_attempts
 * fails validation rule R1). Retry settings are never removed, so switching
 * back restores them. Turning a Classic node into "Retry in this node" sets the
 * attempts explicitly (3) — otherwise it would run a single attempt.
 */
export function modePatch(node, target) {
  if (target === MODE.EXTERNAL) return { retry_mode: 'external' };
  if (target === MODE.INTERNAL) {
    return gatherIsConfigurable(node) ? { retry_mode: 'internal' } : { retry_mode: 'internal', max_attempts: 3 };
  }
  return null;
}

// ── Menu options (digit keys) ──────────────────────────────────────────────

export const DTMF_KEYS = Object.freeze(['1', '2', '3', '4', '5', '6', '7', '8', '9', '0', '*', '#']);
export const RESERVED_BRANCH_KEYS = new Set([
  '_default', 'timeout', 'invalid', 'max_attempts_exceeded', ...GATHER_INTERNAL_EVENTS.map(e => e.key),
]);
const KEY_RE = /^[0-9*#]+$/;
const MAX_KEY_LENGTH = 24;                 // ivrValidator: branch keys max 24 chars

/** Menu option keys, in the same order the canvas draws their ports. */
export function optionKeys(node) {
  return gatherBranchKeysFor(node).filter(k => !RESERVED_BRANCH_KEYS.has(k));
}

/** First keypad key not used yet, or null when all twelve are taken. */
export function nextFreeKey(node) {
  const used = new Set(Object.keys(node?.branches || {}));
  return DTMF_KEYS.find(k => !used.has(k)) ?? null;
}

/** Adds an empty option row with a free key. Never overwrites an existing key. */
export function addOptionPatch(node) {
  const key = nextFreeKey(node);
  if (!key) return null;
  return { branches: { ...(node?.branches || {}), [key]: '' } };
}

/** Error message for a proposed key, or null when it is acceptable. */
export function validateOptionKey(node, key, currentKey) {
  const k = String(key ?? '').trim();
  if (!k) return 'Enter a key';
  if (!KEY_RE.test(k)) return 'Use digits 0–9, * or #';
  if (k.length > MAX_KEY_LENGTH) return `At most ${MAX_KEY_LENGTH} characters`;
  if (k !== currentKey && Object.prototype.hasOwnProperty.call(node?.branches || {}, k)) return `Key ${k} is already used`;
  return null;
}

/** Non-blocking advice: options a caller cannot actually reach. */
export function optionKeyWarning(node, key) {
  const eff = effective(node);
  const k = String(key ?? '');
  if (!k || !KEY_RE.test(k)) return null;
  const term = [...eff.terminators].find(t => k.includes(t));
  if (term) return `${term} ends the entry (end-of-entry key), so callers can't reach this option`;
  if (k.length > eff.max_digits) {
    return `Callers can enter at most ${eff.max_digits} digit${eff.max_digits === 1 ? '' : 's'} — raise Digits per entry in Settings › Advanced`;
  }
  if (k.length < eff.min_digits) {
    return `Shorter than the minimum of ${eff.min_digits} digits, so it counts as too few digits`;
  }
  return null;
}

/** Renames an option, keeping its destination. Returns null if not allowed. */
export function renameOptionPatch(node, oldKey, newKey) {
  const k = String(newKey ?? '').trim();
  if (k === oldKey || validateOptionKey(node, k, oldKey)) return null;
  const out = {};
  for (const [key, target] of Object.entries(node?.branches || {})) out[key === oldKey ? k : key] = target;
  return { branches: out };
}

/** Removes exactly one option (or outcome) key. */
export function removeBranchPatch(node, key) {
  const { [key]: _removed, ...rest } = node?.branches || {};
  return { branches: rest };
}

/** Sets one destination. '' = not connected (removed when the flow is saved). */
export function setBranchPatch(node, key, target) {
  return { branches: { ...(node?.branches || {}), [key]: target || '' } };
}

// ── Where each output appears in the panel ─────────────────────────────────

/**
 * Places every output the canvas shows (gatherBranchKeysFor) into exactly one
 * panel row, so the panel and the canvas never disagree. Keys the current mode
 * does not use but that are still wired (for example an old "timeout" wire on a
 * node that now retries internally) go to `other`, never silently hidden.
 */
export function menuRows(node) {
  const mode = menuMode(node);
  const visible = gatherBranchKeysFor(node);
  const placed = new Set();
  const take = k => {
    if (!visible.includes(k) || placed.has(k)) return null;
    placed.add(k);
    return k;
  };
  const options = optionKeys(node);
  options.forEach(k => placed.add(k));
  const anyOther = take('_default');
  let noResponse = null;
  let wrongKey = null;
  let tooFew = null;
  let exhausted = null;
  if (mode === MODE.INTERNAL) {
    noResponse = take('no_input');        // only when its retry is off
    wrongKey   = take('invalid_option');  // only when its retry is off
    tooFew     = take('invalid_length');  // only when its retry is off
    exhausted  = take('max_attempts_exceeded');
  } else {
    noResponse = take('timeout');
    wrongKey   = take('invalid');
  }
  const other = visible.filter(k => !placed.has(k));
  return { mode, options, anyOther, noResponse, wrongKey, tooFew, exhausted, other };
}

/** Panel keys in display order (used by the panel/canvas agreement test). */
export function panelKeys(node) {
  const r = menuRows(node);
  return [...r.options, r.anyOther, r.noResponse, r.wrongKey, r.tooFew, r.exhausted, ...r.other].filter(Boolean);
}

/** "Too few digits" only matters when more than one digit is required, or it is already configured. */
export function showTooFewDigits(node) {
  if (menuMode(node) !== MODE.INTERNAL) return false;
  if (effective(node).min_digits > 1) return true;
  if (menuRows(node).tooFew) return true;
  return ['retry_on_invalid_length', 'invalid_length_source_type', 'invalid_length_text',
    'invalid_length_audio_url', 'invalid_length_replay_menu'].some(k => isSet(node?.[k]));
}

/**
 * Rows whose fallback chain ends with nobody to take the call (the caller is
 * disconnected). Mirrors exec_gather's routing: an empty destination falls back
 * along the same chain the runtime uses before it gives up.
 */
export function unguardedRows(node) {
  const br = node?.branches || {};
  const has = k => typeof br[k] === 'string' && br[k].trim() !== '';
  const eff = effective(node);
  const out = new Set();
  if (eff.mode === MODE.CLASSIC) {
    if (!has('timeout') && !has('_default')) out.add('noResponse');
    if (!has('_default') && !has('invalid')) out.add('wrongKey');
    return out;
  }
  if (eff.mode === MODE.EXTERNAL) {
    if (!has('timeout')) out.add('noResponse');
    // Too few digits always goes to "invalid"; a wrong key tries "any other key" first.
    if (!has('invalid') && (eff.min_digits > 1 || !has('_default'))) out.add('wrongKey');
    return out;
  }
  const reasonFallback = k => has(k) || has('_default') || has('timeout') || has('invalid');
  if (!eff.retry.no_input && !reasonFallback('no_input')) out.add('noResponse');
  if (!eff.retry.invalid_option && !has('_default') && !reasonFallback('invalid_option')) out.add('wrongKey');
  if (eff.min_digits > 1 && !eff.retry.invalid_length && !reasonFallback('invalid_length')) out.add('tooFew');
  const canRunOut = eff.retry.no_input
    || (eff.retry.invalid_length && eff.min_digits > 1)
    || (eff.retry.invalid_option && !has('_default'));
  if (canRunOut && !has('max_attempts_exceeded') && !has('timeout') && !has('_default')) out.add('exhausted');
  return out;
}

// ── Short texts (section headers, canvas card) ─────────────────────────────

const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
const fileName = url => String(url || '').replace(/^\/media\//, '').split('/').pop();

function digitsText(eff) {
  if (eff.min_digits === eff.max_digits) return eff.max_digits === 1 ? '1 key' : `${eff.max_digits} digits`;
  return `${eff.min_digits}–${eff.max_digits} digits`;
}

/** True when this branch key has a destination. */
export function isWired(node, key) {
  const t = node?.branches?.[key];
  return typeof t === 'string' && t.trim() !== '';
}

/** The backend refuses to save a Menu with no connected exit at all ("requires at least one branch"). */
export function hasAnyExit(node) {
  return Object.values(node?.branches || {}).some(t => typeof t === 'string' && t.trim() !== '');
}

function wiredOptionCount(node) {
  return optionKeys(node).filter(k => isWired(node, k)).length;
}

const MODE_SHORT = Object.freeze({
  [MODE.INTERNAL]: 'Retry in this node',
  [MODE.EXTERNAL]: 'One attempt',
  [MODE.CLASSIC]:  'Classic',
});

/** Announcement slots that can play for this node (retry on, or the final message). */
function activeMessageSlots(node) {
  const eff = effective(node);
  if (eff.mode !== MODE.INTERNAL) return [];
  const slots = [];
  if (eff.retry.no_input) slots.push('no_input');
  if (eff.retry.invalid_option && !isWired(node, '_default')) slots.push('invalid_option');
  if (eff.retry.invalid_length && showTooFewDigits(node)) slots.push('invalid_length');
  slots.push('max_attempts_exceeded');
  return slots;
}

export function sectionSummaries(node) {
  const eff = effective(node);
  const rows = menuRows(node);
  const optionsText = plural(rows.options.length, 'option', 'options');
  const messages = activeMessageSlots(node).filter(s => sourceOf(node, s) !== 'none').length;
  return {
    options: eff.max_digits > 1 ? `${digitsText(eff)} · ${optionsText}` : optionsText,
    retryMessages: messages ? `${messages} set` : 'None',
    advanced: MODE_SHORT[eff.mode],
  };
}

// ── Exit names (one vocabulary for the panel, the canvas card and its wires) ─

const EXIT_NAMES = Object.freeze({
  no_input: 'No input',
  timeout: 'No input',
  invalid_length: 'Too few digits',
  max_attempts_exceeded: 'Retries used up',
});

/** Name of the _default exit: the success exit when collecting digits, else the catch-all. */
export function defaultExitName(node) {
  if (collectType(node) === COLLECT.DIGITS) return 'Number entered';
  return effective(node).max_digits > 1 ? 'Any other entry' : 'Any other key';
}

/**
 * Display name of one Menu exit. Option keys read "1 · Opening hours" when
 * connected (nameOf resolves a node id to its name) and "Press 1" otherwise.
 * Connections the current settings do not use directly are marked: legacy
 * keys on a retry node are runtime fallbacks; anything else is unused.
 * Display only — the stored branch key never changes.
 */
export function menuExitLabel(node, key, { nameOf, withTarget = true } = {}) {
  if (!RESERVED_BRANCH_KEYS.has(key)) {
    const target = node?.branches?.[key];
    const name = withTarget && isWired(node, key) && typeof nameOf === 'function' ? nameOf(target) : null;
    return name ? `${key} · ${name}` : `Press ${key}`;
  }
  const digits = collectType(node) === COLLECT.DIGITS;
  let label;
  if (key === '_default') label = defaultExitName(node);
  else if (key === 'invalid_option' || key === 'invalid') label = digits ? 'Wrong entry' : 'Wrong key';
  else label = EXIT_NAMES[key] || key;
  if (menuRows(node).other.includes(key)) {
    const fallback = menuMode(node) === MODE.INTERNAL && GATHER_LEGACY_KEYS.includes(key);
    label += fallback ? ' (fallback)' : ' (unused)';
  }
  return label;
}

/** First line of the canvas card: what the caller hears. */
export function menuPromptPreview(node) {
  const src = effective(node).prompt_source_type;
  if (src === 'audio') return node?.prompt_audio_url ? `Audio: ${fileName(node.prompt_audio_url)}` : 'No audio file';
  if (src === 'tts') {
    const text = String(node?.prompt_text || '').trim();
    return text ? `“${text}”` : 'No prompt text';
  }
  return 'No prompt';
}

/** One-line Menu summary (canvas card tooltip): prompt · options · attempts. */
export function menuCanvasSummary(node) {
  const eff = effective(node);
  const parts = [];
  const src = eff.prompt_source_type;
  if (src === 'audio') parts.push(node?.prompt_audio_url ? `Audio ${fileName(node.prompt_audio_url)}` : 'No audio file');
  else if (src === 'tts') parts.push(String(node?.prompt_text || '').trim() ? 'Speak' : 'No prompt text');
  else parts.push('No prompt');
  const n = wiredOptionCount(node);
  if (n > 0) parts.push(plural(n, 'option', 'options'));
  else if (eff.max_digits > 1) parts.push(digitsText(eff));
  else parts.push('No options');
  if (eff.mode === MODE.INTERNAL) parts.push(plural(eff.attempts, 'try', 'tries'));
  else if (eff.mode === MODE.EXTERNAL) parts.push('1 try');
  else parts.push('classic retry');
  return parts.join(' · ');
}

// ── Validation messages → the field they concern ───────────────────────────

const ERROR_FIELD_RULES = [
  [/^prompt_source_type=audio requires prompt_audio_url/, () => 'prompt_audio_url'],
  [/^(no_input|invalid_length|invalid_option|max_attempts_exceeded)_source_type=audio requires/, m => `${m[1]}_audio_url`],
  [/^(no_input|invalid_length|invalid_option|max_attempts_exceeded)_source_type=tts requires/, m => `${m[1]}_text`],
  [/^min_digits \(\d+\) must not exceed max_digits/, () => 'min_digits'],
  [/^configurable retry fields .*require max_attempts/, () => 'max_attempts'],
];

/**
 * Re-homes validation messages next to the Menu field they concern. Display
 * only: the strings come from the backend validator unchanged. Cross-field
 * rules arrive with no field path (bucketed under "type"); a missing
 * destination arrives as a node-level message naming the node id.
 * Destination rows use the key "branch:<branchKey>".
 * @returns {{ byField: Record<string,string[]>, node: string[] }}
 */
export function mapMenuErrors(node, byField = {}, nodeLevel = []) {
  const out = {};
  for (const [k, v] of Object.entries(byField || {})) out[k] = [...v];
  const typeMsgs = out.type || [];
  delete out.type;
  const route = msg => {
    for (const [re, field] of ERROR_FIELD_RULES) {
      const m = msg.match(re);
      if (m) { (out[field(m)] ||= []).push(msg); return true; }
    }
    const ref = msg.match(/references non-existent node "([^"]+)"/);
    if (ref) {
      const keys = Object.entries(node?.branches || {}).filter(([, t]) => t === ref[1]).map(([k]) => k);
      if (keys.length) {
        for (const k of keys) (out[`branch:${k}`] ||= []).push('This destination no longer exists — choose another');
        return true;
      }
    }
    return false;
  };
  const rest = [];
  for (const m of typeMsgs) if (!route(m)) rest.push(m);
  for (const m of nodeLevel || []) if (!route(m)) rest.push(m);
  return { byField: out, node: rest };
}

/** Every configSchema key the Menu panel places (the coverage test checks the registry against this). */
export const MENU_PANEL_FIELDS = Object.freeze([
  'prompt_source_type', 'prompt_text', 'prompt_audio_url', 'branches',
  'timeout_seconds', 'retry_on_no_input', 'no_input_source_type', 'no_input_text', 'no_input_audio_url', 'no_input_replay_menu',
  'retry_on_invalid_option', 'invalid_option_source_type', 'invalid_option_text', 'invalid_option_audio_url', 'invalid_option_replay_menu',
  'retry_on_invalid_length', 'invalid_length_source_type', 'invalid_length_text', 'invalid_length_audio_url', 'invalid_length_replay_menu',
  'max_attempts', 'max_attempts_exceeded_source_type', 'max_attempts_exceeded_text', 'max_attempts_exceeded_audio_url',
  'allow_barge_in', 'min_digits', 'max_digits',
  'retry_mode', 'variable_name', 'terminators', 'inter_digit_timeout', 'reprompt_pause_ms',
]);
