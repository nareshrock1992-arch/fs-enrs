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
  it('gather HYBRID: shows author digit branches AND the reserved max_attempts_exceeded outcome', () => {
    const ports = getPortsForNode(
      { branches: { '1': 'a', '2': 'b', _default: 'c' } },
      'branches',
      ['max_attempts_exceeded'],
      { _default: 'Any other', max_attempts_exceeded: 'Max attempts' },
    );
    // Declared reserved key first, then the author-defined digit/_default keys.
    expect(ports.map(p => p.key)).toEqual(['max_attempts_exceeded', '1', '2', '_default']);
    expect(ports[0]).toEqual({ key: 'max_attempts_exceeded', label: 'Max attempts' });
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
