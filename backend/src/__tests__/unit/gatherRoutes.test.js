// DTMF redesign: route rules, regex→Lua translation, warnings, and the
// validator changes (draft vs publish).
import { describe, it, expect } from 'vitest';
import {
  regexToLuaPattern, routeError, routeMatches, firstMatchingRoute, routeLabel, routeWarnings,
} from '../../utils/gatherRoutes.js';
import { UpdateFlowSchema, PublishedGraphSchema } from '../../validators/ivrValidator.js';

describe('regex subset → Lua pattern', () => {
  it.each([
    ['^[2-4]\\d{3}$', '^[2-4]%d%d%d$'],
    ['^1\\d{1,2}#?$', '^1%d%d?#?$'],
    ['^9\\d+$', '^9%d+$'],
    ['\\*\\d{2,}', '%*%d%d%d*'],
    ['^0.\\d$', '^0.%d$'],
  ])('%s → %s', (rx, lua) => expect(regexToLuaPattern(rx)).toBe(lua));
  it.each(['^(12|34)$', '1|2', '(\\d)', '^\\w+$', '{3}', '\\d{3,1}', '[12'])('rejects %s', rx => {
    expect(regexToLuaPattern(rx)).toBeNull();
  });
});

describe('route rules', () => {
  it('every rule type matches as documented', () => {
    expect(routeMatches({ type: 'equals', value: '1234' }, '1234')).toBe(true);
    expect(routeMatches({ type: 'one_of', value: '1001, 1002' }, '1002')).toBe(true);
    expect(routeMatches({ type: 'range', value: '1000', value2: '1999' }, '1999')).toBe(true);
    expect(routeMatches({ type: 'range', value: '1000', value2: '1999' }, '12#4')).toBe(false);
    expect(routeMatches({ type: 'starts_with', value: '9' }, '9001')).toBe(true);
    expect(routeMatches({ type: 'length', value: '6' }, '123456')).toBe(true);
    expect(routeMatches({ type: 'pattern', value: '^[2-4]\\d{3}$' }, '3999')).toBe(true);
    expect(routeMatches({ type: 'pattern', value: '^(1)$' }, '1')).toBe(false);   // unsupported → never
  });
  it('first match wins', () => {
    const routes = [{ id: 'a', type: 'starts_with', value: '1' }, { id: 'b', type: 'equals', value: '1234' }];
    expect(firstMatchingRoute(routes, '1234').id).toBe('a');
    expect(firstMatchingRoute(routes, '2000')).toBeNull();
  });
  it('errors: empty value, bad bounds, bad length, bad or unsupported pattern', () => {
    expect(routeError({ type: 'equals', value: '' })).toMatch(/needs a value/);
    expect(routeError({ type: 'one_of', value: ' , ' })).toMatch(/at least one/);
    expect(routeError({ type: 'range', value: '2000', value2: '1000' })).toMatch(/larger/);
    expect(routeError({ type: 'range', value: '10', value2: 'x' })).toMatch(/whole numbers/);
    expect(routeError({ type: 'length', value: '30' })).toMatch(/1–20/);
    expect(routeError({ type: 'pattern', value: '[' })).toMatch(/compile/);
    expect(routeError({ type: 'pattern', value: '^(1|2)$' })).toMatch(/unsupported/);
    expect(routeError({ type: 'equals', value: '12a' })).toMatch(/digits/);
    expect(routeError({ type: 'equals', value: '12' })).toBeNull();
  });
  it('labels', () => {
    expect(routeLabel({ type: 'equals', value: '1234' })).toBe('= 1234');
    expect(routeLabel({ type: 'range', value: '1000', value2: '1999' })).toBe('1000–1999');
    expect(routeLabel({ type: 'starts_with', value: '9' })).toBe('9…');
    expect(routeLabel({ type: 'length', value: '6' })).toBe('6 digits');
    expect(routeLabel({ type: 'one_of', value: '1, 2, 3, 4' })).toBe('1, 2, +2');
    expect(routeLabel({ type: 'equals', value: '1', name: 'Manager' })).toBe('Manager');
  });
  it('warnings: unreachable and overlapping routes', () => {
    const w = routeWarnings([
      { type: 'range', value: '1000', value2: '1999' },
      { type: 'equals', value: '1234' },
      { type: 'range', value: '1500', value2: '2500' },
      { type: 'range', value: '1100', value2: '1200' },
      { type: 'length', value: '4' },
      { type: 'length', value: '4' },
      { type: 'starts_with', value: '9' },
      { type: 'starts_with', value: '91' },
      { type: 'one_of', value: '1001, 30000' },
    ]);
    const byIndex = i => w.filter(x => x.index === i).map(x => x.message).join(' | ');
    expect(byIndex(1)).toMatch(/can never match/);
    expect(byIndex(2)).toMatch(/overlaps/);
    expect(byIndex(3)).toMatch(/can never match/);
    expect(byIndex(5)).toMatch(/can never match/);
    expect(byIndex(7)).toMatch(/can never match/);
    expect(byIndex(8)).toMatch(/1001 in .* is caught first/);
    expect(byIndex(0)).toBe('');
  });
});

describe('validator: drafts are lenient, Validate/Publish are strict', () => {
  const gather = extra => ({ type: 'gather', config_version: 2, retry_mode: 'internal', max_attempts: 3, branches: {}, ...extra });
  const draft = node => UpdateFlowSchema.safeParse({ graph: { entry_node_id: 'g', nodes: { g: node } } });
  const publish = node => PublishedGraphSchema.safeParse({ entry_node_id: 'g', nodes: { g: node, h: { type: 'hangup' } } });

  it('a brand-new Menu with no exit can be saved as a draft (was "Save failed")', () => {
    expect(draft(gather()).success).toBe(true);
  });
  it('…but Validate/Publish still require an exit', () => {
    const r = publish(gather());
    expect(r.success).toBe(false);
    expect(JSON.stringify(r.error.issues)).toMatch(/at least one branch/);
  });
  it('routes, failure_exits and option_labels survive a draft save', () => {
    const node = gather({
      routes: [{ id: 'a', type: 'equals', value: '1234', name: 'VIP' }],
      failure_exits: 'separate', option_labels: { 1: 'Sales' }, branches: { route_a: 'h' },
    });
    const r = draft(node);
    expect(r.success).toBe(true);
    const saved = r.data.graph.nodes.g;
    expect(saved.routes).toEqual(node.routes);
    expect(saved.failure_exits).toBe('separate');
    expect(saved.option_labels).toEqual({ 1: 'Sales' });
  });
  it('an incomplete route saves as a draft but fails publish', () => {
    const node = gather({ routes: [{ id: 'a', type: 'equals', value: '' }], branches: { route_a: 'h' } });
    expect(draft(node).success).toBe(true);
    const r = publish(node);
    expect(r.success).toBe(false);
    expect(JSON.stringify(r.error.issues)).toMatch(/needs a value/);
  });
  it('rejects unsupported patterns, duplicate ids and bad ids', () => {
    expect(publish(gather({ routes: [{ id: 'a', type: 'pattern', value: '^(1|2)$' }], branches: { route_a: 'h' } })).success).toBe(false);
    expect(publish(gather({ routes: [{ id: 'a', type: 'equals', value: '1' }, { id: 'a', type: 'equals', value: '2' }], branches: { route_a: 'h' } })).success).toBe(false);
    expect(draft(gather({ routes: [{ id: 'Bad Id', type: 'equals', value: '1' }] })).success).toBe(false);
  });
  it('failure_exits requires the configurable retry model (rule R1)', () => {
    const r = publish({ type: 'gather', failure_exits: 'separate', branches: { 1: 'h' } });
    expect(r.success).toBe(false);
    expect(JSON.stringify(r.error.issues)).toMatch(/require max_attempts/);
  });
});
