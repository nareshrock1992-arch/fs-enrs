import { z } from 'zod';

// ── Shared helpers ────────────────────────────────────────────────────────────

const nodeId = z.string().min(1).max(64).regex(/^[a-z0-9_-]+$/i, 'Node ID must be alphanumeric/underscore/hyphen');

// audio_url must be a local media path — no absolute URLs (SSRF prevention)
const localAudioUrl = z.string()
  .max(512)
  .regex(/^\/media\//, 'audio_url must start with /media/ (no external URLs)');

// session variable name — alphanumeric/underscore
const varName = z.string().min(1).max(128).regex(/^[a-zA-Z_][a-zA-Z0-9_]*$/, 'variable name must start with a letter/underscore');

// ── Per-type node schemas ─────────────────────────────────────────────────────

// Plain ZodObject — no .refine() here.
// Cross-field check (audio_file_id OR audio_url required when source_type='url')
// is enforced by the .superRefine() on AnyNodeSchema below.
const PlayNodeSchema = z.object({
  type:              z.literal('play'),
  next:              nodeId,
  audio_file_id:     z.number().int().positive().optional(),
  audio_url:         localAudioUrl.optional(),
  // Dynamic audio source support — when audio_source_type = 'variable', the play
  // node reads the file path from a session variable (e.g. set by record_message).
  audio_source_type: z.enum(['url', 'variable']).optional().default('url'),
  audio_variable:    varName.optional(),
});

const SayNodeSchema = z.object({
  type:     z.literal('say'),
  text:     z.string().min(1).max(1000),
  next:     nodeId,
  language: z.string().max(10).optional().default('en-US'),
  voice:    z.string().max(64).optional(),
});

// gather now supports: digit branches, _default catch-all, timeout, invalid
// and optional variable_name so downstream condition nodes can read digits
const GatherNodeSchema = z.object({
  type:                  z.literal('gather'),
  branches:              z.record(z.string().max(16), nodeId).refine(
    b => Object.keys(b).length >= 1,
    'gather node requires at least one branch'
  ),
  min_digits:            z.number().int().min(1).max(11).optional().default(1),
  max_digits:            z.number().int().min(1).max(11).optional().default(1),
  timeout_seconds:       z.number().int().min(1).max(60).optional().default(5),
  // inter_digit_timeout: seconds allowed between consecutive digits; 0=FS default.
  inter_digit_timeout:   z.number().int().min(0).max(30).optional().default(2),
  // Empty string means "no terminator — stop at max_digits or timeout".
  // Kept as string (not null) so the Lua handler's nil check works correctly.
  terminators:           z.string().max(4).optional().default(''),
  variable_name:         varName.optional().default('gather_result'),
  prompt_source_type:    z.enum(['tts', 'audio']).optional().default('tts'),
  prompt_audio_file_id:  z.number().int().positive().optional(),
  prompt_text:           z.string().max(1000).optional(),
  prompt_audio_url:      localAudioUrl.optional(),
});

const GotoNodeSchema = z.object({
  type:           z.literal('goto'),
  target_node_id: nodeId,
});

// ens node: either hardcoded ens_configuration_id OR ens_config_var (session var)
// recording_file_var: session variable holding the recorded file path (from record_message node)
// Plain ZodObject — no .refine() here.
// Cross-field check (ens_configuration_id OR ens_config_var required)
// is enforced by the .superRefine() on AnyNodeSchema below.
const EnsNodeSchema = z.object({
  type:                 z.literal('ens'),
  ens_configuration_id: z.number().int().positive().optional(),
  ens_config_var:       varName.optional(),
  recording_file_var:   varName.optional(),
  next:                 nodeId.optional(),
});

const ErsNodeSchema = z.object({
  type:                  z.literal('ers'),
  ers_configuration_id:  z.number().int().positive(),
});

const HangupNodeSchema = z.object({
  type:                  z.literal('hangup'),
  goodbye_source_type:   z.enum(['none', 'audio', 'tts']).optional().default('none'),
  play_audio_file_id:    z.number().int().positive().optional(),
  play_audio_url:        localAudioUrl.optional(),
  goodbye_text:          z.string().max(1000).optional(),
});

// ── NEW: condition node ───────────────────────────────────────────────────────
// Evaluates session.getVariable(variable) against expected_value using operator.
// operator 'ens_pin_valid' makes an HTTP call to /internal/ens/lookup and compares PIN,
// then stores ens_configuration_id + metadata as session variables.

const ConditionNodeSchema = z.object({
  type:           z.literal('condition'),
  variable:       varName,                // session variable to read
  operator:       z.enum([
    // String comparisons
    '==', '!=', 'contains', 'starts_with', 'ends_with',
    // Existence checks (expected_value ignored)
    'exists', 'not_exists',
    // Numeric comparisons
    'gt', 'gte', 'lt', 'lte',
    // ENS-specific
    'ens_pin_valid', 'ens_callback_valid',
    // Temporal
    'time_of_day', 'day_of_week',
  ]),
  expected_value: z.string().max(256),    // static value or ${var_name} interpolation
  true_node:      nodeId,
  false_node:     nodeId,
});

// ── record_message node ───────────────────────────────────────────────────────
// Records caller audio until # pressed or silence detected.
// Saves file path into variable_name for use by downstream ens node.
// The executor resolves the recording directory from FreeSWITCH's recordings_dir
// global variable at call time — record_dir is kept only for backward compatibility
// with pre-existing saved flows and is silently ignored by the executor.

const RecordMessageNodeSchema = z.object({
  type:               z.literal('record_message'),
  variable_name:      varName,
  record_dir:         z.string().max(512).optional(),  // ignored — path resolved from FS global var
  max_seconds:        z.number().int().min(1).max(300).optional().default(60),
  // dtmf_stop_key: '#' (default), '*', or '' (none — duration/silence only).
  // Stored as a string to match FreeSWITCH's record application argument.
  dtmf_stop_key:      z.string().max(1).optional().default('#'),
  silence_threshold:  z.number().int().min(10).max(2000).optional().default(500),
  silence_hits:       z.number().int().min(1).max(500).optional().default(20),
  prompt_source_type: z.enum(['tts', 'audio']).optional().default('tts'),
  prompt_text:        z.string().max(1000).optional(),
  prompt_audio_url:   localAudioUrl.optional(),
  next:               nodeId,
});

// ── NEW: set_variable node ────────────────────────────────────────────────────
// Sets a FreeSWITCH channel variable. value supports ${other_var} interpolation.

const SetVariableNodeSchema = z.object({
  type:     z.literal('set_variable'),
  variable: varName,
  value:    z.string().max(1024),   // may contain ${var_name} references
  next:     nodeId,
});

// ── NEW: transfer node ────────────────────────────────────────────────────────
// Transfers the call to another extension/context. Ends executor control (no next).

const TransferNodeSchema = z.object({
  type:        z.literal('transfer'),
  destination: z.string().min(1).max(128),          // extension number or ${var}
  dialplan:    z.string().max(64).optional().default('XML'),
  context:     z.string().max(64).optional().default('default'),
});

// ── Proof node type added via the Phase 3 registry — see
// backend/src/nodeTypes/registry.js and docs/EXTENDING_NODE_TYPES.md.
// The registry is not yet the source of truth for validation (see that
// file's header comment), so a new node type still needs one schema
// added here to be accepted on save/publish.
const WebhookNodeSchema = z.object({
  type:           z.literal('webhook'),
  url:            z.string().min(1).max(2048),
  body_template:  z.string().max(4000).optional(),
  next:           nodeId,
});

// ── Phase 5 emergency-scenario node types ─────────────────────────────────────
// Connection fields deliberately reuse existing ref names (branches / next /
// true_node / false_node) so refsOf() and the canvas port strategies work
// with zero changes — see nodeTypes/registry.js.

// Coerce empty string / null / 0 → undefined so draft nodes with no
// config selected yet pass validation. The positive-integer constraint
// still applies when a value IS present.
const optionalConfigId = z.preprocess(
  v => (v === '' || v === null || v === 0 ? undefined : v),
  z.number().int().positive().optional()
);

// Branch target — accepts empty string (unconnected port on a draft canvas)
// as well as a valid node ID. The graph-structure validator checks
// connectivity separately; Zod only needs to accept the shape.
const branchTarget = z.string().max(64);

const ErsRingAllNodeSchema = z.object({
  type:                 z.literal('ers_ring_all'),
  ers_configuration_id: optionalConfigId,
  tier:                 z.enum(['primary', 'secondary']).default('primary'),
  ring_timeout_seconds: z.number().int().min(10).max(7200).optional(),
});

const ErsOverflowCheckNodeSchema = z.object({
  type:                 z.literal('ers_overflow_check'),
  ers_configuration_id: optionalConfigId,
  // Branches: keys are 'primary'|'secondary'|'full'; values may be '' while
  // the user is still wiring the canvas (validated for connectivity at publish).
  branches:             z.record(z.string().max(16), branchTarget).optional().default({}),
});

const ErsOverflowWaitNodeSchema = z.object({
  type:                 z.literal('ers_overflow_wait'),
  ers_configuration_id: optionalConfigId,
  hold_source_type:     z.enum(['tts', 'audio']).optional().default('tts'),
  hold_prompt_text:     z.string().max(1000).optional(),
  hold_audio_url:       localAudioUrl.optional(),
  max_wait_seconds:     z.number().int().min(10).max(3600).optional().default(300),
  next:                 nodeId,
});

const EnsBlastRecordNodeSchema = z.object({
  type:                     z.literal('ens_blast_record'),
  ens_configuration_id:     optionalConfigId,
  pin_prompt_source_type:   z.enum(['tts', 'audio']).optional().default('tts'),
  pin_prompt_audio_url:     localAudioUrl.optional(),
  pin_prompt_text:          z.string().max(1000).optional(),
  record_prompt_source_type: z.enum(['tts', 'audio']).optional().default('tts'),
  record_prompt_audio_url:  localAudioUrl.optional(),
  record_prompt_text:       z.string().max(1000).optional(),
  max_record_seconds:       z.number().int().min(5).max(300).optional().default(120),
  silence_threshold:        z.number().int().min(10).max(2000).optional().default(500),
  silence_hits:             z.number().int().min(1).max(10).optional().default(3),
  next:                     nodeId,
});

const EnsPlaybackNodeSchema = z.object({
  type:     z.literal('ens_playback'),
  branches: z.record(z.string(), nodeId).optional(),
});

// ── Discriminated union — validates any node by its type field ────────────────
//
// All members MUST be plain ZodObject instances.
// ZodEffects (from .refine() on the outer object) causes a TypeError during
// discriminatedUnion construction in Zod 3.x:
//   "Cannot read properties of undefined (reading 'type')"
//
// Two exports:
//   AnyNodeSchemaDraft — shape + field validation only; no cross-field rules.
//                        Used by DraftGraphSchema (autosave) so the designer
//                        can persist intermediate edit states.
//   AnyNodeSchema      — adds cross-field semantic validation via superRefine.
//                        Used by validateGraph and publishFlow.

export const AnyNodeSchemaDraft = z.discriminatedUnion('type', [
  PlayNodeSchema,         // ZodObject ✓
  SayNodeSchema,          // ZodObject ✓
  GatherNodeSchema,       // ZodObject ✓  (refine is on the branches field, not the outer object)
  GotoNodeSchema,         // ZodObject ✓
  EnsNodeSchema,          // ZodObject ✓
  ErsNodeSchema,          // ZodObject ✓
  HangupNodeSchema,       // ZodObject ✓
  ConditionNodeSchema,    // ZodObject ✓
  RecordMessageNodeSchema,// ZodObject ✓
  SetVariableNodeSchema,  // ZodObject ✓
  TransferNodeSchema,     // ZodObject ✓
  WebhookNodeSchema,      // ZodObject ✓
  ErsRingAllNodeSchema,       // ZodObject ✓
  ErsOverflowCheckNodeSchema, // ZodObject ✓  (refine is on the branches field)
  ErsOverflowWaitNodeSchema,  // ZodObject ✓
  EnsBlastRecordNodeSchema,   // ZodObject ✓
  EnsPlaybackNodeSchema,      // ZodObject ✓
]);

export const AnyNodeSchema = AnyNodeSchemaDraft.superRefine((node, ctx) => {
  if (node.type === 'gather') {
    const minD = node.min_digits ?? 1;
    const maxD = node.max_digits ?? 1;
    if (minD > maxD) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `min_digits (${minD}) must not exceed max_digits (${maxD})`,
      });
    }
  }
  if (node.type === 'play') {
    const srcType = node.audio_source_type ?? 'url';
    if (srcType === 'url' && node.audio_file_id === undefined && node.audio_url === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'requires audio_file_id or audio_url when source type is static',
      });
    }
    if (srcType === 'variable' && !node.audio_variable) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'requires audio_variable (session variable name) when source type is dynamic',
      });
    }
  }
  if (
    node.type === 'ens' &&
    node.ens_configuration_id === undefined &&
    (node.ens_config_var === undefined || node.ens_config_var === '')
  ) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'requires ens_configuration_id or ens_config_var',
    });
  }

  // Explicit source_type enforcement — source_type=audio requires audio_url;
  // source_type=tts requires non-empty text. No cross-type silent fallbacks.
  if (node.type === 'gather' || node.type === 'record_message') {
    const st = node.prompt_source_type ?? 'tts';
    if (st === 'audio' && !node.prompt_audio_url) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'prompt_source_type=audio requires prompt_audio_url' });
    }
  }
  if (node.type === 'ers_overflow_wait') {
    const st = node.hold_source_type ?? 'tts';
    if (st === 'audio' && !node.hold_audio_url) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'hold_source_type=audio requires hold_audio_url' });
    }
  }
  if (node.type === 'hangup') {
    const st = node.goodbye_source_type ?? 'none';
    if (st === 'audio' && !node.play_audio_url) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'goodbye_source_type=audio requires play_audio_url or play_audio_file_id' });
    }
    if (st === 'tts' && !node.goodbye_text) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'goodbye_source_type=tts requires goodbye_text' });
    }
  }
  if (node.type === 'ens_blast_record') {
    const pinSt  = node.pin_prompt_source_type  ?? 'tts';
    const recSt  = node.record_prompt_source_type ?? 'tts';
    if (pinSt === 'audio' && !node.pin_prompt_audio_url) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'pin_prompt_source_type=audio requires pin_prompt_audio_url' });
    }
    if (recSt === 'audio' && !node.record_prompt_audio_url) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'record_prompt_source_type=audio requires record_prompt_audio_url' });
    }
  }
});

// ── Full graph schema (used for publish — requires ≥1 node) ──────────────────

export const GraphSchema = z.object({
  entry_node_id: nodeId,
  nodes:         z.record(nodeId, AnyNodeSchema).refine(
    n => Object.keys(n).length >= 1,
    'graph must have at least one node'
  ),
}).refine(
  g => g.nodes[g.entry_node_id] !== undefined,
  { message: 'entry_node_id must reference an existing node', path: ['entry_node_id'] }
);

// ── Draft graph schema (used for save — allows empty canvas) ─────────────────
// Accepts entry_node_id = '' and nodes = {} so the user can save after deleting
// all nodes without the backend rejecting an otherwise-valid empty draft.

export const DraftGraphSchema = z.object({
  entry_node_id: z.string().max(64),
  nodes:         z.record(z.string().max(64), AnyNodeSchemaDraft),
  _layout:   z.record(z.any()).optional(),  // per-node {x,y} — stored, restores canvas positions
  _viewport: z.object({ x: z.number(), y: z.number(), scale: z.number() }).optional(), // pan+zoom
}).passthrough();  // ignore any extra top-level keys the frontend might add

// ── Request body schemas ──────────────────────────────────────────────────────

export const CreateFlowSchema = z.object({
  name:            z.string().min(1).max(128).trim(),
  description:     z.string().max(1000).optional(),
  organization_id: z.number().int().positive().optional(),
});

export const UpdateFlowSchema = z.object({
  name:         z.string().min(1).max(128).trim().optional(),
  description:  z.string().max(1000).optional(),
  graph:        DraftGraphSchema.optional(),
  is_test_flow: z.boolean().optional(),
});

export const PublishFlowSchema = z.object({
  change_notes: z.string().max(500).optional(),
});

export const BindFlowSchema = z.object({
  emergency_number_id: z.number().int().positive(),
});

export const UnbindFlowSchema = z.object({
  emergency_number_id: z.number().int().positive(),
});
