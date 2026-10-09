// WS1 (option B): parity backstop between the node registry (UI source of truth)
// and ivrValidator.js (the authoritative save/publish validator). Guarantees the
// two never silently drift: every registry configSchema field must be covered by
// a zod rule, and a field the registry marks required must be enforced as
// required by zod — except for a small, DOCUMENTED set of config-id fields that
// zod intentionally keeps optional so an in-progress DRAFT can be saved before
// the admin has selected a configuration (publish-time graph checks still apply).
import { describe, it, expect } from 'vitest';
import { NODE_TYPE_REGISTRY } from '../../nodeTypes/registry.js';
import { AnyNodeSchemaDraft } from '../../validators/ivrValidator.js';

// type → ZodObject shape, from the discriminated union members.
const zodShapes = {};
for (const opt of AnyNodeSchemaDraft.options) {
  const type = opt.shape.type._def.value;
  zodShapes[type] = opt.shape;
}

// Config-id/draft fields the registry marks required but zod leaves optional on
// purpose (draft-save before a config is chosen / empty canvas). Documented, not
// accidental. Each is enforced for connectivity by the graph validator / publish.
const KNOWN_REQUIRED_RELAXATIONS = new Set([
  'ers_ring_all.ers_configuration_id',
  'ers_ring_all.tier',
  'ers_overflow_check.ers_configuration_id',
  'ers_overflow_check.branches',   // record(...).optional().default({}) — wired on canvas, checked at publish
  'ers_overflow_wait.ers_configuration_id',
  'ens_playback.branches',         // record(...).optional() — outcomes wired on canvas
]);

// Registry fields that currently have NO zod rule and are therefore STRIPPED on
// save/publish (ZodObject strip-mode). These are tracked gaps, not accepted
// behaviour: `ers.group_type` is offered in the UI but never persisted/executed.
// Listed so this test passes and LOCKS the set — any NEW uncovered field fails
// the test — while the gap is reported for a follow-up fix (add it to zod).
const KNOWN_UNCOVERED = new Set([
  'ers.group_type',
]);

describe('registry ↔ ivrValidator parity', () => {
  it('every node type in the registry has a zod schema', () => {
    const missing = NODE_TYPE_REGISTRY.map(n => n.type).filter(t => !zodShapes[t]);
    expect(missing).toEqual([]);
  });

  it('every registry configSchema field is covered by a zod rule', () => {
    const uncovered = [];
    for (const n of NODE_TYPE_REGISTRY) {
      const shape = zodShapes[n.type];
      if (!shape) continue;
      for (const f of n.configSchema || []) {
        if (!(f.key in shape) && !KNOWN_UNCOVERED.has(`${n.type}.${f.key}`)) {
          uncovered.push(`${n.type}.${f.key}`);
        }
      }
    }
    expect(uncovered).toEqual([]);
  });

  it('documented uncovered fields are still absent from zod (guard against stale exceptions)', () => {
    for (const ref of KNOWN_UNCOVERED) {
      const [type, key] = ref.split('.');
      // If someone later ADDS the field to zod, this exception is stale — fail so it gets removed.
      expect(zodShapes[type] && key in zodShapes[type], `${ref} is now covered by zod — remove from KNOWN_UNCOVERED`).toBe(false);
    }
  });

  it('registry-required fields are enforced as required by zod (except documented draft relaxations)', () => {
    const notEnforced = [];
    for (const n of NODE_TYPE_REGISTRY) {
      const shape = zodShapes[n.type];
      if (!shape) continue;
      for (const f of n.configSchema || []) {
        if (!f.required) continue;
        const z = shape[f.key];
        if (z && z.isOptional() && !KNOWN_REQUIRED_RELAXATIONS.has(`${n.type}.${f.key}`)) {
          notEnforced.push(`${n.type}.${f.key}`);
        }
      }
    }
    expect(notEnforced).toEqual([]);
  });

  it('documented draft relaxations are still genuinely required in the registry (guard against stale exceptions)', () => {
    for (const ref of KNOWN_REQUIRED_RELAXATIONS) {
      const [type, key] = ref.split('.');
      const n = NODE_TYPE_REGISTRY.find(x => x.type === type);
      const f = (n?.configSchema || []).find(x => x.key === key);
      expect(f, `${ref} listed as a relaxation but not in registry`).toBeTruthy();
      expect(f.required, `${ref} no longer required in registry — remove from relaxations`).toBe(true);
    }
  });
});
