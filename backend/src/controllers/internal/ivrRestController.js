import { z } from 'zod';
import { asyncHandler } from '../../middleware/asyncHandler.js';
import { logger } from '../../infrastructure/index.js';

/**
 * POST /api/v1/internal/ivr/rest-call
 *
 * Backend proxy for the IVR `rest_api` node. The Lua executor sends the already
 * interpolated request (method/url/headers/body) plus a credential_name and
 * auth_type; this controller resolves the secret from backend env vars, applies
 * pluggable auth (including OAuth2 client-credentials with token caching),
 * performs the outbound call under a hard timeout, parses the response, applies
 * the node's response_mappings, and returns PII-safe structured results.
 *
 * The raw secret NEVER travels in the flow JSON or reaches Lua — only the
 * credential_name does. Response bodies (which may contain customer PII) are
 * never logged (governance O-7); only structured metadata is logged.
 *
 * Outcomes (drive the node's branches):
 *   success           2xx + parseable JSON
 *   http_error        non-2xx, network error, or credential/config error
 *   timeout           external call exceeded the configured timeout
 *   invalid_response  2xx but body was not parseable JSON
 */

const MAX_TIMEOUT_S = 15;

// Exported for unit testing — the OAuth2 token cache (per credential_name).
export const _oauthTokenCache = new Map();

const RestCallSchema = z.object({
  credential_name:   z.string().max(64).optional().nullable(),
  auth_type:         z.string().max(48).optional().nullable(),
  auth_param_name:   z.string().max(64).optional().nullable(),
  method:            z.string().max(10).optional().default('GET'),
  url:               z.string().min(1).max(4096),
  headers:           z.string().max(8192).optional().nullable(),   // JSON text
  body:              z.string().max(16384).optional().nullable(),
  timeout_seconds:   z.number().int().min(1).max(MAX_TIMEOUT_S).optional().default(10),
  response_mappings: z.string().max(8192).optional().nullable(),   // JSON array text
});

// Env-var credential registry (no DB). Convention:
//   IVR_CRED_<NAME>_<SUFFIX>, NAME upper-cased, non-alphanumerics → underscore.
export function credEnv(name, suffix) {
  const norm = String(name || '').toUpperCase().replace(/[^A-Z0-9]/g, '_');
  if (!norm) return undefined;
  return process.env[`IVR_CRED_${norm}_${suffix}`];
}

// Safe dot-path lookup into a parsed JSON object (e.g. "data.items.0.balance").
export function getByPath(obj, path) {
  if (obj == null || !path) return undefined;
  let cur = obj;
  for (const seg of String(path).split('.')) {
    if (cur == null) return undefined;
    cur = cur[seg];
  }
  return cur;
}

function parseJsonSafe(text, fallback) {
  if (text == null || text === '') return fallback;
  try { return JSON.parse(text); } catch { return fallback; }
}

// Resolve + apply auth. Mutates `headers` (and returns a possibly-updated url).
// Returns { ok, url, error }. Async because OAuth2 may fetch a token.
export async function applyAuth({ auth_type, credential_name, auth_param_name, url, headers, fetchImpl }) {
  const at = auth_type || 'none';
  if (at === 'none') return { ok: true, url };

  const doFetch = fetchImpl || fetch;

  switch (at) {
    case 'api_key_header': {
      const key = credEnv(credential_name, 'KEY');
      if (!key || !auth_param_name) return { ok: false, error: 'credential_unresolved' };
      headers[auth_param_name] = key;
      return { ok: true, url };
    }
    case 'api_key_query': {
      const key = credEnv(credential_name, 'KEY');
      if (!key || !auth_param_name) return { ok: false, error: 'credential_unresolved' };
      const u = new URL(url);
      u.searchParams.set(auth_param_name, key);
      return { ok: true, url: u.toString() };
    }
    case 'basic': {
      const user = credEnv(credential_name, 'USER');
      const pass = credEnv(credential_name, 'PASS');
      if (user == null || pass == null) return { ok: false, error: 'credential_unresolved' };
      headers['Authorization'] = 'Basic ' + Buffer.from(`${user}:${pass}`).toString('base64');
      return { ok: true, url };
    }
    case 'bearer_static': {
      const token = credEnv(credential_name, 'TOKEN');
      if (!token) return { ok: false, error: 'credential_unresolved' };
      headers['Authorization'] = 'Bearer ' + token;
      return { ok: true, url };
    }
    case 'oauth2_client_credentials': {
      const token = await getOAuth2Token(credential_name, doFetch);
      if (!token) return { ok: false, error: 'credential_unresolved' };
      headers['Authorization'] = 'Bearer ' + token;
      return { ok: true, url };
    }
    default:
      return { ok: false, error: 'unsupported_auth_type' };
  }
}

// OAuth2 client-credentials token, cached per credential_name until ~expiry.
export async function getOAuth2Token(credential_name, fetchImpl) {
  const now = Date.now();
  const cached = _oauthTokenCache.get(credential_name);
  if (cached && cached.expiresAt > now + 5000) return cached.token;

  const clientId     = credEnv(credential_name, 'CLIENT_ID');
  const clientSecret = credEnv(credential_name, 'CLIENT_SECRET');
  const tokenUrl     = credEnv(credential_name, 'TOKEN_URL');
  const scope        = credEnv(credential_name, 'SCOPE');
  if (!clientId || !clientSecret || !tokenUrl) return null;

  const form = new URLSearchParams({ grant_type: 'client_credentials' });
  if (scope) form.set('scope', scope);

  const doFetch = fetchImpl || fetch;
  let res;
  try {
    res = await doFetch(tokenUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Authorization': 'Basic ' + Buffer.from(`${clientId}:${clientSecret}`).toString('base64'),
      },
      body: form.toString(),
    });
  } catch {
    return null;
  }
  if (!res || !res.ok) return null;
  let json;
  try { json = await res.json(); } catch { return null; }
  const token = json && json.access_token;
  if (!token) return null;
  const ttlMs = ((json.expires_in && Number(json.expires_in)) || 3600) * 1000;
  _oauthTokenCache.set(credential_name, { token, expiresAt: now + ttlMs });
  return token;
}

// Core logic, separated from the Express wrapper for unit testing.
// `fetchImpl` is injectable so tests can mock the external HTTP call.
export async function performRestCall(input, fetchImpl) {
  const parsed = RestCallSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, status: 0, outcome: 'http_error', vars: {}, error: 'bad_request' };
  }
  const cfg = parsed.data;
  const method = String(cfg.method || 'GET').toUpperCase();
  const timeoutMs = Math.min(Math.max(cfg.timeout_seconds || 10, 1), MAX_TIMEOUT_S) * 1000;
  const doFetch = fetchImpl || fetch;

  const headers = { ...(parseJsonSafe(cfg.headers, {}) || {}) };

  // Resolve + apply auth (secret stays server-side).
  const auth = await applyAuth({
    auth_type: cfg.auth_type, credential_name: cfg.credential_name,
    auth_param_name: cfg.auth_param_name, url: cfg.url, headers, fetchImpl: doFetch,
  });
  if (!auth.ok) {
    return { ok: false, status: 0, outcome: 'http_error', vars: {}, error: auth.error };
  }
  const url = auth.url;

  const hasBody = ['POST', 'PUT', 'PATCH'].includes(method) && cfg.body != null && cfg.body !== '';
  if (hasBody && !Object.keys(headers).some(h => h.toLowerCase() === 'content-type')) {
    headers['Content-Type'] = 'application/json';
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let res;
  try {
    res = await doFetch(url, {
      method,
      headers,
      body: hasBody ? cfg.body : undefined,
      signal: controller.signal,
    });
  } catch (err) {
    clearTimeout(timer);
    const outcome = (err && (err.name === 'AbortError' || err.code === 'ABORT_ERR')) ? 'timeout' : 'http_error';
    return { ok: false, status: 0, outcome, vars: {}, error: outcome === 'timeout' ? 'timeout' : 'network_error' };
  }
  clearTimeout(timer);

  const status = res.status;
  if (status < 200 || status >= 300) {
    return { ok: false, status, outcome: 'http_error', vars: {} };
  }

  let text = '';
  try { text = await res.text(); } catch { text = ''; }
  let json;
  try { json = JSON.parse(text); } catch { json = undefined; }
  if (json === undefined) {
    return { ok: false, status, outcome: 'invalid_response', vars: {} };
  }

  // Apply response_mappings (JSON array of { json_path, variable_name }).
  const vars = {};
  const mappings = parseJsonSafe(cfg.response_mappings, []) || [];
  if (Array.isArray(mappings)) {
    for (const m of mappings) {
      if (!m || typeof m.variable_name !== 'string' || typeof m.json_path !== 'string') continue;
      const val = getByPath(json, m.json_path);
      if (val !== undefined && val !== null && typeof val !== 'object') {
        vars[m.variable_name] = String(val);
      }
    }
  }
  return { ok: true, status, outcome: 'success', vars };
}

export const restCall = asyncHandler(async (req, res) => {
  const started = Date.now();
  const result = await performRestCall(req.body ?? {});
  const duration_ms = Date.now() - started;

  // PII-safe logging (O-7): status/outcome/credential_name/method/host/duration
  // and the machine-readable error REASON only — NEVER the url query, headers,
  // request/response bodies, or mapped values.
  let host = '';
  try { host = new URL(String((req.body && req.body.url) || '')).host; } catch { host = 'invalid-url'; }
  const fields = {
    module: 'ivr-rest',
    method: String((req.body && req.body.method) || 'GET').toUpperCase(),
    host,
    credential_name: (req.body && req.body.credential_name) || null,
    status: result.status,
    outcome: result.outcome,
    error: result.error ?? null,
    mapped_count: Object.keys(result.vars || {}).length,
    duration_ms,
  };
  // A credential/config problem (typo'd or unset IVR_CRED_* env, unsupported
  // auth type, or a bad request) routes to http_error just like a real external
  // failure — but it must be DISTINGUISHABLE in logs. Log those at WARN with an
  // explicit message + reason; genuine external outcomes stay at INFO.
  const isConfigError = result.error === 'credential_unresolved'
    || result.error === 'unsupported_auth_type'
    || result.error === 'bad_request';
  if (isConfigError) {
    logger?.warn?.(fields, `IVR rest_api call — credential/config error: ${result.error} (branch=${result.outcome})`);
  } else {
    logger?.info?.(fields, 'IVR rest_api proxy call');
  }

  // Return the outcome + mapped vars for the Lua executor. Always HTTP 200 to
  // the internal caller (the *outcome* field carries success/failure) so the
  // Lua side branches on outcome, not on this transport's status.
  res.json({ ok: result.ok, status: result.status, outcome: result.outcome, vars: result.vars || {} });
});
