import { z } from 'zod';
import net from 'net';
import http from 'http';
import https from 'https';
import zlib from 'zlib';
import { URL } from 'url';
import { lookup as dnsLookup } from 'dns/promises';
import { lookup as dnsLookupCb } from 'dns';
import { asyncHandler } from '../../middleware/asyncHandler.js';
import { logger } from '../../infrastructure/index.js';
import { query } from '../../db/pool.js';
import { isProtectedVarName } from '../../utils/ivrProtectedVars.js';

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
  ivr_number:        z.string().max(64).optional().nullable(),     // number the call was routed on
});

// External responses larger than this are treated as invalid_response. Before the
// connect-time check there was no cap; 10 MiB is far above any IVR lookup response.
export const MAX_RESPONSE_BYTES = 10 * 1024 * 1024;
// Redirects are followed like fetch() followed them before Cycle 2, but every new address
// is checked, and credentials are not sent to a different host.
export const MAX_REDIRECTS = 5;

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
      const r = await getOAuth2Token(credential_name, doFetch);
      if (!r.token) return { ok: false, error: r.error || 'credential_unresolved' };
      headers['Authorization'] = 'Bearer ' + r.token;
      return { ok: true, url };
    }
    default:
      return { ok: false, error: 'unsupported_auth_type' };
  }
}

// OAuth2 token endpoints get a short, dedicated timeout — a token exchange
// should be quick and does not need the full external-call budget. Overridable
// via env for ops/testing. Default 5s.
function oauthTokenTimeoutMs() {
  return Number(process.env.IVR_OAUTH_TOKEN_TIMEOUT_MS) || 5000;
}

// OAuth2 client-credentials token, cached per credential_name until ~expiry.
// Returns { token } on success or { error } on failure so the caller can
// distinguish a token-endpoint timeout ("oauth2_token_timeout") from a missing/
// misconfigured credential ("credential_unresolved").
export async function getOAuth2Token(credential_name, fetchImpl) {
  const now = Date.now();
  const cached = _oauthTokenCache.get(credential_name);
  if (cached && cached.expiresAt > now + 5000) return { token: cached.token };

  const clientId     = credEnv(credential_name, 'CLIENT_ID');
  const clientSecret = credEnv(credential_name, 'CLIENT_SECRET');
  const tokenUrl     = credEnv(credential_name, 'TOKEN_URL');
  const scope        = credEnv(credential_name, 'SCOPE');
  if (!clientId || !clientSecret || !tokenUrl) return { error: 'credential_unresolved' };

  const form = new URLSearchParams({ grant_type: 'client_credentials' });
  if (scope) form.set('scope', scope);

  const doFetch = fetchImpl || fetch;
  // Bound the token fetch with its own AbortController (same pattern as the main
  // external call) so a hung token endpoint can never block indefinitely.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), oauthTokenTimeoutMs());
  let res;
  try {
    res = await doFetch(tokenUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Authorization': 'Basic ' + Buffer.from(`${clientId}:${clientSecret}`).toString('base64'),
      },
      body: form.toString(),
      signal: controller.signal,
    });
  } catch (err) {
    clearTimeout(timer);
    if (err && (err.name === 'AbortError' || err.code === 'ABORT_ERR')) {
      return { error: 'oauth2_token_timeout' };
    }
    return { error: 'credential_unresolved' };
  }
  clearTimeout(timer);
  if (!res || !res.ok) return { error: 'credential_unresolved' };
  let json;
  try { json = await res.json(); } catch { return { error: 'credential_unresolved' }; }
  const token = json && json.access_token;
  if (!token) return { error: 'credential_unresolved' };
  const ttlMs = ((json.expires_in && Number(json.expires_in)) || 3600) * 1000;
  _oauthTokenCache.set(credential_name, { token, expiresAt: now + ttlMs });
  return { token };
}

// ── Outbound URL rules ────────────────────────────────────────────────────────
// The URL comes from a tenant-authored flow and the call runs on this server, so it
// must not reach the server itself or cloud metadata. Private addresses stay allowed
// (an on-premise CRM is a normal integration) unless IVR_REST_BLOCK_PRIVATE=true.
export function isForbiddenAddress(address, blockPrivate = false) {
  const ip = String(address).toLowerCase().replace(/^::ffff:/, '');
  const kind = net.isIP(ip);
  if (kind === 4) {
    const [a, b] = ip.split('.').map(Number);
    if (a === 127 || a === 0 || (a === 169 && b === 254)) return true;
    return blockPrivate && (a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127));
  }
  if (kind === 6) {
    if (ip === '::1' || ip === '::' || /^fe[89ab]/.test(ip)) return true;
    return blockPrivate && /^f[cd]/.test(ip);
  }
  return false;
}

export async function checkOutboundUrl(url, lookupImpl = dnsLookup) {
  let u;
  try { u = new URL(url); } catch { return 'url_invalid'; }
  if (!['http:', 'https:'].includes(u.protocol)) return 'url_blocked';
  const host = u.hostname.replace(/^\[|\]$/g, '');
  const blockPrivate = process.env.IVR_REST_BLOCK_PRIVATE === 'true';
  if (host.toLowerCase() === 'localhost' || host.toLowerCase().endsWith('.localhost')) return 'url_blocked';
  if (net.isIP(host)) return isForbiddenAddress(host, blockPrivate) ? 'url_blocked' : null;
  // A name that does not resolve is left for the call itself to report as a network error.
  const addresses = await lookupImpl(host, { all: true }).catch(() => []);
  return addresses.some((a) => isForbiddenAddress(a.address, blockPrivate)) ? 'url_blocked' : null;
}

// Optional pin: IVR_CRED_<NAME>_ALLOWED_HOSTS=api.vendor.com,crm.local
export function credentialAllowsHost(credentialName, url) {
  const allowed = credEnv(credentialName, 'ALLOWED_HOSTS');
  if (!allowed) return true;
  const host = new URL(url).hostname.toLowerCase();
  return allowed.split(',').map((h) => h.trim().toLowerCase()).includes(host);
}

// Tenant scope: IVR_CRED_<NAME>_TENANT_IDS=3,7. Credentials are server-wide env vars,
// so without a scope any tenant's flow can use any credential (IVR-6). A credential
// with a scope is usable only by flows on a number owned by a listed tenant. One
// without a scope is still usable by every tenant, unless
// IVR_CRED_REQUIRE_TENANT_SCOPE=true, which refuses unscoped credentials.
export function credentialAllowsTenant(credentialName, tenantId) {
  const ids = credEnv(credentialName, 'TENANT_IDS');
  if (!ids) return process.env.IVR_CRED_REQUIRE_TENANT_SCOPE !== 'true';
  if (tenantId == null) return false;
  return ids.split(',').map((t) => t.trim()).includes(String(tenantId));
}

async function tenantOfNumber(number) {
  if (!number) return null;
  const { rows: [row] } = await query(
    `SELECT tenant_id FROM emergency_numbers
      WHERE number = $1 AND deleted_at IS NULL AND is_active = true
      ORDER BY id LIMIT 1`,
    [number]
  );
  return row ? row.tenant_id : null;
}

// DNS lookup used when the connection is opened. Checking the name before the request
// and connecting afterwards left a gap: a name could resolve to a public address for
// the check and to 127.0.0.1 for the connection (DNS rebinding). Here the addresses
// checked are the addresses connected to.
export function makeCheckedLookup(blockPrivate, lookupImpl = dnsLookupCb) {
  return (hostname, options, callback) => {
    const opts = typeof options === 'object' && options !== null ? options : {};
    lookupImpl(hostname, { ...opts, all: true }, (err, addresses) => {
      if (err) return callback(err);
      const list = Array.isArray(addresses) ? addresses : [{ address: addresses, family: opts.family || 4 }];
      if (list.length === 0 || list.some((a) => isForbiddenAddress(a.address, blockPrivate))) {
        const e = new Error('url_blocked');
        e.code = 'URL_BLOCKED';
        return callback(e);
      }
      if (opts.all) return callback(null, list);
      return callback(null, list[0].address, list[0].family);
    });
  };
}

// Minimal fetch over http/https with the checked lookup and a response size cap. It sends
// the same default headers as Node's fetch() (which the proxy used before) and decodes
// gzip / deflate / br responses the same way, so an integration sees the same request.
// Redirects are NOT followed here; performRestCall follows them with its own checks.
const DEFAULT_HEADERS = { accept: '*/*', 'accept-encoding': 'gzip, deflate, br', 'user-agent': 'node' };
export function pinnedFetch(url, { method = 'GET', headers = {}, body, signal } = {}, lookupImpl) {
  const u = new URL(url);
  const lib = u.protocol === 'https:' ? https : http;
  const lookup = makeCheckedLookup(process.env.IVR_REST_BLOCK_PRIVATE === 'true', lookupImpl);
  const given = new Set(Object.keys(headers).map((h) => h.toLowerCase()));
  const sent = { ...Object.fromEntries(Object.entries(DEFAULT_HEADERS).filter(([k]) => !given.has(k))), ...headers };
  return new Promise((resolve, reject) => {
    const req = lib.request(u, { method, headers: sent, lookup, signal }, (res) => {
      const enc = String(res.headers['content-encoding'] || '').toLowerCase().trim();
      const decoder = enc === 'gzip' || enc === 'x-gzip' ? zlib.createGunzip()
        : enc === 'deflate' ? zlib.createInflate()
          : enc === 'br' ? zlib.createBrotliDecompress() : null;
      const stream = decoder ? res.pipe(decoder) : res;
      const chunks = [];
      let size = 0;
      let tooLarge = false;
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        const text = tooLarge ? '' : Buffer.concat(chunks).toString('utf8');
        resolve({
          status: res.statusCode,
          ok: res.statusCode >= 200 && res.statusCode < 300,
          tooLarge,
          headers: { get: (name) => res.headers[String(name).toLowerCase()] ?? null },
          text: async () => text,
          json: async () => JSON.parse(text),
        });
      };
      stream.on('data', (c) => {
        size += c.length;
        if (size > MAX_RESPONSE_BYTES) { tooLarge = true; res.destroy(); finish(); return; }
        chunks.push(c);
      });
      stream.on('end', finish);
      stream.on('error', (e) => { if (!tooLarge && !done) { done = true; reject(e); } });
      res.on('error', (e) => { if (!tooLarge && !done) { done = true; reject(e); } });
    });
    req.on('error', reject);
    if (body != null) req.write(body);
    req.end();
  });
}

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const locationOf = (res) => (typeof res.headers?.get === 'function' ? res.headers.get('location') : res.headers?.location) || null;

// Core logic, separated from the Express wrapper for unit testing.
// `fetchImpl` is injectable so tests can mock the external HTTP call.
export async function performRestCall(input, fetchImpl, lookupImpl, resolveTenant = tenantOfNumber) {
  const parsed = RestCallSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, status: 0, outcome: 'http_error', vars: {}, error: 'bad_request' };
  }
  const cfg = parsed.data;
  const method = String(cfg.method || 'GET').toUpperCase();
  const timeoutMs = Math.min(Math.max(cfg.timeout_seconds || 10, 1), MAX_TIMEOUT_S) * 1000;
  // Production calls go through pinnedFetch (connect-time address check); tests inject one.
  const doFetch = fetchImpl || pinnedFetch;

  // Checked first: a refused URL must never cause a secret to be resolved or sent.
  const refused = await checkOutboundUrl(cfg.url, lookupImpl);
  if (refused) return { ok: false, status: 0, outcome: 'http_error', vars: {}, error: refused };
  if (cfg.credential_name && !credentialAllowsHost(cfg.credential_name, cfg.url)) {
    return { ok: false, status: 0, outcome: 'http_error', vars: {}, error: 'credential_host_not_allowed' };
  }
  const usesCredential = (cfg.auth_type || 'none') !== 'none';
  if (usesCredential) {
    const tenantId = cfg.ivr_number ? await resolveTenant(cfg.ivr_number) : null;
    if (!credentialAllowsTenant(cfg.credential_name, tenantId)) {
      return { ok: false, status: 0, outcome: 'http_error', vars: {}, error: 'credential_tenant_not_allowed' };
    }
  }

  const headers = { ...(parseJsonSafe(cfg.headers, {}) || {}) };

  // Resolve + apply auth (secret stays server-side). The OAuth2 token URL is set by
  // the operator in env, not by a flow, so it uses the plain fetch.
  const auth = await applyAuth({
    auth_type: cfg.auth_type, credential_name: cfg.credential_name,
    auth_param_name: cfg.auth_param_name, url: cfg.url, headers, fetchImpl: fetchImpl || fetch,
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
    // Redirects: followed (as fetch() did before Cycle 2), up to MAX_REDIRECTS. Each new
    // address passes the same outbound check; on a change of host the credential headers
    // are dropped (a redirect must not carry a secret to another host); 303, and 301/302
    // after a POST, continue as GET without a body, as fetch() does.
    const originHost = new URL(url).host;
    const credHeaders = new Set(['authorization', String(cfg.auth_param_name || '').toLowerCase()].filter(Boolean));
    let target = url;
    let reqMethod = method;
    let reqBody = hasBody ? cfg.body : undefined;
    let reqHeaders = headers;
    for (let hop = 0; ; hop++) {
      res = await doFetch(target, {
        method: reqMethod, headers: reqHeaders, body: reqBody,
        redirect: 'manual', signal: controller.signal,
      });
      const location = REDIRECT_STATUSES.has(res.status) ? locationOf(res) : null;
      if (!location) break;
      if (hop >= MAX_REDIRECTS) { clearTimeout(timer); return { ok: false, status: res.status, outcome: 'http_error', vars: {}, error: 'too_many_redirects' }; }
      let next;
      try { next = new URL(location, target).toString(); } catch { break; }
      const refusedNext = await checkOutboundUrl(next, lookupImpl);
      if (refusedNext) { clearTimeout(timer); return { ok: false, status: res.status, outcome: 'http_error', vars: {}, error: refusedNext }; }
      if (new URL(next).host !== originHost) {
        reqHeaders = Object.fromEntries(Object.entries(reqHeaders).filter(([k]) => !credHeaders.has(k.toLowerCase())));
      }
      if (res.status === 303 || ((res.status === 301 || res.status === 302) && reqMethod === 'POST')) {
        reqMethod = 'GET';
        reqBody = undefined;
        reqHeaders = Object.fromEntries(Object.entries(reqHeaders).filter(([k]) => k.toLowerCase() !== 'content-type'));
      }
      target = next;
    }
  } catch (err) {
    clearTimeout(timer);
    if (err && err.code === 'URL_BLOCKED') {
      return { ok: false, status: 0, outcome: 'http_error', vars: {}, error: 'url_blocked' };
    }
    const outcome = (err && (err.name === 'AbortError' || err.code === 'ABORT_ERR')) ? 'timeout' : 'http_error';
    return { ok: false, status: 0, outcome, vars: {}, error: outcome === 'timeout' ? 'timeout' : 'network_error' };
  }
  clearTimeout(timer);

  const status = res.status;
  if (status < 200 || status >= 300) {
    return { ok: false, status, outcome: 'http_error', vars: {} };
  }
  if (res.tooLarge) {
    return { ok: false, status, outcome: 'invalid_response', vars: {}, error: 'response_too_large' };
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
      // An external server's response must never set a variable that runs a command.
      if (isProtectedVarName(m.variable_name)) continue;
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
    || result.error === 'oauth2_token_timeout'
    || result.error === 'unsupported_auth_type'
    || result.error === 'bad_request'
    || result.error === 'url_invalid'
    || result.error === 'url_blocked'
    || result.error === 'credential_host_not_allowed'
    || result.error === 'credential_tenant_not_allowed';
  if (isConfigError) {
    logger?.warn?.(fields, `IVR rest_api call — auth/config error: ${result.error} (branch=${result.outcome})`);
  } else {
    logger?.info?.(fields, 'IVR rest_api proxy call');
  }

  // Return the outcome + mapped vars for the Lua executor. Always HTTP 200 to
  // the internal caller (the *outcome* field carries success/failure) so the
  // Lua side branches on outcome, not on this transport's status.
  res.json({ ok: result.ok, status: result.status, outcome: result.outcome, vars: result.vars || {} });
});
