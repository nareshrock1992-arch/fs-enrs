import { describe, it, expect } from 'vitest';
import { getPortsForNode, labelFor } from '../components/ivr/canvas/nodePorts.js';
import { renderSummaryTemplate, nodeSubtitleLines } from '../components/ivr/canvas/nodeSubtitle.js';

describe('labelFor — friendly port labels (keys unchanged)', () => {
  it('uses portLabels when present', () => {
    expect(labelFor('timeout', { timeout: 'No input' })).toBe('No input');
    expect(labelFor('true', { true: 'If true' })).toBe('If true');
  });
  it('turns DTMF digit/#/* keys into "Press <key>"', () => {
    expect(labelFor('2', undefined)).toBe('Press 2');
    expect(labelFor('#', {})).toBe('Press #');
  });
  it('never rewrites _default via the DTMF rule', () => {
    expect(labelFor('_default', undefined)).toBe('_default');
    expect(labelFor('_default', { _default: 'Any other' })).toBe('Any other');
  });
  it('falls back to the raw key when no mapping applies', () => {
    expect(labelFor('success', {})).toBe('success');
  });
});

describe('getPortsForNode applies portLabels', () => {
  it('gather: reserved keys friendly, digits become Press N, key unchanged', () => {
    const ports = getPortsForNode(
      { branches: { '1': 'a', timeout: 'b', _default: 'c' } },
      'branches', undefined,
      { timeout: 'No input', invalid: 'No match', _default: 'Any other' },
    );
    expect(ports).toEqual([
      { key: '1', label: 'Press 1' },
      { key: 'timeout', label: 'No input' },
      { key: '_default', label: 'Any other' },
    ]);
  });
  it('rest_api: declared outcomes get friendly labels but real keys stay', () => {
    const ports = getPortsForNode(
      { branches: {} },
      'branches',
      ['success', 'http_error', 'timeout', 'invalid_response'],
      { success: 'Success', http_error: 'HTTP error', timeout: 'Timeout', invalid_response: 'Bad response' },
    );
    expect(ports.map(p => p.key)).toEqual(['success', 'http_error', 'timeout', 'invalid_response']);
    expect(ports.map(p => p.label)).toEqual(['Success', 'HTTP error', 'Timeout', 'Bad response']);
  });
  it('condition true_false honors portLabels', () => {
    const ports = getPortsForNode({}, 'true_false', undefined, { true: 'If true', false: 'If false' });
    expect(ports).toEqual([{ key: 'true', label: 'If true' }, { key: 'false', label: 'If false' }]);
  });
  it('gather LEGACY mode (no max_attempts): shows timeout/invalid/_default, hides configurable keys', () => {
    const keys = getPortsForNode(
      { type: 'gather', branches: { '1': 'a', '2': 'b', _default: 'c' } },
      'branches', ['max_attempts_exceeded'],
      { _default: 'Any other', timeout: 'No input', invalid: 'No match' },
    ).map(p => p.key);
    expect(keys).toEqual(expect.arrayContaining(['1', '2', 'timeout', 'invalid', '_default']));
    expect(keys).not.toContain('max_attempts_exceeded');   // config-only, hidden in legacy mode
    expect(keys).not.toContain('no_input');
    expect(keys).not.toContain('invalid_length');
    expect(keys).not.toContain('invalid_option');
  });

  it('gather CONFIGURABLE mode: shows max_attempts_exceeded + retry-off reasons; HIDES unwired legacy timeout/invalid', () => {
    // Defaults: no_input=on, invalid_length=on, invalid_option=off.
    const keys = getPortsForNode(
      { type: 'gather', max_attempts: 2, branches: { '1': 'a', _default: 'c' } },
      'branches', ['max_attempts_exceeded'],
      { max_attempts_exceeded: 'Max attempts', invalid_option: 'Invalid option', _default: 'Any other' },
    ).map(p => p.key);
    expect(keys).toEqual(expect.arrayContaining(['1', 'invalid_option', 'max_attempts_exceeded', '_default']));
    expect(keys).not.toContain('no_input');        // retry on → hidden
    expect(keys).not.toContain('invalid_length');  // retry on → hidden
    expect(keys).not.toContain('timeout');         // legacy, unwired → hidden (no legacy/config mix)
    expect(keys).not.toContain('invalid');         // legacy, unwired → hidden
  });

  it('gather: NEVER shows both legacy and configurable key sets on a clean node', () => {
    const legacy = getPortsForNode({ type: 'gather', branches: { '1': 'a' } }, 'branches', ['max_attempts_exceeded'], {}).map(p => p.key);
    const config = getPortsForNode({ type: 'gather', max_attempts: 2, branches: { '1': 'a' } }, 'branches', ['max_attempts_exceeded'], {}).map(p => p.key);
    // legacy set present only in legacy mode; config terminal present only in config mode
    expect(legacy).toContain('timeout'); expect(legacy).not.toContain('max_attempts_exceeded');
    expect(config).toContain('max_attempts_exceeded'); expect(config).not.toContain('timeout');
  });

  it('gather: an internal event becomes an optional exit when its retry is disabled', () => {
    const keys = getPortsForNode(
      { type: 'gather', max_attempts: 2, retry_on_no_input: 'no', retry_on_invalid_option: 'yes', branches: { '1': 'a' } },
      'branches', ['max_attempts_exceeded'], { no_input: 'No input' },
    ).map(p => p.key);
    expect(keys).toContain('no_input');                // retry off → shown
    expect(keys).not.toContain('invalid_option');      // retry on → hidden
  });

  it('gather: a saved reason target is NOT rendered while its retry is on (data preserved, port hidden)', () => {
    const keys = getPortsForNode(
      { type: 'gather', max_attempts: 2, branches: { '1': 'a', no_input: 'someNode' } }, // retry_ni default on
      'branches', ['max_attempts_exceeded'], {},
    ).map(p => p.key);
    expect(keys).not.toContain('no_input');            // hidden by toggle; JSON target untouched
  });

  it('gather CONFIGURABLE mode: legacy timeout/invalid render ONLY when already wired (preserve active fallback)', () => {
    const keys = getPortsForNode(
      { type: 'gather', max_attempts: 2, branches: { '1': 'a', timeout: 't', invalid: 'i' } },
      'branches', ['max_attempts_exceeded'],
      { timeout: 'No input', invalid: 'No match', max_attempts_exceeded: 'Max attempts' },
    ).map(p => p.key);
    expect(keys).toContain('timeout');   // wired → preserved
    expect(keys).toContain('invalid');   // wired → preserved
  });

  it('gather EXTERNAL mode: shows timeout + invalid, NOT max_attempts_exceeded or reason ports', () => {
    const keys = getPortsForNode(
      { type: 'gather', retry_mode: 'external', branches: { '1': 'a', _default: 'c' } },
      'branches', ['max_attempts_exceeded'],
      { timeout: 'No input', invalid: 'Invalid', _default: 'Continue' },
    ).map(p => p.key);
    expect(keys).toEqual(expect.arrayContaining(['1', 'timeout', 'invalid', '_default']));
    expect(keys).not.toContain('max_attempts_exceeded');
    expect(keys).not.toContain('no_input');
    expect(keys).not.toContain('invalid_length');
    expect(keys).not.toContain('invalid_option');
  });

  it('gather INTERNAL mode: shows max_attempts_exceeded, NOT timeout/invalid (unwired)', () => {
    const keys = getPortsForNode(
      { type: 'gather', retry_mode: 'internal', max_attempts: 3, branches: { '1': 'a' } },
      'branches', ['max_attempts_exceeded'],
      { max_attempts_exceeded: 'Max attempts', invalid_option: 'Invalid option' },
    ).map(p => p.key);
    expect(keys).toContain('max_attempts_exceeded');
    expect(keys).toContain('invalid_option');   // retry off by default → optional exit
    expect(keys).not.toContain('timeout');
    expect(keys).not.toContain('invalid');
  });

  it('Continue (_default) is ALWAYS a connectable success output, even unwired', () => {
    // A. Internal, new/unwired
    const internal = getPortsForNode(
      { type: 'gather', retry_mode: 'internal', max_attempts: 3, branches: { '1': 'a' } },
      'branches', ['max_attempts_exceeded'], { _default: 'Continue' },
    ).map(p => p.key);
    expect(internal).toContain('_default');
    expect(internal).toContain('max_attempts_exceeded');   // E: unaffected
    // B. External, new/unwired
    const external = getPortsForNode(
      { type: 'gather', retry_mode: 'external', branches: { '1': 'a' } },
      'branches', ['max_attempts_exceeded'], { _default: 'Continue' },
    ).map(p => p.key);
    expect(external).toContain('_default');
    expect(external).toContain('timeout');                 // E: unaffected
    expect(external).toContain('invalid');                 // E: unaffected
    expect(external).not.toContain('max_attempts_exceeded');
    // C. Legacy (no retry_mode / no max_attempts), unwired _default
    const legacy = getPortsForNode(
      { type: 'gather', branches: { '1': 'a' } },
      'branches', ['max_attempts_exceeded'], { _default: 'Continue' },
    ).map(p => p.key);
    expect(legacy).toContain('_default');
    expect(legacy).toContain('timeout');
    expect(legacy).toContain('invalid');
  });

  it('D: wired branches (digits + wired _default) remain present and unchanged', () => {
    const keys = getPortsForNode(
      { type: 'gather', retry_mode: 'internal', max_attempts: 3, branches: { '1': 'a', '2': 'b', _default: 'cont' } },
      'branches', ['max_attempts_exceeded'], {},
    ).map(p => p.key);
    expect(keys).toEqual(expect.arrayContaining(['1', '2', '_default', 'max_attempts_exceeded']));
    // _default appears exactly once (not duplicated by the always-push)
    expect(keys.filter(k => k === '_default')).toHaveLength(1);
  });

  it('rest_api ports are unaffected by gather internal-event gating', () => {
    const ports = getPortsForNode(
      { type: 'rest_api', branches: {} },
      'branches', ['success', 'http_error', 'timeout', 'invalid_response'],
      {},
    );
    expect(ports.map(p => p.key)).toEqual(['success', 'http_error', 'timeout', 'invalid_response']);
  });
});

describe('renderSummaryTemplate — id/token resolution with graceful fallback', () => {
  const resolvers = {
    ens_config: id => ({ 5: 'SCC Alert' }[id]),
    operator: op => ({ ens_pin_valid: 'PIN valid', gte: '≥' }[op]),
    node: id => ({ n2: 'Main menu' }[id]),
  };
  it('resolves a config id to its name', () => {
    const cfg = { summaryTemplate: 'ENS: ${ens_configuration_id}', summaryResolve: { ens_configuration_id: 'ens_config' } };
    expect(renderSummaryTemplate({ ens_configuration_id: 5 }, cfg, resolvers)).toBe('ENS: SCC Alert');
  });
  it('falls back to the raw id when the name is not loaded', () => {
    const cfg = { summaryTemplate: 'ENS: ${ens_configuration_id}', summaryResolve: { ens_configuration_id: 'ens_config' } };
    expect(renderSummaryTemplate({ ens_configuration_id: 99 }, cfg, resolvers)).toBe('ENS: 99');
  });
  it('humanizes the condition operator', () => {
    const cfg = { summaryTemplate: '${variable} ${operator} ${expected_value}', summaryResolve: { operator: 'operator' } };
    expect(renderSummaryTemplate({ variable: 'gather_result', operator: 'ens_pin_valid', expected_value: 'x' }, cfg, resolvers))
      .toBe('gather_result PIN valid x');
  });
  it('Go To Node resolves target_node_id → node name (no description)', () => {
    const cfg = { summaryTemplate: '→ ${target_node_id}', summaryResolve: { target_node_id: 'node' } };
    const r = nodeSubtitleLines({ type: 'goto', target_node_id: 'n2' }, cfg, resolvers);
    expect(r.primary).toBe('→ Main menu');
  });
});
