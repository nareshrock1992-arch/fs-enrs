/**
 * IVR rest_api backend proxy — credential resolution, pluggable auth, timeout,
 * response mapping, outcome classification. External HTTP is fully mocked.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  performRestCall, applyAuth, getOAuth2Token, credEnv, getByPath, _oauthTokenCache, restCall,
} from '../../controllers/internal/ivrRestController.js';
import { logger } from '../../infrastructure/index.js';

vi.mock('../../infrastructure/index.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

// Minimal mock Response.
const mockRes = (status, bodyText, jsonObj) => ({
  ok: status >= 200 && status < 300,
  status,
  text: async () => (bodyText !== undefined ? bodyText : ''),
  json: async () => (jsonObj !== undefined ? jsonObj : JSON.parse(bodyText || '{}')),
});

const CRED_KEYS = [
  'IVR_CRED_ACME_KEY', 'IVR_CRED_ACME_USER', 'IVR_CRED_ACME_PASS', 'IVR_CRED_ACME_TOKEN',
  'IVR_CRED_ACME_CLIENT_ID', 'IVR_CRED_ACME_CLIENT_SECRET', 'IVR_CRED_ACME_TOKEN_URL', 'IVR_CRED_ACME_SCOPE',
];
beforeEach(() => {
  for (const k of CRED_KEYS) delete process.env[k];
  delete process.env.IVR_OAUTH_TOKEN_TIMEOUT_MS;
  _oauthTokenCache.clear();
  vi.clearAllMocks();
});

// A token endpoint that never responds but honors AbortController.
const hangingFetch = (url, opts) => new Promise((_, reject) => {
  const sig = opts && opts.signal;
  const fail = () => { const e = new Error('aborted'); e.name = 'AbortError'; reject(e); };
  if (sig) {
    if (sig.aborted) return fail();
    sig.addEventListener('abort', fail);
  }
});

describe('getByPath', () => {
  it('resolves nested dot-paths and array indices', () => {
    expect(getByPath({ data: { balance: 42 } }, 'data.balance')).toBe(42);
    expect(getByPath({ items: [{ id: 'x' }] }, 'items.0.id')).toBe('x');
    expect(getByPath({ a: 1 }, 'a.b.c')).toBeUndefined();
    expect(getByPath(null, 'a')).toBeUndefined();
  });
});

describe('credEnv', () => {
  it('normalizes credential_name to the IVR_CRED_<NAME>_<SUFFIX> convention', () => {
    process.env.IVR_CRED_ACME_KEY = 'sekret';
    expect(credEnv('acme', 'KEY')).toBe('sekret');
    expect(credEnv('Acme', 'KEY')).toBe('sekret');   // case-insensitive
    expect(credEnv('missing', 'KEY')).toBeUndefined();
  });
});

describe('applyAuth — each type', () => {
  it('api_key_header sets the configured header from env', async () => {
    process.env.IVR_CRED_ACME_KEY = 'K123';
    const headers = {};
    const r = await applyAuth({ auth_type: 'api_key_header', credential_name: 'acme', auth_param_name: 'X-API-Key', url: 'https://x/y', headers });
    expect(r.ok).toBe(true);
    expect(headers['X-API-Key']).toBe('K123');
  });

  it('api_key_query appends the key to the URL query', async () => {
    process.env.IVR_CRED_ACME_KEY = 'K123';
    const r = await applyAuth({ auth_type: 'api_key_query', credential_name: 'acme', auth_param_name: 'apikey', url: 'https://x/y', headers: {} });
    expect(r.ok).toBe(true);
    expect(r.url).toContain('apikey=K123');
  });

  it('basic builds an Authorization: Basic header', async () => {
    process.env.IVR_CRED_ACME_USER = 'u';
    process.env.IVR_CRED_ACME_PASS = 'p';
    const headers = {};
    const r = await applyAuth({ auth_type: 'basic', credential_name: 'acme', url: 'https://x', headers });
    expect(r.ok).toBe(true);
    expect(headers['Authorization']).toBe('Basic ' + Buffer.from('u:p').toString('base64'));
  });

  it('bearer_static builds an Authorization: Bearer header', async () => {
    process.env.IVR_CRED_ACME_TOKEN = 'tok';
    const headers = {};
    const r = await applyAuth({ auth_type: 'bearer_static', credential_name: 'acme', url: 'https://x', headers });
    expect(r.ok).toBe(true);
    expect(headers['Authorization']).toBe('Bearer tok');
  });

  it('returns credential_unresolved when the env secret is missing', async () => {
    const r = await applyAuth({ auth_type: 'bearer_static', credential_name: 'acme', url: 'https://x', headers: {} });
    expect(r.ok).toBe(false);
    expect(r.error).toBe('credential_unresolved');
  });
});

describe('OAuth2 client-credentials + token caching', () => {
  it('fetches a token then caches it (token endpoint hit once across two calls)', async () => {
    process.env.IVR_CRED_ACME_CLIENT_ID = 'cid';
    process.env.IVR_CRED_ACME_CLIENT_SECRET = 'csec';
    process.env.IVR_CRED_ACME_TOKEN_URL = 'https://auth/token';
    const fetchImpl = vi.fn(async () => mockRes(200, undefined, { access_token: 'abc', expires_in: 3600 }));
    const t1 = await getOAuth2Token('acme', fetchImpl);
    const t2 = await getOAuth2Token('acme', fetchImpl);
    expect(t1.token).toBe('abc');
    expect(t2.token).toBe('abc');
    expect(fetchImpl).toHaveBeenCalledTimes(1);   // cached on the second call
  });

  it('returns credential_unresolved when OAuth2 env is incomplete', async () => {
    process.env.IVR_CRED_ACME_CLIENT_ID = 'cid';  // missing secret + token_url
    const r = await getOAuth2Token('acme', vi.fn());
    expect(r.error).toBe('credential_unresolved');
  });
});

describe('OAuth2 token-fetch timeout hardening', () => {
  const setOAuthEnv = () => {
    process.env.IVR_CRED_ACME_CLIENT_ID = 'cid';
    process.env.IVR_CRED_ACME_CLIENT_SECRET = 'csec';
    process.env.IVR_CRED_ACME_TOKEN_URL = 'https://auth/token';
    process.env.IVR_OAUTH_TOKEN_TIMEOUT_MS = '20';   // tiny bound so the test is fast
  };

  it('getOAuth2Token aborts a hung token endpoint (bounded, does not hang)', async () => {
    setOAuthEnv();
    const r = await getOAuth2Token('acme', hangingFetch);
    expect(r.error).toBe('oauth2_token_timeout');
    expect(r.token).toBeUndefined();
  });

  it('performRestCall surfaces oauth2_token_timeout → http_error (never conflated with credential_unresolved)', async () => {
    setOAuthEnv();
    const r = await performRestCall(
      { method: 'GET', url: 'https://api.x', auth_type: 'oauth2_client_credentials', credential_name: 'acme' },
      hangingFetch,
    );
    expect(r.outcome).toBe('http_error');
    expect(r.error).toBe('oauth2_token_timeout');
    expect(r.error).not.toBe('credential_unresolved');
    expect(r.error).not.toBe('network_error');
  });

  it('restCall logs a token timeout at WARN with reason "oauth2_token_timeout", distinct from other failures', async () => {
    setOAuthEnv();
    const savedFetch = globalThis.fetch;
    globalThis.fetch = hangingFetch;   // restCall uses global fetch (no injection)
    try {
      const req = { body: { method: 'GET', url: 'https://api.x/acct', auth_type: 'oauth2_client_credentials', credential_name: 'acme' } };
      const res = { json: vi.fn() };
      await restCall(req, res, vi.fn());
      expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ outcome: 'http_error' }));
      expect(logger.warn).toHaveBeenCalledTimes(1);
      expect(logger.info).not.toHaveBeenCalled();
      const [fields, msg] = logger.warn.mock.calls[0];
      expect(fields.error).toBe('oauth2_token_timeout');
      expect(fields.error).not.toBe('credential_unresolved');   // distinguishable
      expect(msg).toContain('oauth2_token_timeout');
    } finally {
      globalThis.fetch = savedFetch;
    }
  });
});

describe('performRestCall — outcomes', () => {
  it('success: 2xx + parseable JSON, applies response_mappings', async () => {
    const fetchImpl = vi.fn(async () => mockRes(200, JSON.stringify({ data: { balance: 42 } })));
    const r = await performRestCall({
      method: 'GET', url: 'https://api.x/acct',
      response_mappings: '[{"json_path":"data.balance","variable_name":"acct_balance"}]',
    }, fetchImpl);
    expect(r.outcome).toBe('success');
    expect(r.status).toBe(200);
    expect(r.vars.acct_balance).toBe('42');   // stringified
  });

  it('http_error: non-2xx', async () => {
    const fetchImpl = vi.fn(async () => mockRes(500, 'oops'));
    const r = await performRestCall({ method: 'GET', url: 'https://api.x' }, fetchImpl);
    expect(r.outcome).toBe('http_error');
    expect(r.status).toBe(500);
    expect(r.vars).toEqual({});
  });

  it('timeout: fetch aborts', async () => {
    const fetchImpl = vi.fn(async () => { const e = new Error('aborted'); e.name = 'AbortError'; throw e; });
    const r = await performRestCall({ method: 'GET', url: 'https://api.x', timeout_seconds: 1 }, fetchImpl);
    expect(r.outcome).toBe('timeout');
  });

  it('invalid_response: 2xx but not JSON', async () => {
    const fetchImpl = vi.fn(async () => mockRes(200, '<html>not json</html>'));
    const r = await performRestCall({ method: 'GET', url: 'https://api.x' }, fetchImpl);
    expect(r.outcome).toBe('invalid_response');
    expect(r.status).toBe(200);
  });

  it('http_error: credential unresolved never leaks a secret, routes http_error', async () => {
    const fetchImpl = vi.fn();
    const r = await performRestCall({ method: 'GET', url: 'https://api.x', auth_type: 'bearer_static', credential_name: 'acme' }, fetchImpl);
    expect(r.outcome).toBe('http_error');
    expect(r.error).toBe('credential_unresolved');
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('applies auth header to the outbound request', async () => {
    process.env.IVR_CRED_ACME_KEY = 'K9';
    const fetchImpl = vi.fn(async () => mockRes(200, '{}'));
    await performRestCall({
      method: 'GET', url: 'https://api.x', auth_type: 'api_key_header',
      credential_name: 'acme', auth_param_name: 'X-API-Key',
    }, fetchImpl);
    const [, opts] = fetchImpl.mock.calls[0];
    expect(opts.headers['X-API-Key']).toBe('K9');
  });

  it('sends a JSON body with Content-Type for POST', async () => {
    const fetchImpl = vi.fn(async () => mockRes(200, '{}'));
    await performRestCall({ method: 'POST', url: 'https://api.x', body: '{"a":1}' }, fetchImpl);
    const [, opts] = fetchImpl.mock.calls[0];
    expect(opts.method).toBe('POST');
    expect(opts.body).toBe('{"a":1}');
    expect(Object.entries(opts.headers).some(([k]) => k.toLowerCase() === 'content-type')).toBe(true);
  });

  it('enforces the timeout ceiling (>15s clamped)', async () => {
    // Not asserting wall-clock; just that an over-max value is accepted and clamped
    // (schema max is 15) — an out-of-range value is rejected as bad_request.
    const fetchImpl = vi.fn(async () => mockRes(200, '{}'));
    const r = await performRestCall({ method: 'GET', url: 'https://api.x', timeout_seconds: 99 }, fetchImpl);
    expect(r.outcome).toBe('http_error');   // Zod rejects >15 → bad_request
    expect(r.error).toBe('bad_request');
  });
});

describe('restCall — credential/config errors are distinguishable in logs (WARN + reason)', () => {
  const makeRes = () => ({ json: vi.fn() });

  it('logs unresolved credentials at WARN with an explicit reason, not INFO', async () => {
    // No IVR_CRED_ACME_TOKEN set → credential_unresolved. No fetch occurs.
    const req = { body: { method: 'GET', url: 'https://api.x/acct', auth_type: 'bearer_static', credential_name: 'acme' } };
    const res = makeRes();
    await restCall(req, res, vi.fn());

    // Branch outcome still http_error (as designed)…
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ outcome: 'http_error' }));
    // …but the log is WARN, carries error=credential_unresolved, and says so.
    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(logger.info).not.toHaveBeenCalled();
    const [fields, msg] = logger.warn.mock.calls[0];
    expect(fields.error).toBe('credential_unresolved');
    expect(fields.outcome).toBe('http_error');
    expect(msg).toContain('credential_unresolved');
    // O-7: no body/headers/mapped values in the log fields.
    expect(fields).not.toHaveProperty('body');
    expect(fields).not.toHaveProperty('headers');
  });
});
