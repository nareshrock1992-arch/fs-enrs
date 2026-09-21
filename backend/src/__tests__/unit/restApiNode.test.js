/**
 * rest_api node — generator output, Zod schema, and catch-all warning.
 * The existing webhook node must remain untouched (fire-and-forget).
 */

import { describe, it, expect } from 'vitest';
import { generateIvrExecutorLua } from '../../utils/luaGenerator.js';
import { AnyNodeSchema } from '../../validators/ivrValidator.js';
import { validateGraph } from '../../utils/ivrGraphValidator.js';
import { getNodeType, publicNodeTypes } from '../../nodeTypes/registry.js';

const lua = generateIvrExecutorLua({ apiBase: 'http://x', apiKey: 'k', piperUrl: 'http://p' });

describe('generator — rest_api handler + helper', () => {
  it('emits exec_rest_api and registers it in the dispatch table', () => {
    expect(lua).toContain('local function exec_rest_api(s, node)');
    expect(lua).toMatch(/rest_api\s*= exec_rest_api,/);
  });
  it('calls the internal proxy endpoint (never a direct external curl with a secret)', () => {
    expect(lua).toContain('internal_post_t("/ivr/rest-call"');
    expect(lua).toContain('local function internal_post_t(url_path, body_obj, timeout_s)');
  });
  it('interpolates url/headers/body and branches on the returned outcome', () => {
    const block = lua.slice(lua.indexOf('local function exec_rest_api('), lua.indexOf('local function exec_ers_ring_all('));
    expect(block).toContain('interp(s, node.url)');
    expect(block).toContain('interp(s, node.headers_template or "")');
    expect(block).toContain('interp(s, node.body_template or "")');
    expect(block).toContain('for k, v in pairs(resp.vars)');
    expect(block).toContain('return br[outcome] or br["_default"]');
  });
  it('does NOT log resolved response values (O-7) — only status/outcome', () => {
    const block = lua.slice(lua.indexOf('local function exec_rest_api('), lua.indexOf('local function exec_ers_ring_all('));
    const logLine = block.split('\n').find(l => l.includes('consoleLog') && l.includes('status='));
    expect(logLine).toContain('outcome');
    expect(logLine).not.toContain('resp.vars');
    // and the mapping loop must not log at all
    const mapIdx = block.indexOf('for k, v in pairs(resp.vars)');
    const mapLine = block.slice(mapIdx, block.indexOf('\n', mapIdx));
    expect(mapLine).not.toContain('consoleLog');
  });
});

describe('generator — existing webhook node untouched (fire-and-forget)', () => {
  it('exec_webhook still present and still returns node.next after a bare curl', () => {
    const wb = lua.slice(lua.indexOf('local function exec_webhook('), lua.indexOf('local function exec_rest_api('));
    expect(wb).toContain('if h then h:close() end');
    expect(wb).toContain('return node.next');
    expect(wb).not.toContain('internal_post_t');   // webhook does not use the proxy
  });
});

describe('Zod — RestApiNodeSchema', () => {
  const base = { type: 'rest_api', url: 'https://api.x', branches: { success: 'h' } };
  it('accepts a minimal valid node (auth none)', () => {
    expect(AnyNodeSchema.safeParse(base).success).toBe(true);
  });
  it('accepts a full config incl. base description field', () => {
    const r = AnyNodeSchema.safeParse({
      ...base, method: 'POST', headers_template: '{"X":"${uuid}"}', body_template: '{"a":1}',
      auth_type: 'api_key_header', credential_name: 'acme', auth_param_name: 'X-API-Key',
      timeout_seconds: 8, response_mappings: '[{"json_path":"a.b","variable_name":"v"}]',
      description: 'Account lookup', branches: { success: 'h', _default: 'h' },
    });
    expect(r.success).toBe(true);
  });
  it('requires at least one branch', () => {
    expect(AnyNodeSchema.safeParse({ type: 'rest_api', url: 'https://x', branches: {} }).success).toBe(false);
  });
  it('rejects auth (non-none) without credential_name', () => {
    expect(AnyNodeSchema.safeParse({ ...base, auth_type: 'bearer_static' }).success).toBe(false);
  });
  it('rejects api_key auth without auth_param_name', () => {
    expect(AnyNodeSchema.safeParse({ ...base, auth_type: 'api_key_header', credential_name: 'acme' }).success).toBe(false);
  });
  it('has no raw-secret field (unknown keys stripped, credential_name only)', () => {
    const r = AnyNodeSchema.safeParse({ ...base, auth_type: 'bearer_static', credential_name: 'acme', secret: 'oops' });
    expect(r.success).toBe(true);
    expect(r.data.secret).toBeUndefined();   // stripped, never persisted
  });
  it('bounds timeout at 15s', () => {
    expect(AnyNodeSchema.safeParse({ ...base, timeout_seconds: 15 }).success).toBe(true);
    expect(AnyNodeSchema.safeParse({ ...base, timeout_seconds: 16 }).success).toBe(false);
  });
});

describe('branchKeys — declared fixed outcome ports exposed to the frontend', () => {
  it('rest_api declares its four outcome keys in the registry', () => {
    expect(getNodeType('rest_api').branchKeys).toEqual(
      ['success', 'http_error', 'timeout', 'invalid_response'],
    );
  });
  it('publicNodeTypes() exposes branchKeys for rest_api (canvas can read it)', () => {
    const pub = publicNodeTypes().find(n => n.type === 'rest_api');
    expect(pub).toBeTruthy();
    expect(pub.branchKeys).toEqual(['success', 'http_error', 'timeout', 'invalid_response']);
  });
  it('gather is HYBRID: reserved max_attempts_exceeded outcome + dynamic digit branches', () => {
    // Unlike rest_api (fixed-only), gather keeps author-defined digit keys AND
    // declares reserved outcome ports. digitBranches:true is what the branch
    // editor uses to keep the "+ Add digit branch" affordance.
    expect(getNodeType('gather').branchKeys).toEqual(['max_attempts_exceeded']);
    expect(getNodeType('gather').digitBranches).toBe(true);
  });
});

describe('panel guidance — panelIntro + per-field example (Parts 2/3)', () => {
  it('rest_api declares a panelIntro worked example, exposed by publicNodeTypes', () => {
    expect(getNodeType('rest_api').panelIntro).toMatch(/Example/);
    const pub = publicNodeTypes().find(n => n.type === 'rest_api');
    expect(pub.panelIntro).toMatch(/Example/);
  });
  it('every rest_api field carries a concrete example', () => {
    const fields = getNodeType('rest_api').configSchema;
    for (const key of ['method', 'url', 'auth_type', 'credential_name', 'auth_param_name',
                       'headers_template', 'body_template', 'timeout_seconds', 'response_mappings', 'branches']) {
      const f = fields.find(x => x.key === key);
      expect(f, `field ${key} exists`).toBeTruthy();
      expect(typeof f.example, `field ${key} has an example`).toBe('string');
      expect(f.example.length).toBeGreaterThan(0);
    }
  });
  it('credential_name example makes the env-var convention + no-secret rule concrete', () => {
    const f = getNodeType('rest_api').configSchema.find(x => x.key === 'credential_name');
    expect(f.example).toMatch(/IVR_CRED_ACME_KEY/);
    expect(f.example.toLowerCase()).toMatch(/never put the actual secret/);
  });
  it('simple nodes (hangup) do NOT force a panelIntro', () => {
    expect(getNodeType('hangup').panelIntro).toBeUndefined();
  });
});

describe('catch-all warning — real fallback chain (outcome → _default)', () => {
  const H = { type: 'hangup' };
  const gw = r => r.warnings.filter(w => w.includes('(REST API)'));
  const validate = branches =>
    validateGraph({ entry_node_id: 'r', nodes: { r: { type: 'rest_api', url: 'https://x', branches }, h: H } }, 1);

  it('warns for each outcome with no key AND no _default', async () => {
    const r = await validate({ success: 'h' });
    expect(gw(r)).toHaveLength(1);
    expect(gw(r)[0]).toContain('http_error');
    expect(gw(r)[0]).toContain('timeout');
    expect(gw(r)[0]).toContain('invalid_response');
    expect(gw(r)[0]).not.toContain('success');   // success IS wired
  });
  it('does NOT warn when _default is wired (covers all outcomes)', async () => {
    const r = await validate({ success: 'h', _default: 'h' });
    expect(gw(r)).toHaveLength(0);
  });
  it('does NOT warn when all four outcome keys are wired without _default', async () => {
    const r = await validate({ success: 'h', http_error: 'h', timeout: 'h', invalid_response: 'h' });
    expect(gw(r)).toHaveLength(0);
  });
  it('warning is non-blocking (valid stays true)', async () => {
    const r = await validate({ success: 'h' });
    expect(r.valid).toBe(true);
  });
});
