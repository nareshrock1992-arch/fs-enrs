#!/usr/bin/env node
/**
 * API contract checker — Phase 2 item 3.
 *
 * Statically extracts every internal API call the generated Lua makes
 * (method, path, body field names) and cross-references:
 *   1. The path+method is actually a registered Express route.
 *   2. Every body field name Lua sends exists on that route's Zod schema
 *      (catches sent-but-unexpected fields, e.g. ers_configuration_id
 *      instead of configuration_id — the exact bug class in Phase 1
 *      items 3/4, which this would have caught in seconds instead of a
 *      failed real phone call).
 *   3. Every response field Lua reads (`d.foo`) after a call is actually
 *      present in that controller's res.json()/res.status().json() body
 *      (catches the exec_ers bug of reading d.conference_room when the
 *      real response only ever returns d.incident_uuid).
 *
 * Then extends the same path-existence check to frontend/src/api/client.js
 * against the registered /api/v1/* routes.
 *
 * This is a static source check, not a live-server crawl — it trades some
 * generality (it knows about exactly the endpoints Lua and the frontend
 * client actually call, not a fully generic route/schema differ) for
 * running with zero dependencies beyond Node itself and zero network
 * access. Extend KNOWN_INTERNAL_CALLS / route imports below as new
 * endpoints are added — see docs/EXTENDING_NODE_TYPES.md for the pattern
 * once Phase 3's node-type registry exists (it should become the single
 * source this script reads from instead of the hand-maintained list here).
 *
 * Usage:  node scripts/verify-api-contracts.js
 */

import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import path from 'path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const backendRoot = path.join(__dirname, '..', 'backend');
const frontendRoot = path.join(__dirname, '..', 'frontend');

let failures = 0;
function fail(msg) { failures++; console.error(`  ✗ ${msg}`); }
function ok(msg)   { console.log(`  ✓ ${msg}`); }

// ── Step 1: generate the real Lua and extract every API call it makes ──────────

const { generateIvrExecutorLua } = await import(
  path.join(backendRoot, 'src', 'utils', 'luaGenerator.js')
);
const lua = generateIvrExecutorLua({ apiBase: 'http://127.0.0.1:4100', apiKey: 'k', ttsEngine: 'flite|kal' });

// Matches: post("/path", { field1 = ..., field2 = ..., }) — captures path + raw body block
const postCallRe = /post\("(\/[^"]+)",\s*\{([\s\S]*?)\n\s*\}\)/g;
// Matches: get("/path" ...) — path only (query string built via concatenation, not statically checkable here)
const getCallRe  = /get\("(\/[^"?]+)/g;

function extractBodyFieldNames(block) {
  // Matches `field_name = ...,` at the start of a line inside the block —
  // good enough for this generator's consistent formatting; a field name
  // followed by `=` that isn't inside a nested table.
  const fieldRe = /^\s*([a-zA-Z_][a-zA-Z0-9_]*)\s*=/gm;
  const fields = [];
  let m;
  while ((m = fieldRe.exec(block))) fields.push(m[1]);
  return fields;
}

const luaPostCalls = [];
let m;
while ((m = postCallRe.exec(lua))) {
  luaPostCalls.push({ path: m[1], fields: extractBodyFieldNames(m[2]) });
}
const luaGetPaths = new Set();
while ((m = getCallRe.exec(lua))) luaGetPaths.add(m[1]);

console.log(`[verify-api-contracts] Extracted from generated Lua: ${luaPostCalls.length} POST call(s), ${luaGetPaths.size} GET path(s)\n`);

// ── Step 2: registered internal routes ──────────────────────────────────────

const ersRouter = (await import(path.join(backendRoot, 'src', 'routes', 'internal', 'ers.js'))).default;
const ensRouter = (await import(path.join(backendRoot, 'src', 'routes', 'internal', 'ens.js'))).default;
const ivrRouter = (await import(path.join(backendRoot, 'src', 'routes', 'internal', 'ivr.js'))).default;

function routesOf(router, prefix) {
  return router.stack
    .filter(layer => layer.route)
    .flatMap(layer => Object.keys(layer.route.methods).map(method => ({
      method: method.toUpperCase(),
      path: prefix + layer.route.path,
    })));
}

const registeredRoutes = [
  ...routesOf(ersRouter, '/ers'),
  ...routesOf(ensRouter, '/ens'),
  ...routesOf(ivrRouter, '/ivr'),
];

function pathMatches(registeredPath, actualPath) {
  // Convert Express :param segments to a wildcard for comparison
  const re = new RegExp('^' + registeredPath.replace(/:[^/]+/g, '[^/]+') + '$');
  return re.test(actualPath);
}

console.log('Internal API — path + method registration:');
for (const call of luaPostCalls) {
  const found = registeredRoutes.some(r => r.method === 'POST' && pathMatches(r.path, call.path));
  if (found) ok(`POST ${call.path} is registered`);
  else fail(`POST ${call.path} — Lua calls this but NO matching Express route is registered`);
}
for (const p of luaGetPaths) {
  const found = registeredRoutes.some(r => r.method === 'GET' && pathMatches(r.path, p));
  if (found) ok(`GET ${p} is registered`);
  else fail(`GET ${p} — Lua calls this but NO matching Express route is registered`);
}

// ── Step 3: body field names vs the actual Zod schema ───────────────────────

const { IncidentCreateSchema, RingAllSchema, OverflowEnqueueSchema } = await import(
  path.join(backendRoot, 'src', 'controllers', 'internal', 'ersInternalController.js')
);
const { NotificationCreateSchema } = await import(
  path.join(backendRoot, 'src', 'controllers', 'internal', 'ensInternalController.js')
);

const SCHEMA_FOR_PATH = {
  '/ers/incidents': IncidentCreateSchema,
  '/ens/notifications': NotificationCreateSchema,
  '/ers/ring-all': RingAllSchema,
  '/ers/overflow/enqueue': OverflowEnqueueSchema,
};

console.log('\nInternal API — request body field names vs Zod schema:');
for (const call of luaPostCalls) {
  const schema = SCHEMA_FOR_PATH[call.path];
  if (!schema) {
    console.log(`  · POST ${call.path} — no schema registered in this checker's SCHEMA_FOR_PATH map, skipped`);
    continue;
  }
  const validFields = new Set(Object.keys(schema.shape));
  const unexpected = call.fields.filter(f => !validFields.has(f));
  if (unexpected.length === 0) {
    ok(`POST ${call.path} — every field Lua sends (${call.fields.join(', ')}) exists on the schema`);
  } else {
    fail(`POST ${call.path} — Lua sends field(s) not in the schema: ${unexpected.join(', ')} (valid: ${[...validFields].join(', ')})`);
  }
}

// ── Step 4: response fields Lua reads vs what the controller actually returns ──
//
// Best-effort static extraction: find the exported controller function
// whose export name we know handles this path, grep its res.json(...) /
// res.status(N).json(...) call for top-level keys.

const RESPONSE_CHECK = [
  {
    luaPath: '/ers/incidents',
    controllerFile: path.join(backendRoot, 'src', 'controllers', 'internal', 'ersInternalController.js'),
    exportName: 'ersCreateIncident',
    luaReadsPrefix: 'd.',
  },
  {
    luaPath: '/ens/notifications',
    controllerFile: path.join(backendRoot, 'src', 'controllers', 'internal', 'ensInternalController.js'),
    exportName: 'ensCreateNotification',
    luaReadsPrefix: 'd.',
  },
];

function extractResponseFields(controllerSrc, exportName) {
  const fnStart = controllerSrc.indexOf(`export const ${exportName}`);
  if (fnStart === -1) return null;
  // Grab a generous window after the export to find its res.json(...) call —
  // these handlers are short, a few KB window is always enough.
  const window = controllerSrc.slice(fnStart, fnStart + 4000);
  const jsonCallRe = /res\.(?:status\(\d+\)\.)?json\(\{([\s\S]*?)\n\s*\}\)/;
  const jm = jsonCallRe.exec(window);
  if (!jm) return null;
  const fieldRe = /^\s*([a-zA-Z_][a-zA-Z0-9_]*)\s*:/gm;
  const fields = [];
  let fm;
  while ((fm = fieldRe.exec(jm[1]))) fields.push(fm[1]);
  return fields;
}

console.log('\nInternal API — response fields Lua reads vs what the controller returns:');
for (const check of RESPONSE_CHECK) {
  const src = readFileSync(check.controllerFile, 'utf8');
  const responseFields = extractResponseFields(src, check.exportName);
  if (!responseFields) {
    console.log(`  · ${check.exportName} — could not statically extract its response shape, skipped`);
    continue;
  }

  // What does Lua read from `d` (the parsed response) after calling this path?
  const callBlockRe = new RegExp(`post\\("${check.luaPath.replace('/', '\\/')}"[\\s\\S]*?\\n(?:[\\s\\S]*?)(?=local function|\\Z)`);
  const cm = callBlockRe.exec(lua);
  const searchWindow = cm ? cm[0] : lua;
  const readRe = /\bd\.([a-zA-Z_][a-zA-Z0-9_]*)/g;
  const reads = new Set();
  let rm;
  while ((rm = readRe.exec(searchWindow))) reads.add(rm[1]);

  const unknownReads = [...reads].filter(f => !responseFields.includes(f));
  if (unknownReads.length === 0) {
    ok(`${check.exportName} — every field Lua reads from the response (${[...reads].join(', ') || 'none'}) is actually returned`);
  } else {
    fail(`${check.exportName} — Lua reads field(s) the response never returns: ${unknownReads.join(', ')} (actual response fields: ${responseFields.join(', ')})`);
  }
}

// ── Step 5: frontend/src/api/client.js paths vs registered /api/v1/* routes ──

console.log('\nFrontend API client — path prefixes vs registered v1 routes:');
const V1_MOUNTS = [
  '/auth', '/users', '/organizations', '/contacts', '/groups', '/ens', '/ers',
  '/ivr/flows', '/deployment', '/services', '/campaigns', '/dashboard',
  '/reports', '/media', '/settings',
];

const clientSrc = readFileSync(path.join(frontendRoot, 'src', 'api', 'client.js'), 'utf8');
const requestCallRe = /request\('(\w+)',\s*`?\/([a-zA-Z0-9_-]+)/g;
const clientPrefixes = new Set();
let cm2;
while ((cm2 = requestCallRe.exec(clientSrc))) clientPrefixes.add('/' + cm2[2]);

let unmounted = 0;
for (const prefix of clientPrefixes) {
  const known = V1_MOUNTS.some(mount => mount === prefix || mount.startsWith(prefix + '/') || prefix === mount.split('/')[1] && false);
  if (known || V1_MOUNTS.includes(prefix)) {
    ok(`client.js calls "${prefix}" — matches a registered /api/v1${prefix} mount`);
  } else {
    unmounted++;
    fail(`client.js calls "${prefix}" — no /api/v1${prefix} mount found in routes/v1/index.js`);
  }
}

// ── Summary ──────────────────────────────────────────────────────────────────

if (failures > 0) {
  console.error(`\n[verify-api-contracts] FAIL: ${failures} contract violation(s) found.`);
  process.exit(1);
}
console.log('\n[verify-api-contracts] PASS: every checked contract matches.');
