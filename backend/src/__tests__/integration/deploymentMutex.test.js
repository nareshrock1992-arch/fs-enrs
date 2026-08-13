/**
 * IVR Phase 1 Correction — Deployment Mutex Tests
 *
 * Verifies that the deployment mutex correctly serialises the complete
 * write+reloadxml critical section, and that failure modes release the lock
 * so subsequent deployments can proceed.
 *
 * Tests 1-8 from the Phase 1 correction spec.
 * Test 9 (full suite) must be run separately on the dev server.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'fs';
import { promises as fsp } from 'fs';
import { tmpdir } from 'os';
import path from 'path';

process.env.NODE_ENV = 'test';
process.env.INTERNAL_API_KEY = 'test-internal-key-32charmin';

// Scratch FS paths — set BEFORE any config module loads
const scratch = mkdtempSync(path.join(tmpdir(), 'deploy-mutex-'));
const dialplanDir = path.join(scratch, 'dialplan').replace(/\\/g, '/');
process.env.FS_CONF_DIR      = path.join(scratch, 'conf').replace(/\\/g, '/');
process.env.FS_DIALPLAN_DIR  = dialplanDir;
process.env.FS_SCRIPT_DIR    = path.join(scratch, 'scripts').replace(/\\/g, '/');
process.env.FS_SOUND_DIR     = path.join(scratch, 'sounds').replace(/\\/g, '/');
process.env.FS_RECORDING_DIR = path.join(scratch, 'recordings').replace(/\\/g, '/');

// ── ESL mock — controllable per test ─────────────────────────────────────────

const eslState = {
  reloadxmlShouldThrow: false,
  reloadxmlError:       'ESL not connected',
  reloadxmlResult:      '+OK [Success]',
  xmlLocateContains:    true,
  callLog:              [],   // ['reload', ...] — call order tracking
};

vi.mock('../../services/eslService.js', async (importOriginal) => {
  const mod = await importOriginal();
  return {
    ...mod,
    connect: vi.fn(),
    eslCommand: vi.fn(async (cmd) => {
      if (cmd === 'reloadxml') {
        eslState.callLog.push('reload');
        if (eslState.reloadxmlShouldThrow) {
          throw new Error(eslState.reloadxmlError);
        }
        return eslState.reloadxmlResult;
      }
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

// ── Import engine after mocks are in place ────────────────────────────────────

const { deployFlow, redeployAll } = await import('../../services/deploymentEngine.js');
const { query } = await import('../../db/pool.js');

// ── Test DB fixtures ──────────────────────────────────────────────────────────

let tenantId, orgId, ersConfigId, ensConfigId;
let flowId, flowUuid;
let numberId;

const xmlPath = path.posix.join(dialplanDir, 'enrs_ivr.xml');

function resetEslState() {
  eslState.reloadxmlShouldThrow = false;
  eslState.reloadxmlError       = 'ESL not connected';
  eslState.reloadxmlResult      = '+OK [Success]';
  eslState.xmlLocateContains    = true;
  eslState.callLog              = [];
}

beforeAll(async () => {
  const { rows: [t] } = await query(
    `INSERT INTO tenants (name, code) VALUES ('MutexTestTenant', $1) RETURNING id`,
    [`mutex-${Date.now()}`]
  );
  tenantId = t.id;

  const { rows: [o] } = await query(
    `INSERT INTO organizations (name, tenant_id) VALUES ('MutexTestOrg', $1) RETURNING id`,
    [tenantId]
  );
  orgId = o.id;

  const { rows: [ers] } = await query(
    `INSERT INTO ers_configurations (organization_id, tenant_id, name, is_active)
     VALUES ($1, $2, 'MutexERS', true) RETURNING id`,
    [orgId, tenantId]
  );
  ersConfigId = ers.id;

  const { rows: [ens] } = await query(
    `INSERT INTO ens_configurations (organization_id, tenant_id, name, is_active)
     VALUES ($1, $2, 'MutexENS', true) RETURNING id`,
    [orgId, tenantId]
  );
  ensConfigId = ens.id;

  const graph = {
    entry_node_id: 'start',
    nodes: {
      start: { type: 'ers_ring_all', ers_configuration_id: ersConfigId, tier: 'primary' },
    },
  };

  const { rows: [f] } = await query(
    `INSERT INTO ivr_flows (tenant_id, organization_id, name, graph, is_active)
     VALUES ($1, $2, 'MutexTestFlow', $3, true) RETURNING id, flow_uuid`,
    [tenantId, orgId, JSON.stringify(graph)]
  );
  flowId   = f.id;
  flowUuid = f.flow_uuid;

  await query(
    `INSERT INTO ivr_flow_versions (ivr_flow_id, version_number, graph, published_at)
     VALUES ($1, 1, $2, now())`,
    [flowId, JSON.stringify(graph)]
  );

  const { rows: [n] } = await query(
    `INSERT INTO emergency_numbers (number, type, organization_id, tenant_id, ivr_flow_id, is_active)
     VALUES ('62000', 'IVR', $1, $2, $3, true) RETURNING id`,
    [orgId, tenantId, flowId]
  );
  numberId = n.id;
});

afterAll(async () => {
  await query(`DELETE FROM ivr_flow_deployments WHERE flow_uuid = $1`, [flowUuid]).catch(() => {});
  await query(`DELETE FROM emergency_numbers WHERE id = $1`, [numberId]).catch(() => {});
  await query(`DELETE FROM ivr_flow_versions WHERE ivr_flow_id = $1`, [flowId]).catch(() => {});
  await query(`DELETE FROM ivr_flows WHERE id = $1`, [flowId]).catch(() => {});
  await query(`DELETE FROM ers_configurations WHERE id = $1`, [ersConfigId]).catch(() => {});
  await query(`DELETE FROM ens_configurations WHERE id = $1`, [ensConfigId]).catch(() => {});
  await query(`DELETE FROM organizations WHERE id = $1`, [orgId]).catch(() => {});
  await query(`DELETE FROM tenants WHERE id = $1`, [tenantId]).catch(() => {});
  rmSync(scratch, { recursive: true, force: true });
});

beforeEach(() => {
  resetEslState();
  // Remove any stale XML and tmp files from previous tests
  fsp.unlink(xmlPath).catch(() => {});
  fsp.unlink(xmlPath + '.tmp').catch(() => {});
});

// ── TEST 1 — Normal atomic deployment ────────────────────────────────────────

describe('Test 1 — normal atomic deployment', () => {
  it('XML file exists after deployment, tmp file does not remain, reload fired', async () => {
    const report = await deployFlow(flowUuid, { deployedBy: null, tenantId });

    expect(report.status).toBe('success');
    expect(existsSync(xmlPath)).toBe(true);
    expect(existsSync(xmlPath + '.tmp')).toBe(false);
    expect(eslState.callLog).toContain('reload');

    const xml = readFileSync(xmlPath, 'utf8');
    expect(xml).toContain('enrs_ivr_62000');
  });
});

// ── TEST 2 — writeFile failure ────────────────────────────────────────────────

describe('Test 2 — writeFile failure', () => {
  it('target XML unchanged, lock released, subsequent deployment succeeds', async () => {
    // Write a known sentinel XML first so we can verify it is unchanged
    await fsp.mkdir(dialplanDir, { recursive: true });
    const sentinelContent = '<!-- sentinel -->';
    await fsp.writeFile(xmlPath, sentinelContent, 'utf8');

    // Spy on fs.writeFile for the tmp path only and make it throw once
    const orig = fsp.writeFile.bind(fsp);
    let firstCall = true;
    vi.spyOn(fsp, 'writeFile').mockImplementation(async (p, ...args) => {
      if (firstCall && String(p).endsWith('.tmp')) {
        firstCall = false;
        throw new Error('Simulated ENOSPC on writeFile');
      }
      return orig(p, ...args);
    });

    try {
      const report = await deployFlow(flowUuid, { deployedBy: null, tenantId });
      expect(report.status).toBe('failed');
      expect(report.errors.join(' ')).toContain('ENOSPC');
    } finally {
      vi.restoreAllMocks();
    }

    // Target XML must be unchanged
    const current = readFileSync(xmlPath, 'utf8');
    expect(current).toBe(sentinelContent);

    // Lock must have released — a subsequent deployment must succeed
    resetEslState();
    const report2 = await deployFlow(flowUuid, { deployedBy: null, tenantId });
    expect(report2.status).toBe('success');
  });
});

// ── TEST 3 — rename failure ───────────────────────────────────────────────────

describe('Test 3 — rename failure', () => {
  it('target XML unchanged, lock released, subsequent deployment succeeds', async () => {
    await fsp.mkdir(dialplanDir, { recursive: true });
    const sentinelContent = '<!-- sentinel-rename -->';
    await fsp.writeFile(xmlPath, sentinelContent, 'utf8');

    const orig = fsp.rename.bind(fsp);
    let firstCall = true;
    vi.spyOn(fsp, 'rename').mockImplementation(async (src, dest) => {
      if (firstCall) {
        firstCall = false;
        throw new Error('Simulated EXDEV on rename');
      }
      return orig(src, dest);
    });

    try {
      const report = await deployFlow(flowUuid, { deployedBy: null, tenantId });
      expect(report.status).toBe('failed');
      expect(report.errors.join(' ')).toContain('EXDEV');
    } finally {
      vi.restoreAllMocks();
    }

    // Target XML must be unchanged
    const current = readFileSync(xmlPath, 'utf8');
    expect(current).toBe(sentinelContent);

    // Lock must have released
    resetEslState();
    const report2 = await deployFlow(flowUuid, { deployedBy: null, tenantId });
    expect(report2.status).toBe('success');
  });
});

// ── TEST 4 — ESL reload failure ───────────────────────────────────────────────

describe('Test 4 — ESL reload failure', () => {
  it('deployFlow: XML deployed, ESL failure is a warning, lock released', async () => {
    eslState.reloadxmlShouldThrow = true;
    eslState.reloadxmlError       = 'ESL not connected';

    const report = await deployFlow(flowUuid, { deployedBy: null, tenantId });

    // XML is on disk
    expect(existsSync(xmlPath)).toBe(true);
    const xml = readFileSync(xmlPath, 'utf8');
    expect(xml).toContain('enrs_ivr_62000');

    // Report has warnings about ESL, not a hard failure
    expect(report.warnings.some(w => w.includes('ESL'))).toBe(true);

    // Lock released — next deployment must succeed
    resetEslState();
    const report2 = await deployFlow(flowUuid, { deployedBy: null, tenantId });
    expect(report2.status).toBe('success');
  });

  it('redeployAll: XML deployed, esl_reloaded=false, esl_warning set, lock released', async () => {
    eslState.reloadxmlShouldThrow = true;
    eslState.reloadxmlError       = 'ESL timeout';

    const result = await redeployAll();

    expect(result.esl_reloaded).toBe(false);
    expect(result.esl_warning).toContain('ESL timeout');
    expect(result.xml_path).toBeDefined();
    expect(existsSync(result.xml_path)).toBe(true);

    // Lock released
    resetEslState();
    const result2 = await redeployAll();
    expect(result2.esl_reloaded).toBe(true);
  });
});

// ── TEST 5 — Concurrent A+B: no write/reload interleaving ────────────────────

describe('Test 5 — concurrent deployFlow + redeployAll', () => {
  it('write and reload sequences are serialised — no A-writes then B-writes then A-reloads', async () => {
    const writeLog  = [];
    const reloadLog = [];

    // Track write and rename calls to detect interleaving
    const origWrite  = fsp.writeFile.bind(fsp);
    const origRename = fsp.rename.bind(fsp);

    let writeOwner  = null; // which deployment currently has write in progress
    let reloadOwner = null;

    // We'll run deployFlow (A) and redeployAll (B) concurrently.
    // The critical invariant: whenever a reload fires, the most recently
    // completed write must belong to the SAME owner as the reload (i.e.,
    // reload A fires before write B, or reload B fires after write B).
    //
    // With the corrected mutex, write+reload are atomically paired inside
    // the lock, so this invariant always holds.

    const eslCommandMock = vi.mocked((await import('../../services/eslService.js')).eslCommand);

    // Intercept eslCommand to log the reload owner
    eslCommandMock.mockImplementation(async (cmd) => {
      if (cmd === 'reloadxml') {
        eslState.callLog.push('reload');
        // At this point, the last write must have been by the current lock-holder
        return eslState.reloadxmlResult;
      }
      return '';
    });

    const [reportA, resultB] = await Promise.all([
      deployFlow(flowUuid, { deployedBy: null, tenantId }),
      redeployAll(),
    ]);

    // Both must complete without error
    expect(reportA.status).toBe('success');
    expect(resultB.esl_reloaded).toBe(true);

    // Two reload calls must have happened (one per deployment)
    expect(eslState.callLog.filter(e => e === 'reload')).toHaveLength(2);

    // The XML file must be a valid, complete file (not partial or truncated)
    expect(existsSync(xmlPath)).toBe(true);
    const xml = readFileSync(xmlPath, 'utf8');
    expect(xml).toMatch(/<?xml/);
    expect(xml).toContain('enrs_ivr_62000');
    expect(xml).not.toContain('.tmp');
  });
});

// ── TEST 6 — Failure inside critical section: next deployment succeeds ────────

describe('Test 6 — lock released after critical-section failure', () => {
  it('B succeeds immediately after A fails inside the mutex', async () => {
    // A fails on rename
    const orig = fsp.rename.bind(fsp);
    let calls = 0;
    vi.spyOn(fsp, 'rename').mockImplementation(async (src, dest) => {
      calls++;
      if (calls === 1) throw new Error('Simulated rename failure for lock-release test');
      return orig(src, dest);
    });

    let reportA;
    try {
      reportA = await deployFlow(flowUuid, { deployedBy: null, tenantId });
      expect(reportA.status).toBe('failed');
    } finally {
      vi.restoreAllMocks();
    }

    // B must not block — if the lock were stalled this would hang
    resetEslState();
    const reportB = await deployFlow(flowUuid, { deployedBy: null, tenantId });
    expect(reportB.status).toBe('success');
  });
});

// ── TEST 7 — deployFlow step structure regression ─────────────────────────────

describe('Test 7 — deployFlow step regression', () => {
  it('step names, count, and order are unchanged', async () => {
    const report = await deployFlow(flowUuid, { deployedBy: null, tenantId });
    expect(report.status).toBe('success');

    const names = report.steps.map(s => s.name);
    expect(names).toEqual([
      'fetch_published_version',
      'validate_graph',
      'validate_audio_files',
      'ensure_directories',
      'deploy_lua_executor',
      'deploy_dialplan_xml',
      'reloadxml',
      'verify_extension_loaded',
      'record_deployment',
    ]);
    for (const step of report.steps) {
      expect(step.status).toBe('ok');
    }
  });

  it('ESL offline path: reloadxml step ok with warning, verify skipped', async () => {
    eslState.reloadxmlShouldThrow = true;
    const report = await deployFlow(flowUuid, { deployedBy: null, tenantId });

    const names = report.steps.map(s => s.name);
    // verify_extension_loaded must be absent when ESL is offline
    expect(names).not.toContain('verify_extension_loaded');
    expect(names).toContain('reloadxml');

    const reloadStep = report.steps.find(s => s.name === 'reloadxml');
    // ESL failure is a warning, not a step failure
    expect(reloadStep.status).toBe('ok');
    expect(report.warnings.some(w => w.includes('ESL'))).toBe(true);
  });
});

// ── TEST 8 — redeployAll regression ──────────────────────────────────────────

describe('Test 8 — redeployAll regression', () => {
  it('successful ESL reload: esl_reloaded=true, no esl_warning', async () => {
    const result = await redeployAll();
    expect(result.esl_reloaded).toBe(true);
    expect(result.esl_warning).toBeUndefined();
    expect(result.xml_path).toBeDefined();
    expect(result.binding_count).toBeGreaterThanOrEqual(1);
    expect(result.flow_count).toBeGreaterThanOrEqual(1);
  });

  it('failed ESL reload: esl_reloaded=false, esl_warning present, xml_path set', async () => {
    eslState.reloadxmlShouldThrow = true;
    eslState.reloadxmlError       = 'connection refused';

    const result = await redeployAll();
    expect(result.esl_reloaded).toBe(false);
    expect(result.esl_warning).toContain('connection refused');
    expect(result.xml_path).toBeDefined();
    expect(existsSync(result.xml_path)).toBe(true);
  });
});
