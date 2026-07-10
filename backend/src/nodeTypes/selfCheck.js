/**
 * Node-type registry self-check — Phase 3 item 4.
 *
 * For every registry entry that declares an apiEndpoint, confirm a
 * matching Express route is actually registered. Runs once at boot and
 * logs a clear warning (not a silent no-op) if a node type's declared
 * endpoint doesn't exist — this is exactly the class of drift that let
 * exec_ers/exec_ens call nonexistent paths for a full day before anyone
 * noticed on a real test call.
 */

import ersRouter from '../routes/internal/ers.js';
import ensRouter from '../routes/internal/ens.js';
import ivrRouter from '../routes/internal/ivr.js';
import { NODE_TYPE_REGISTRY } from './registry.js';

const MOUNTS = [
  { prefix: '/api/v1/internal/ers', router: ersRouter },
  { prefix: '/api/v1/internal/ens', router: ensRouter },
  { prefix: '/api/v1/internal/ivr', router: ivrRouter },
];

function registeredPaths() {
  const out = [];
  for (const { prefix, router } of MOUNTS) {
    for (const layer of router.stack) {
      if (!layer.route) continue;
      for (const method of Object.keys(layer.route.methods)) {
        out.push({ method: method.toUpperCase(), path: prefix + layer.route.path });
      }
    }
  }
  return out;
}

function pathMatches(registeredPath, declaredPath) {
  const re = new RegExp('^' + registeredPath.replace(/:[^/]+/g, '[^/]+') + '$');
  return re.test(declaredPath);
}

export function checkNodeTypeApiEndpoints() {
  const registered = registeredPaths();
  const problems = [];

  for (const n of NODE_TYPE_REGISTRY) {
    if (!n.apiEndpoint) continue;
    const { method, path } = n.apiEndpoint;
    const found = registered.some(r => r.method === method && pathMatches(r.path, path));
    if (!found) {
      problems.push(`Node type "${n.type}" declares apiEndpoint ${method} ${path}, but no matching Express route is registered.`);
    }
  }

  if (problems.length > 0) {
    console.warn('[boot] Node-type registry self-check FOUND PROBLEMS:');
    for (const p of problems) console.warn('  ⚠ ' + p);
  } else {
    console.log(`[boot] Node-type registry self-check OK — ${NODE_TYPE_REGISTRY.length} node type(s), all apiEndpoint declarations match registered routes.`);
  }

  return problems;
}
