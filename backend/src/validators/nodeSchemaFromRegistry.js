// Derive per-node-type zod schemas from the node registry's configSchema, so
// the UI form, the stored shape, and backend validation share ONE source of
// truth (registry.js). Adding/editing a node field in the registry now updates
// validation automatically — no parallel hand-written zod to drift.
//
// Scope (Phase 1 WS1): shape + required + numeric ranges + select enums.
// Cross-field / graph-level rules stay in ivrValidator.js (the backstop).
//
// Field-type → zod mapping notes:
//   - number / ers_config_ref / ens_config_ref → z.number() (NO coercion):
//     "" and null are rejected rather than silently becoming 0.
//   - required → value must be present and well-typed.
//   - optional → may be ABSENT (undefined); still rejects null and wrong types.
//   - unknown/legacy keys are tolerated (.passthrough()) so existing flows that
//     carry extra fields keep validating; typed known fields are still checked.

import { z } from 'zod';
import { NODE_TYPE_REGISTRY } from '../nodeTypes/registry.js';

const isNum = (v) => typeof v === 'number' && Number.isFinite(v);

export function zodForField(f) {
  let base;
  switch (f.fieldType) {
    case 'number': {
      let n = z.number({ invalid_type_error: `${f.key} must be a number`, required_error: `${f.key} is required` });
      if (isNum(f.min)) n = n.min(f.min);
      if (isNum(f.max)) n = n.max(f.max);
      base = n;
      break;
    }
    case 'ers_config_ref':
    case 'ens_config_ref':
      // A configuration id — must be a real positive integer, never "" or null.
      base = z.number({ invalid_type_error: `${f.key} must be a numeric configuration id` }).int().positive();
      break;
    case 'select': {
      const vals = (f.options || []).map((o) => o.value).filter((v) => typeof v === 'string');
      base = vals.length ? z.enum(vals) : z.string();
      break;
    }
    case 'branches_map':
      base = z.record(z.string(), z.string());
      break;
    case 'node_ref':
      base = z.string();
      break;
    case 'mono_text':
    case 'text':
    case 'textarea':
    case 'audio_url':
    default:
      base = z.string();
  }
  return f.required ? base : base.optional();
}

export function nodeSchemaFor(nodeType) {
  const cfg = NODE_TYPE_REGISTRY.find((n) => n.type === nodeType);
  if (!cfg) return null;
  const shape = {
    type: z.literal(nodeType),
    // Cosmetic / identity fields present on any stored node (never runtime).
    nickname: z.string().optional(),
    description: z.string().optional(),
    label: z.string().optional(),
  };
  for (const f of cfg.configSchema || []) shape[f.key] = zodForField(f);
  return z.object(shape).passthrough();
}

// Map of type → schema, plus a type→schema lookup for per-node validation.
export const DERIVED_NODE_SCHEMAS = Object.fromEntries(
  NODE_TYPE_REGISTRY.map((n) => [n.type, nodeSchemaFor(n.type)]),
);

// Validate a single stored node object. Returns { ok, issues: [{path, message}] }.
export function validateNode(node) {
  const schema = node && typeof node.type === 'string' ? DERIVED_NODE_SCHEMAS[node.type] : null;
  if (!schema) return { ok: false, issues: [{ path: 'type', message: `unknown node type "${node?.type}"` }] };
  const r = schema.safeParse(node);
  if (r.success) return { ok: true, issues: [] };
  return {
    ok: false,
    issues: r.error.issues.map((i) => ({ path: i.path.join('.') || '(root)', message: i.message })),
  };
}
