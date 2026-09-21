/**
 * Canvas clarity: improved summaryTemplates, id→name summaryResolve maps, and
 * friendly portLabels — display-only registry data, exposed via publicNodeTypes.
 */
import { describe, it, expect } from 'vitest';
import { getNodeType, publicNodeTypes } from '../../nodeTypes/registry.js';

describe('summaryTemplate rewrites', () => {
  it('gather no longer says "max ... digit"', () => {
    expect(getNodeType('gather').summaryTemplate).toBe('Collect ${max_digits} digit(s) · ${timeout_seconds}s');
  });
  it('ens_playback subtitle is no longer redundant with its title', () => {
    expect(getNodeType('ens_playback').summaryTemplate).toBe('Play latest ENS message');
  });
  it('config nodes label their config (resolved to a name at render time)', () => {
    expect(getNodeType('ens').summaryTemplate).toBe('ENS: ${ens_configuration_id}');
    expect(getNodeType('ers').summaryTemplate).toBe('ERS: ${ers_configuration_id}');
    expect(getNodeType('ers_ring_all').summaryTemplate).toBe('ERS: ${ers_configuration_id} · ${tier}');
    expect(getNodeType('ers_overflow_wait').summaryTemplate).toBe('Wait ${max_wait_seconds}s · ERS: ${ers_configuration_id}');
    expect(getNodeType('ens_blast_record').summaryTemplate).toBe('ENS: ${ens_configuration_id}');
    expect(getNodeType('ers_overflow_check').summaryTemplate).toBe('ERS: ${ers_configuration_id}');
  });
});

describe('summaryResolve maps (id/token → name)', () => {
  it('config ids resolve via ens_config/ers_config', () => {
    expect(getNodeType('ens').summaryResolve).toEqual({ ens_configuration_id: 'ens_config' });
    expect(getNodeType('ers').summaryResolve).toEqual({ ers_configuration_id: 'ers_config' });
    expect(getNodeType('ers_ring_all').summaryResolve).toEqual({ ers_configuration_id: 'ers_config' });
    expect(getNodeType('ens_blast_record').summaryResolve).toEqual({ ens_configuration_id: 'ens_config' });
  });
  it('goto resolves target_node_id → node name', () => {
    expect(getNodeType('goto').summaryResolve).toEqual({ target_node_id: 'node' });
  });
  it('condition resolves the operator token', () => {
    expect(getNodeType('condition').summaryResolve).toEqual({ operator: 'operator' });
  });
});

describe('portLabels (display only — branch keys unchanged)', () => {
  it('gather reserved keys get friendly labels', () => {
    expect(getNodeType('gather').portLabels).toEqual({
      timeout: 'No input', invalid: 'No match', _default: 'Any other', max_attempts_exceeded: 'Max attempts',
    });
  });
  it('rest_api outcomes get friendly labels', () => {
    expect(getNodeType('rest_api').portLabels).toMatchObject({ http_error: 'HTTP error', invalid_response: 'Bad response' });
  });
  it('condition true/false get friendly labels', () => {
    expect(getNodeType('condition').portLabels).toEqual({ true: 'If true', false: 'If false' });
  });
  it('ens_playback + ers_overflow_check outcomes get friendly labels', () => {
    expect(getNodeType('ens_playback').portLabels.no_campaign).toBe('No message');
    expect(getNodeType('ers_overflow_check').portLabels.full).toBe('Both busy');
  });
});

describe('publicNodeTypes exposes the new display fields to the frontend', () => {
  it('includes portLabels + summaryResolve', () => {
    const gather = publicNodeTypes().find(n => n.type === 'gather');
    const cond   = publicNodeTypes().find(n => n.type === 'condition');
    expect(gather.portLabels).toBeTruthy();
    expect(cond.summaryResolve).toEqual({ operator: 'operator' });
  });
});

describe('gather exposes a wireable max_attempts_exceeded outcome (in-node retry exit)', () => {
  it('declares the reserved branch key alongside dynamic digit branches', () => {
    const gather = getNodeType('gather');
    expect(gather.branchKeys).toEqual(['max_attempts_exceeded']);
    expect(gather.digitBranches).toBe(true);
  });
  it('publicNodeTypes surfaces branchKeys + digitBranches so the editor can render the hybrid port', () => {
    const gather = publicNodeTypes().find(n => n.type === 'gather');
    expect(gather.branchKeys).toEqual(['max_attempts_exceeded']);
    expect(gather.digitBranches).toBe(true);
  });
  it('rest_api stays fixed-only (no dynamic digit branches)', () => {
    const rest = publicNodeTypes().find(n => n.type === 'rest_api');
    expect(rest.branchKeys.length).toBeGreaterThan(0);
    expect(rest.digitBranches).toBeFalsy();
  });
});
