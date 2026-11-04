#!/usr/bin/env node
/**
 * IVR compatibility report — READ ONLY.
 *
 * Lists stored IVR flows that the Cycle 2–3 security rules affect, so an operator can
 * fix them before (or right after) deploying. Nothing is written: the script runs
 * SELECT statements only and prints a report.
 *
 * What it checks, for each flow's current draft and its latest published version:
 *   - ${api args} expansion in any string (refused at publish since Cycle 2)
 *   - writes to command-running channel variables (set_variable, gather, record, REST mappings)
 *   - transfer with the inline dialplan (refused at publish; still runs unless
 *     ENRS_IVR_BLOCK_INLINE_TRANSFER=true), also when "inline" is the destination's
 *     own dialplan word
 *   - rest_api URLs whose fixed host is refused by the proxy (loopback, link-local/metadata)
 *   - ENS nodes that take the configuration from a session variable (still allowed;
 *     listed because the backend now checks the tenant at call time)
 *   - rest_api nodes that use a credential (listed so each credential can be given
 *     IVR_CRED_<NAME>_TENANT_IDS before IVR_CRED_REQUIRE_TENANT_SCOPE=true)
 * And for every active number in the service registry:
 *   - numbers containing characters that used to act as a regular expression in the
 *     generated dialplan (Cycle 2 matches numbers literally; a deliberate pattern such
 *     as "1000|1001" or "10.." now matches only that exact text)
 *
 * Usage (uses the same DB_* settings as the backend):
 *   node scripts/ivr-compat-report.js            # human-readable
 *   node scripts/ivr-compat-report.js --json     # machine-readable
 * Exit code 0 always (it is a report, not a gate), 2 if the database is unreachable.
 */

import { URL } from 'url';
import { query, pool } from '../src/db/pool.js';
import { nodeSecurityIssues } from '../src/validators/ivrValidator.js';
import { API_EXPANSION_RE } from '../src/utils/ivrGraphValidator.js';
import { isForbiddenAddress } from '../src/controllers/internal/ivrRestController.js';

// Characters with a regular-expression meaning in the old dialplan expression. "+" and
// "*" are included: how the engine treated "^+966$" or "^*97$" (quantifier or invalid
// pattern) was not verified, so such numbers are listed for a check after redeploy.
export const REGEX_CHARS_RE = /[.*+|()[\]{}?^$\\]/;

// Host of a fixed URL the proxy would refuse; null if the host is not fixed or allowed.
export function refusedRestHost(url) {
  if (typeof url !== 'string' || url.includes('${')) return null;
  let host;
  try { host = new URL(url).hostname.replace(/^\[|\]$/g, '').toLowerCase(); } catch { return null; }
  if (host === 'localhost' || host.endsWith('.localhost')) return host;
  return isForbiddenAddress(host, process.env.IVR_REST_BLOCK_PRIVATE === 'true') ? host : null;
}

function stringsOf(value, path, out) {
  if (typeof value === 'string') out.push([path, value]);
  else if (Array.isArray(value)) value.forEach((v, i) => stringsOf(v, `${path}.${i}`, out));
  else if (value && typeof value === 'object') for (const [k, v] of Object.entries(value)) stringsOf(v, path ? `${path}.${k}` : k, out);
  return out;
}

export function graphFindings(graph) {
  const findings = [];
  let g = graph;
  if (typeof g === 'string') { try { g = JSON.parse(g); } catch { return [{ node: '-', kind: 'error', message: 'graph is not valid JSON' }]; } }
  for (const [nid, node] of Object.entries(g?.nodes || {})) {
    if (!node || typeof node !== 'object') continue;
    for (const [path, s] of stringsOf(node, '', [])) {
      if (API_EXPANSION_RE.test(s)) findings.push({ node: nid, kind: 'error', message: `${path}: \${api args} expansion is refused` });
    }
    for (const m of nodeSecurityIssues(node)) findings.push({ node: nid, kind: 'error', message: m });
    if (node.type === 'ens' && node.ens_config_var) {
      findings.push({ node: nid, kind: 'info', message: `ENS configuration from variable "${node.ens_config_var}" — checked against the dialled number's tenant at call time` });
    }
    if (node.type === 'rest_api' && refusedRestHost(node.url)) {
      findings.push({ node: nid, kind: 'error', message: `url host ${refusedRestHost(node.url)} is refused by the REST proxy (loopback / link-local) — the node takes its http_error branch` });
    }
    if (node.type === 'rest_api' && node.credential_name && (node.auth_type ?? 'none') !== 'none') {
      findings.push({ node: nid, kind: 'info', message: `uses credential "${node.credential_name}" — set IVR_CRED_${String(node.credential_name).toUpperCase().replace(/[^A-Z0-9]/g, '_')}_TENANT_IDS` });
    }
  }
  return findings;
}

async function main() {
  const asJson = process.argv.includes('--json');
  let rows;
  try {
    ({ rows } = await query(
      `SELECT f.id, f.flow_uuid, f.name, f.tenant_id, f.graph AS draft,
              v.version_number, v.graph AS published
         FROM ivr_flows f
         LEFT JOIN LATERAL (
           SELECT version_number, graph FROM ivr_flow_versions
            WHERE ivr_flow_id = f.id ORDER BY version_number DESC LIMIT 1
         ) v ON true
        WHERE f.deleted_at IS NULL
        ORDER BY f.tenant_id, f.id`
    ));
  } catch (err) {
    console.error(`database not reachable: ${err.message}`);
    process.exitCode = 2;
    return;
  }

  const { rows: numbers } = await query(
    `SELECT id, tenant_id, number, type FROM emergency_numbers
      WHERE deleted_at IS NULL AND is_active = true ORDER BY tenant_id, number`
  );
  const patternNumbers = numbers.filter((n) => REGEX_CHARS_RE.test(n.number));

  const report = rows.map((r) => ({
    flow_id: r.id, flow_uuid: r.flow_uuid, name: r.name, tenant_id: r.tenant_id,
    draft: graphFindings(r.draft),
    published_version: r.version_number ?? null,
    published: r.published ? graphFindings(r.published) : [],
  })).filter((r) => r.draft.length || r.published.length);

  if (asJson) {
    console.log(JSON.stringify({ flows_checked: rows.length, flows_affected: report.length, report, numbers_checked: numbers.length, pattern_numbers: patternNumbers }, null, 2));
  } else {
    console.log(`IVR compatibility report — ${rows.length} flows checked, ${report.length} with findings\n`);
    for (const r of report) {
      console.log(`tenant ${r.tenant_id} · flow ${r.flow_id} "${r.name}" (${r.flow_uuid})`);
      for (const [label, list] of [['draft', r.draft], [`published v${r.published_version}`, r.published]]) {
        for (const f of list) console.log(`  [${label}] ${f.kind.toUpperCase()} node ${f.node}: ${f.message}`);
      }
      console.log('');
    }
    console.log(`Service numbers: ${numbers.length} checked, ${patternNumbers.length} contain regular-expression characters`);
    for (const n of patternNumbers) console.log(`  tenant ${n.tenant_id} · ${n.type} number "${n.number}" (id ${n.id}) — now matched literally after the next dialplan regeneration`);
    console.log('');
    console.log('ERROR = the next publish of that flow is refused until fixed. A published version keeps its');
    console.log('stored graph; at call time only command-running variable writes and transfers where a variable');
    console.log('value adds a word are refused, and inline transfers keep running unless');
    console.log('ENRS_IVR_BLOCK_INLINE_TRANSFER=true.');
  }
}

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith('ivr-compat-report.js')) {
  main().finally(() => pool?.end?.());
}
