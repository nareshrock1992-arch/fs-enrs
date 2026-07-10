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
// Cross-field check (audio_file_id OR audio_url required) is enforced
// by the .superRefine() on AnyNodeSchema below.
const PlayNodeSchema = z.object({
  type:          z.literal('play'),
  next:          nodeId,
  audio_file_id: z.number().int().positive().optional(),
  audio_url:     localAudioUrl.optional(),
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
  max_digits:            z.number().int().min(1).max(11).optional().default(1),
  timeout_seconds:       z.number().int().min(1).max(60).optional().default(5),
  terminators:           z.string().max(4).optional().default('#'),
  variable_name:         varName.optional().default('gather_result'),
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
  type:               z.literal('hangup'),
  play_audio_file_id: z.number().int().positive().optional(),
  play_audio_url:     localAudioUrl.optional(),
});

// ── NEW: condition node ───────────────────────────────────────────────────────
// Evaluates session.getVariable(variable) against expected_value using operator.
// operator 'ens_pin_valid' makes an HTTP call to /internal/ens/lookup and compares PIN,
// then stores ens_configuration_id + metadata as session variables.

const ConditionNodeSchema = z.object({
  type:           z.literal('condition'),
  variable:       varName,                // session variable to read
  operator:       z.enum(['==', '!=', 'contains', 'starts_with', 'ens_pin_valid', 'ens_callback_valid']),
  expected_value: z.string().max(256),    // static value or ${var_name} interpolation
  true_node:      nodeId,
  false_node:     nodeId,
});

// ── NEW: record_message node ──────────────────────────────────────────────────
// Records caller audio until # pressed or silence detected.
// Saves file path into variable_name for use by downstream ens node.

const RecordMessageNodeSchema = z.object({
  type:               z.literal('record_message'),
  variable_name:      varName,                              // session var to store recording path
  record_dir:         z.string().max(512).optional(),       // defaults to FS_RECORDING_DIR/ivr
  max_seconds:        z.number().int().min(1).max(300).optional().default(60),
  silence_threshold:  z.number().int().min(10).max(2000).optional().default(500),
  silence_hits:       z.number().int().min(1).max(10).optional().default(3),
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

const ErsRingAllNodeSchema = z.object({
  type:                 z.literal('ers_ring_all'),
  ers_configuration_id: z.number().int().positive(),
  tier:                 z.enum(['primary', 'secondary']).default('primary'),
});

const ErsOverflowCheckNodeSchema = z.object({
  type:                 z.literal('ers_overflow_check'),
  ers_configuration_id: z.number().int().positive(),
  branches:             z.record(z.enum(['primary', 'secondary', 'full']), nodeId).refine(
    b => b.primary && b.secondary && b.full,
    'ers_overflow_check requires all three branches: primary, secondary, full'
  ),
});

const ErsOverflowWaitNodeSchema = z.object({
  type:                 z.literal('ers_overflow_wait'),
  ers_configuration_id: z.number().int().positive(),
  hold_prompt_text:     z.string().max(1000).optional(),
  hold_audio_url:       localAudioUrl.optional(),
  max_wait_seconds:     z.number().int().min(10).max(3600).optional().default(300),
  next:                 nodeId,   // fallback: wait cap hit / cancelled
});

const EnsBlastRecordNodeSchema = z.object({
  type:                 z.literal('ens_blast_record'),
  ens_configuration_id: z.number().int().positive().optional(), // else resolved from dialed number
  pin_prompt_text:      z.string().max(1000).optional(),
  record_prompt_text:   z.string().max(1000).optional(),
  max_record_seconds:   z.number().int().min(5).max(300).optional().default(120),
  next:                 nodeId,
});

const EnsPlaybackGateNodeSchema = z.object({
  type:                 z.literal('ens_playback_gate'),
  ers_configuration_id: z.number().int().positive(),
  no_message_text:      z.string().max(1000).optional(),
  true_node:            nodeId,
  false_node:           nodeId,
});

// ── Discriminated union — validates any node by its type field ────────────────
//
// All members MUST be plain ZodObject instances.
// ZodEffects (from .refine() on the outer object) causes a TypeError during
// discriminatedUnion construction in Zod 3.x:
//   "Cannot read properties of undefined (reading 'type')"
//
// Cross-field rules that required .refine() on individual schemas are moved
// here into a single .superRefine() so the union still enforces them.

export const AnyNodeSchema = z.discriminatedUnion('type', [
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
  EnsPlaybackGateNodeSchema,  // ZodObject ✓
]).superRefine((node, ctx) => {
  if (node.type === 'play' && node.audio_file_id === undefined && node.audio_url === undefined) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'play node requires audio_file_id or audio_url',
    });
  }
  if (
    node.type === 'ens' &&
    node.ens_configuration_id === undefined &&
    (node.ens_config_var === undefined || node.ens_config_var === '')
  ) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'ens node requires ens_configuration_id or ens_config_var',
    });
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
  nodes:         z.record(z.string().max(64), AnyNodeSchema),
  _layout:       z.record(z.any()).optional(), // stripped by backend, not stored
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
