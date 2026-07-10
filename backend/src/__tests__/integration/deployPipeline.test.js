/**
 * Phase 6 — simulated deploy pipeline: deployFlow() end-to-end against a
 * real test DB with the ESL boundary mocked (no FreeSWITCH required).
 *
 * Asserts, per the phase spec:
 *  - every step reports "ok" for a valid published flow that includes the
 *    Phase 5 node types
 *  - the generated Lua/XML written to disk carry the structural markers
 *    the Phase 2 gates check (full luac/xmllint runs happen in CI via
 *    npm run verify:lua / verify:xml — no Lua compiler in the test env)
 *  - deployFlow() FAILS (never silently succeeds) for: an unpublished
 *    flow, a flow with unresolved ERS/ENS bindings, and the
 *    "written-but-not-loaded" case — each reproducing the exact failure
 *    message class from the original debugging session.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';

process.env.NODE_ENV = 'test';
process.env.INTERNAL_API_KEY = 'test-internal-key-32charmin';

// Point every FS_* path at a scratch dir BEFORE config/fsConfig loads.
const scratch = mkdtempSync(path.join(tmpdir(), 'deploy-pipeline-'));
process.env.FS_CONF_DIR      = path.join(scratch, 'conf').replace(/\\/g, '/');
process.env.FS_DIALPLAN_DIR  = path.join(scratch, 'dialplan').replace(/\\/g, '/');
process.env.FS_SCRIPT_DIR    = path.join(scratch, 'scripts').replace(/\\/g, '/');
process.env.FS_SOUND_DIR     = path.join(scratch, 'sounds').replace(/\\/g, '/');
process.env.FS_RECORDING_DIR = path.join(scratch, 'recordings').replace(/\\/g, '/');

// ESL boundary mock — controllable per test.
const eslState = {
  reloadxmlResult: '+OK [Success]',
  xmlLocateContains: true, // whether xml_locate output includes the extension name
};
vi.mock('../../services/eslService.js', async (importOriginal) => {
  const mod = await importOriginal();
  return {
    ...mod,
    connect: vi.fn(),
    eslCommand: vi.fn(async (cmd) => {
      if (cmd === 'reloadxml') return eslState.reloadxmlResult;
      return '';
    }),
    verifyExtensionLoaded: vi.fn(async (extensionName) => ({
      loaded: eslState.xmlLocateContains,
      raw: eslState.xmlLocateContains ? `<extension name="${extensionName}"/>` : '<dialplan/>',
      attempts: 1,
    })),
    getConferenceMemberCount: vi.fn(async () => 0),
  };
});

const { deployFlow } = await import('../../services/deploymentEngine.js');
const { query } = await import('../../db/pool.js');

let tenantId, orgId, ersConfigId, ensConfigId;
let publishedFlowId, publishedFlowUuid;
let unpublishedFlowUuid;
let badBindingFlowUuid;
let numberId;

// A full graph exercising the Phase 5 node types alongside the classics.
function phase5Graph(ersId, ensId) {
  return {
    entry_node_id: 'check',
    nodes: {
      check: {
        type: 'ers_overflow_check',
        ers_configuration_id: ersId,
        branches: { primary: 'ring_l1', secondary: 'ring_l2', full: 'wait' },
      },
      ring_l1: { type: 'ers_ring_all', ers_configuration_id: ersId, tier: 'primary' },
      ring_l2: { type: 'ers_ring_all', ers_configuration_id: ersId, tier: 'secondary' },
      wait: {
        type: 'ers_overflow_wait',
        ers_configuration_id: ersId,
        hold_prompt_text: 'All responders are engaged. Please hold.',
        max_wait_seconds: 120,
        next: 'blast',
      },
      blast: { type: 'ens_blast_record', ens_configuration_id: ensId, next: 'gate' },
      gate: {
        type: 'ens_playback_gate',
        ers_configuration_id: ersId,
        true_node: 'bye',
        false_node: 'bye',
      },
      bye: { type: 'hangup' },
    },
  };
}

beforeAll(async () => {
  const { rows: [t] } = await query(
    `INSERT INTO tenants (name, code) VALUES ('DeployPipelineTenant', $1) RETURNING id`,
    [`deploy6-${Date.now()}`]
  );
  tenantId = t.id;
  const { rows: [o] } = await query(
    `INSERT INTO organizations (name, tenant_id) VALUES ('DeployPipelineOrg', $1) RETURNING id`,
    [tenantId]
  );
  orgId = o.id;

  const { rows: [ers] } = await query(
    `INSERT INTO ers_configurations (organization_id, tenant_id, name, is_active)
     VALUES ($1, $2, 'Deploy6 ERS', true) RETURNING id`,
    [orgId, tenantId]
  );
  ersConfigId = ers.id;
  const { rows: [ens] } = await query(
    `INSERT INTO ens_configurations (organization_id, tenant_id, name, is_active)
     VALUES ($1, $2, 'Deploy6 ENS', true) RETURNING id`,
    [orgId, tenantId]
  );
  ensConfigId = ens.id;

  // Published flow with the Phase 5 graph + a bound number
  const graph = phase5Graph(ersConfigId, ensConfigId);
  const { rows: [flow] } = await query(
    `INSERT INTO ivr_flows (tenant_id, organization_id, name, graph, is_active)
     VALUES ($1, $2, 'Deploy6 Published Flow', $3, true)
     RETURNING id, flow_uuid`,
    [tenantId, orgId, JSON.stringify(graph)]
  );
  publishedFlowId = flow.id;
  publishedFlowUuid = flow.flow_uuid;
  await query(
    `INSERT INTO ivr_flow_versions (ivr_flow_id, version_number, graph, published_at)
     VALUES ($1, 1, $2, now())`,
    [flow.id, JSON.stringify(graph)]
  );
  const { rows: [num] } = await query(
    `INSERT INTO emergency_numbers (number, type, organization_id, tenant_id, ivr_flow_id, is_active)
     VALUES ('61222', 'IVR', $1, $2, $3, true) RETURNING id`,
    [orgId, tenantId, flow.id]
  );
  numberId = num.id;

  // Unpublished flow — draft only, zero ivr_flow_versions rows
  const { rows: [draft] } = await query(
    `INSERT INTO ivr_flows (tenant_id, organization_id, name, graph, is_active)
     VALUES ($1, $2, 'Deploy6 Draft Flow', $3, true) RETURNING flow_uuid`,
    [tenantId, orgId, JSON.stringify(graph)]
  );
  unpublishedFlowUuid = draft.flow_uuid;

  // Published flow whose graph references a nonexistent ERS config —
  // the "unresolved ERS/ENS bindings" failure case.
  const badGraph = phase5Graph(999999, ensConfigId);
  const { rows: [bad] } = await query(
    `INSERT INTO ivr_flows (tenant_id, organization_id, name, graph, is_active)
     VALUES ($1, $2, 'Deploy6 Bad Binding Flow', $3, true) RETURNING id, flow_uuid`,
    [tenantId, orgId, JSON.stringify(badGraph)]
  );
  badBindingFlowUuid = bad.flow_uuid;
  await query(
    `INSERT INTO ivr_flow_versions (ivr_flow_id, version_number, graph, published_at)
     VALUES ($1, 1, $2, now())`,
    [bad.id, JSON.stringify(badGraph)]
  );
});

afterAll(async () => {
  await query(`DELETE FROM ivr_flow_deployments WHERE flow_uuid IN (
    SELECT flow_uuid FROM ivr_flows WHERE tenant_id = $1)`, [tenantId]).catch(() => {});
  await query(`DELETE FROM emergency_numbers WHERE tenant_id = $1`, [tenantId]);
  await query(`DELETE FROM ivr_flow_versions WHERE ivr_flow_id IN (
    SELECT id FROM ivr_flows WHERE tenant_id = $1)`, [tenantId]);
  await query(`DELETE FROM ivr_flows WHERE tenant_id = $1`, [tenantId]);
  await query(`DELETE FROM ers_configurations WHERE id = $1`, [ersConfigId]);
  await query(`DELETE FROM ens_configurations WHERE id = $1`, [ensConfigId]);
  await query(`DELETE FROM organizations WHERE id = $1`, [orgId]);
  await query(`DELETE FROM tenants WHERE id = $1`, [tenantId]);
  rmSync(scratch, { recursive: true, force: true });
});

describe('Phase 6 — deployFlow() succeeds end-to-end for a valid published Phase 5 flow', () => {
  let report;

  it('every pipeline step reports ok', async () => {
    eslState.reloadxmlResult = '+OK [Success]';
    eslState.xmlLocateContains = true;

    report = await deployFlow(publishedFlowUuid, { deployedBy: null, tenantId });
    expect(report.status).toBe('success');
    for (const step of report.steps) {
      expect(step.status, `step "${step.name}" should be ok`).toBe('ok');
    }
    const stepNames = report.steps.map(s => s.name);
    expect(stepNames).toContain('validate_graph');
    expect(stepNames).toContain('deploy_lua_executor');
    expect(stepNames).toContain('deploy_dialplan_xml');
    expect(stepNames).toContain('reloadxml');
    expect(stepNames).toContain('verify_extension_loaded');
  });

  it('the written Lua contains every Phase 5 node handler and the quoted goto key', () => {
    expect(existsSync(report.files.lua)).toBe(true);
    const lua = readFileSync(report.files.lua, 'utf8');
    for (const t of ['ers_ring_all', 'ers_overflow_check', 'ers_overflow_wait', 'ens_blast_record', 'ens_playback_gate']) {
      expect(lua).toContain(`local function exec_${t}(s, node)`);
    }
    expect(lua).toContain('["goto"]');
  });

  it('the written XML is structurally correct for the detected (flat) layout', () => {
    expect(existsSync(report.files.xml)).toBe(true);
    const xml = readFileSync(report.files.xml, 'utf8');
    // No default.xml exists in the scratch dialplan dir → flat layout →
    // the file must carry its own <context name="default"> wrapper.
    expect(xml).toContain('<context name="default">');
    expect(xml).toContain('<extension name="enrs_ivr_61222"');
  });
});

describe('Phase 6 — deployFlow() FAILS loudly, never silently, for each Phase 1 failure class', () => {
  it('unpublished flow: "No published version found"', async () => {
    const report = await deployFlow(unpublishedFlowUuid, { deployedBy: null, tenantId });
    expect(report.status).toBe('failed');
    expect(report.errors.join(' ')).toContain('No published version found');
  });

  it('unresolved ERS binding: "not found or wrong tenant"', async () => {
    const report = await deployFlow(badBindingFlowUuid, { deployedBy: null, tenantId });
    expect(report.status).toBe('failed');
    expect(report.errors.join(' ')).toContain('not found or wrong tenant');
  });

  it('written-but-not-loaded: the exact silent-failure class from the original session surfaces as a failure', async () => {
    eslState.xmlLocateContains = false; // reloadxml says +OK but the extension never appears
    const report = await deployFlow(publishedFlowUuid, { deployedBy: null, tenantId });
    expect(report.status).toBe('failed');
    expect(report.errors.join(' ')).toContain('FreeSWITCH did not load the extension');
    eslState.xmlLocateContains = true;
  });

  it('structurally invalid graph: validation error propagates as a failed deploy', async () => {
    // Corrupt the published version's graph directly (dangling ref).
    const badGraph = {
      entry_node_id: 'a',
      nodes: { a: { type: 'say', text: 'x', next: 'missing_node' } },
    };
    await query(
      `UPDATE ivr_flow_versions SET graph = $2
       WHERE ivr_flow_id = $1 AND version_number = 1`,
      [publishedFlowId, JSON.stringify(badGraph)]
    );

    const report = await deployFlow(publishedFlowUuid, { deployedBy: null, tenantId });
    expect(report.status).toBe('failed');
    expect(report.errors.join(' ')).toContain('references non-existent node');

    // Restore for any later test
    await query(
      `UPDATE ivr_flow_versions SET graph = $2
       WHERE ivr_flow_id = $1 AND version_number = 1`,
      [publishedFlowId, JSON.stringify(phase5Graph(ersConfigId, ensConfigId))]
    );
  });
});
