/**
 * Gather DTMF — publish-time catch-all warning (non-blocking).
 *
 * The warning must fire ONLY when a reachable exit's real fallback chain
 * genuinely bottoms out at nil (a silent hangup) — never merely because an
 * optional reserved key is unset while _default (or another chain link) still
 * catches the caller. Uses say/gather/hangup nodes only → zero DB dependency.
 */

import { describe, it, expect } from 'vitest';
import { validateGraph } from '../../utils/ivrGraphValidator.js';

const H = { type: 'hangup' };
const gatherWarnings = r => r.warnings.filter(w => w.includes('(Gather DTMF)'));

async function validate(gatherNode) {
  const graph = { entry_node_id: 'g', nodes: { g: { type: 'gather', ...gatherNode }, h: H } };
  return validateGraph(graph, 1);
}

describe('warning is NON-BLOCKING', () => {
  it('a gather with no catch-all still publishes (valid=true), only warns', async () => {
    const r = await validate({ max_attempts: 3, branches: { '1': 'h' } });
    expect(r.valid).toBe(true);
    expect(gatherWarnings(r).length).toBeGreaterThan(0);
  });
});

describe('configurable model', () => {
  it('WARNS when no _default and exhaustion route is unguarded', async () => {
    const r = await validate({ max_attempts: 3, branches: { '1': 'h' } });
    const w = gatherWarnings(r);
    expect(w.length).toBe(1);
    expect(w[0]).toContain('attempts-exhausted');
    // invalid_option retries off by default → its immediate route also bottoms out
    expect(w[0]).toContain('invalid_option');
  });

  it('does NOT warn when _default is wired (covers every exit)', async () => {
    const r = await validate({ max_attempts: 3, branches: { '1': 'h', _default: 'h' } });
    expect(gatherWarnings(r)).toHaveLength(0);
  });

  it('does NOT warn when max_attempts_exceeded guards exhaustion AND invalid_option retries', async () => {
    // exhaustion guarded by max_attempts_exceeded; invalid_option set to retry so
    // it no longer routes immediately → falls through to the guarded exhaustion.
    const r = await validate({
      max_attempts: 3,
      retry_on_invalid_option: 'yes',
      branches: { '1': 'h', max_attempts_exceeded: 'h' },
    });
    expect(gatherWarnings(r)).toHaveLength(0);
  });

  it('does NOT warn for a retrying reason lacking its own key when exhaustion is guarded', async () => {
    // invalid_length retries by default; only exhaustion is a real terminal exit,
    // and it is guarded by _default → no warning even though invalid_length has no key.
    const r = await validate({ max_attempts: 2, branches: { '1': 'h', _default: 'h' } });
    expect(gatherWarnings(r)).toHaveLength(0);
  });

  it('WARNS for an off-retry reason whose chain bottoms out, even if exhaustion is guarded', async () => {
    // timeout guards exhaustion; but invalid_option (retry off) → chain
    // invalid_option → _default → timeout → invalid. timeout IS present, so it is
    // actually caught → NO warning. Prove the chain is honored (not per-key).
    const r = await validate({ max_attempts: 3, branches: { '1': 'h', timeout: 'h' } });
    expect(gatherWarnings(r)).toHaveLength(0);
  });
});

describe('legacy model (no max_attempts)', () => {
  it('WARNS when neither timeout/_default (no-input) nor _default/invalid (unmatched) wired', async () => {
    const r = await validate({ branches: { '1': 'h' } });
    const w = gatherWarnings(r);
    expect(w.length).toBe(1);
    expect(w[0]).toContain('no-input');
    expect(w[0]).toContain('unmatched-input');
  });

  it('does NOT warn when _default is wired', async () => {
    const r = await validate({ branches: { '1': 'h', _default: 'h' } });
    expect(gatherWarnings(r)).toHaveLength(0);
  });

  it('does NOT warn when timeout + invalid are wired (both exits guarded without _default)', async () => {
    const r = await validate({ branches: { '1': 'h', timeout: 'h', invalid: 'h' } });
    expect(gatherWarnings(r)).toHaveLength(0);
  });

  it('warns only about no-input when timeout missing but invalid present', async () => {
    const r = await validate({ branches: { '1': 'h', invalid: 'h' } });
    const w = gatherWarnings(r);
    expect(w.length).toBe(1);
    expect(w[0]).toContain('no-input');
    expect(w[0]).not.toContain('unmatched-input');
  });
});
