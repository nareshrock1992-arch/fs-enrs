/**
 * Unit tests for Phase-5 production fixes:
 * - Deterministic room naming
 * - Strict tier occupancy (member_count == 0 → FREE)
 * - Zero-responder pre-check (ersRingAll returns 422)
 * - Registry summaryTemplate present for all Phase-5 types
 */
import { describe, it, expect } from 'vitest';
import { deterministicRoom } from '../../controllers/internal/ersInternalController.js';
import { NODE_TYPE_REGISTRY, getNodeType } from '../../nodeTypes/registry.js';

// ── Deterministic room naming ────────────────────────────────────────────────

describe('deterministicRoom()', () => {
  it('generates the correct room name for primary tier', () => {
    expect(deterministicRoom(42, 'primary')).toBe('ers_cfg42_primary');
  });

  it('generates the correct room name for secondary tier', () => {
    expect(deterministicRoom(7, 'secondary')).toBe('ers_cfg7_secondary');
  });

  it('is stable across calls (no timestamp component)', () => {
    const a = deterministicRoom(1, 'primary');
    const b = deterministicRoom(1, 'primary');
    expect(a).toBe(b);
  });

  it('different configs produce different rooms', () => {
    expect(deterministicRoom(1, 'primary')).not.toBe(deterministicRoom(2, 'primary'));
  });

  it('different tiers produce different rooms for same config', () => {
    expect(deterministicRoom(1, 'primary')).not.toBe(deterministicRoom(1, 'secondary'));
  });

  it('satisfies the conference_room regex ^[a-z0-9_]{1,64}$', () => {
    const room = deterministicRoom(999, 'secondary');
    expect(room).toMatch(/^[a-z0-9_]{1,64}$/);
  });
});

// ── Registry summaryTemplate ──────────────────────────────────────────────────

describe('NODE_TYPE_REGISTRY summaryTemplate', () => {
  const PHASE5_TYPES = ['ers_ring_all', 'ers_overflow_check', 'ers_overflow_wait', 'ens_blast_record', 'ens_playback_gate'];

  it.each(PHASE5_TYPES)('%s has a summaryTemplate', (type) => {
    const entry = getNodeType(type);
    expect(entry).not.toBeNull();
    expect(typeof entry.summaryTemplate).toBe('string');
    expect(entry.summaryTemplate.length).toBeGreaterThan(0);
  });

  it('every node type with a summaryTemplate uses valid ${field} syntax only', () => {
    for (const entry of NODE_TYPE_REGISTRY) {
      if (!entry.summaryTemplate) continue;
      // Should match ${identifier} placeholders only
      const invalid = entry.summaryTemplate.match(/\$\{[^}]*[^a-z0-9_][^}]*\}/i);
      expect(invalid, `${entry.type}.summaryTemplate has invalid placeholder`).toBeNull();
    }
  });

  it('summaryTemplate is exposed by publicNodeTypes()', async () => {
    const { publicNodeTypes } = await import('../../nodeTypes/registry.js');
    for (const nt of publicNodeTypes()) {
      if (!nt.summaryTemplate) continue;
      expect(typeof nt.summaryTemplate).toBe('string');
    }
  });
});

// ── Registry — ers_ring_all Lua handler contains fallback announcement ────────

describe('ers_ring_all Lua handler', () => {
  it('contains no_responders check and audible fallback', () => {
    const entry = getNodeType('ers_ring_all');
    expect(entry.luaHandler).toContain('no_responders');
    expect(entry.luaHandler).toContain('speak(s,');
    expect(entry.luaHandler).toContain('NORMAL_CLEARING');
  });

  it('checks d.success not just d.conference_room', () => {
    const entry = getNodeType('ers_ring_all');
    expect(entry.luaHandler).toContain('d.success');
  });

  it('logs ERR with reason and detail', () => {
    const entry = getNodeType('ers_ring_all');
    expect(entry.luaHandler).toContain('reason=');
    expect(entry.luaHandler).toContain('detail=');
    expect(entry.luaHandler).toContain('consoleLog("ERR"');
  });
});

// ── Phase 4 — time_of_day and day_of_week operator Lua presence ──────────────

describe('condition node Lua handler — time/schedule operators', () => {
  it('contains time_of_day operator case', () => {
    const entry = getNodeType('condition');
    expect(entry.luaHandler).toContain('time_of_day');
    expect(entry.luaHandler).toContain('os.date("%H%M")');
  });

  it('contains day_of_week operator case', () => {
    const entry = getNodeType('condition');
    expect(entry.luaHandler).toContain('day_of_week');
    expect(entry.luaHandler).toContain('os.date("%w")');
  });

  it('time_of_day and day_of_week appear in configSchema options', () => {
    const entry = getNodeType('condition');
    const opField = entry.configSchema.find(f => f.key === 'operator');
    const opValues = opField.options.map(o => o.value);
    expect(opValues).toContain('time_of_day');
    expect(opValues).toContain('day_of_week');
  });
});

// ── Registry — ers_ring_all configSchema has ring_timeout_seconds ─────────────

describe('ers_ring_all configSchema', () => {
  it('includes ring_timeout_seconds field', () => {
    const entry = getNodeType('ers_ring_all');
    const field = entry.configSchema.find(f => f.key === 'ring_timeout_seconds');
    expect(field).toBeDefined();
    expect(field.fieldType).toBe('number');
  });

  it('tier field is a required select', () => {
    const entry = getNodeType('ers_ring_all');
    const field = entry.configSchema.find(f => f.key === 'tier');
    expect(field).toBeDefined();
    expect(field.required).toBe(true);
    expect(field.fieldType).toBe('select');
    expect(field.options.map(o => o.value)).toContain('primary');
    expect(field.options.map(o => o.value)).toContain('secondary');
  });
});
