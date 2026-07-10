/**
 * Deployment Engine
 *
 * Orchestrates the complete IVR deployment pipeline:
 *
 *   Validate graph
 *     → Validate audio on disk
 *     → Write ivr_executor.lua to FS_SCRIPT_DIR
 *     → Generate + write enrs_ivr.xml to FS_DIALPLAN_DIR
 *     → Verify file permissions
 *     → reloadxml via ESL
 *     → Record deployment in ivr_flow_deployments
 *
 * Called from deploymentController.deployFlow().
 */

import { promises as fs } from 'fs';
import path from 'path';
import { fsPathService } from './freeSwitchPathService.js';
import { generateIvrExecutorLua } from '../utils/luaGenerator.js';
import { generateDialplanXml }    from '../utils/xmlGenerator.js';
import { eslCommand, verifyExtensionLoaded } from './eslService.js';
import { validateGraph }           from '../utils/ivrGraphValidator.js';
import { query }                   from '../db/pool.js';
import { config }                  from '../config/index.js';

// ── Step helper ───────────────────────────────────────────────────────────────

function makeReport() {
  return {
    status:   'success',
    steps:    [],
    errors:   [],
    warnings: [],
    files:    {},
  };
}

async function runStep(report, name, fn) {
  const step = { name, status: 'running', started_at: new Date().toISOString() };
  report.steps.push(step);
  try {
    const result = await fn();
    step.status = 'ok';
    step.finished_at = new Date().toISOString();
    return result;
  } catch (err) {
    step.status  = 'failed';
    step.error   = err.message;
    step.finished_at = new Date().toISOString();
    throw err;
  }
}

// ── Audio validation ──────────────────────────────────────────────────────────

async function validateAudioFiles(graph) {
  const issues = [];
  const nodes  = graph.nodes || {};

  for (const [nodeId, node] of Object.entries(nodes)) {
    if (!node) continue;
    const uris = [];

    if (node.audio_url)        uris.push({ field: 'audio_url',        uri: node.audio_url });
    if (node.play_audio_url)   uris.push({ field: 'play_audio_url',   uri: node.play_audio_url });
    if (node.prompt_audio_url) uris.push({ field: 'prompt_audio_url', uri: node.prompt_audio_url });

    for (const { field, uri } of uris) {
      if (!uri.startsWith('/media/')) continue;
      const fsPath = fsPathService.resolveMediaPath(uri);
      try {
        await fs.access(fsPath, fs.constants.F_OK);
      } catch {
        issues.push({
          node:     nodeId,
          field,
          uri,
          fs_path:  fsPath,
          message:  `Audio file not found on disk: ${fsPath}`,
        });
      }
    }
  }

  return issues;
}

// ── Ensure FS directories exist ───────────────────────────────────────────────

async function ensureDirs() {
  const dialplanTargetDir = await fsPathService.detectDialplanTargetDir();
  const dirs = [
    fsPathService.getScriptDir(),
    fsPathService.getDialplanDir(),
    dialplanTargetDir,
    fsPathService.getEnrsSoundDir(),
    fsPathService.getIvrRecordingDir(),
  ];
  for (const dir of dirs) {
    await fs.mkdir(dir, { recursive: true }).catch(err => {
      if (err.code !== 'EEXIST') throw err;
    });
  }
}

// ── Deploy Lua executor ───────────────────────────────────────────────────────

async function deployLuaExecutor() {
  const luaContent = generateIvrExecutorLua({
    apiBase:   config.freeswitch?.apiUrl || `http://127.0.0.1:${config.port}`,
    apiKey:    process.env.INTERNAL_API_KEY || '',
    ttsEngine: process.env.FS_TTS_ENGINE || 'flite|kal',
  });

  const luaPath = fsPathService.getExecutorLuaFile();
  await fs.writeFile(luaPath, luaContent, 'utf8');

  // Ensure readable by freeswitch process
  await fs.chmod(luaPath, 0o644).catch(() => {});

  return luaPath;
}

// ── Deploy dialplan XML ───────────────────────────────────────────────────────

async function deployDialplanXml() {
  // Gather ALL published flows that have bound numbers
  const { rows: bindings } = await query(
    `SELECT en.number,
            f.flow_uuid,
            f.name  AS flow_name,
            v.version_number
     FROM emergency_numbers en
     JOIN ivr_flows        f  ON f.id = en.ivr_flow_id
     JOIN ivr_flow_versions v  ON v.ivr_flow_id = f.id
       AND v.version_number = (
         SELECT MAX(v2.version_number) FROM ivr_flow_versions v2
         WHERE v2.ivr_flow_id = f.id
       )
     WHERE en.deleted_at IS NULL
       AND en.is_active = true
       AND en.ivr_flow_id IS NOT NULL
     ORDER BY en.number`
  );

  const xmlContent = generateDialplanXml(bindings);
  const xmlPath    = await fsPathService.getIvrDialplanFile();

  await fs.writeFile(xmlPath, xmlContent, 'utf8');
  await fs.chmod(xmlPath, 0o644).catch(() => {});

  return { xmlPath, bindingCount: bindings.length };
}

// ── Main deploy function ──────────────────────────────────────────────────────

export async function deployFlow(flowUuid, { deployedBy, tenantId }) {
  const report = makeReport();
  let versionNumber = null;
  let luaPath       = null;
  let xmlPath       = null;

  try {
    // 1. Fetch the most recently published version
    const flow = await runStep(report, 'fetch_published_version', async () => {
      const { rows } = await query(
        `SELECT f.id, f.name, f.flow_uuid,
                v.version_number, v.graph AS published_graph
         FROM ivr_flows f
         JOIN ivr_flow_versions v ON v.ivr_flow_id = f.id
         WHERE f.flow_uuid = $1
           AND ($2::int IS NULL OR f.tenant_id = $2)
         ORDER BY v.version_number DESC
         LIMIT 1`,
        [flowUuid, tenantId || null]
      );
      if (!rows[0]) throw new Error(`No published version found for flow ${flowUuid}`);
      return rows[0];
    });

    versionNumber = flow.version_number;

    // 2. Validate graph
    await runStep(report, 'validate_graph', async () => {
      const graph = typeof flow.published_graph === 'string'
        ? JSON.parse(flow.published_graph)
        : flow.published_graph;
      const result = await validateGraph(graph, tenantId);
      if (!result.valid) {
        throw new Error('Graph validation failed: ' + result.errors.join('; '));
      }
      if (result.warnings?.length) report.warnings.push(...result.warnings);
    });

    // 3. Check audio files (warnings only — don't block deploy)
    await runStep(report, 'validate_audio_files', async () => {
      const graph = typeof flow.published_graph === 'string'
        ? JSON.parse(flow.published_graph)
        : flow.published_graph;
      const audioIssues = await validateAudioFiles(graph);
      if (audioIssues.length > 0) {
        for (const issue of audioIssues) {
          report.warnings.push(`Node ${issue.node}.${issue.field}: ${issue.message}`);
        }
        report.files.audio_issues = audioIssues;
      }
    });

    // 4. Ensure FS directories exist and are writable
    await runStep(report, 'ensure_directories', ensureDirs);

    // 5. Deploy Lua executor (overwrites if already there — idempotent)
    luaPath = await runStep(report, 'deploy_lua_executor', deployLuaExecutor);
    report.files.lua = luaPath;

    // 6. Generate + deploy dialplan XML
    const xmlResult = await runStep(report, 'deploy_dialplan_xml', deployDialplanXml);
    xmlPath = xmlResult.xmlPath;
    report.files.xml          = xmlPath;
    report.files.bound_numbers = xmlResult.bindingCount;

    // 7. reloadxml via ESL
    let eslConnected = true;
    await runStep(report, 'reloadxml', async () => {
      try {
        const res = await eslCommand('reloadxml');
        if (res && res.toLowerCase().includes('fail')) {
          throw new Error('reloadxml returned failure: ' + res);
        }
      } catch (eslErr) {
        // ESL offline is a warning, not a fatal error
        // (files are deployed; dialplan will load on next FS restart)
        eslConnected = false;
        report.warnings.push('ESL reloadxml skipped (ESL not connected): ' + eslErr.message);
      }
    });

    // 8. Verify the deploy actually loaded — do NOT trust reloadxml's "+OK".
    //    A file written to the wrong directory (e.g. a sibling <context>
    //    node that default.xml's nested include never merges in) makes
    //    reloadxml report success while the extension is silently dead.
    if (eslConnected) {
      await runStep(report, 'verify_extension_loaded', async () => {
        const { rows: boundNumbers } = await query(
          `SELECT number FROM emergency_numbers
           WHERE ivr_flow_id = $1 AND deleted_at IS NULL AND is_active = true`,
          [flow.id]
        );

        if (boundNumbers.length === 0) {
          report.warnings.push('No numbers are bound to this flow yet — nothing to verify. Bind a number, then Deploy again to confirm it loads.');
          return;
        }

        const unloaded = [];
        for (const { number } of boundNumbers) {
          const extensionName = `enrs_ivr_${number}`;
          const { loaded } = await verifyExtensionLoaded(extensionName);
          if (!loaded) unloaded.push(extensionName);
        }

        if (unloaded.length > 0) {
          throw new Error(
            `Deployed files were written but FreeSWITCH did not load the extension${unloaded.length > 1 ? 's' : ''} ` +
            `(${unloaded.join(', ')}). Check dialplan/default.xml's include pattern on this box — ` +
            `run GET /deployment/diagnostics to see the resolved include chain.`
          );
        }
      });
    } else {
      report.warnings.push('Extension-load verification skipped (ESL not connected) — files are deployed but not confirmed live.');
    }

    // 9. Update deployment cache on ivr_flows + insert history row
    await runStep(report, 'record_deployment', async () => {
      await query(
        `UPDATE ivr_flows
         SET last_deployed_at      = now(),
             last_deployment_status = 'success',
             last_deployed_version  = $2,
             updated_at             = now()
         WHERE flow_uuid = $1`,
        [flowUuid, versionNumber]
      );
      await query(
        `INSERT INTO ivr_flow_deployments
           (flow_uuid, deployed_by, status, version_number, lua_path, xml_path, report)
         VALUES ($1, $2, 'success', $3, $4, $5, $6)`,
        [flowUuid, deployedBy || null, versionNumber, luaPath, xmlPath, JSON.stringify(report)]
      );
    });

  } catch (err) {
    report.status = 'failed';
    report.errors.push(err.message);

    // Best-effort: record the failed deployment
    try {
      await query(
        `UPDATE ivr_flows
         SET last_deployed_at      = now(),
             last_deployment_status = 'failed',
             updated_at             = now()
         WHERE flow_uuid = $1`,
        [flowUuid]
      );
      await query(
        `INSERT INTO ivr_flow_deployments
           (flow_uuid, deployed_by, status, version_number, lua_path, xml_path,
            error_message, report)
         VALUES ($1, $2, 'failed', $3, $4, $5, $6, $7)`,
        [flowUuid, deployedBy || null, versionNumber,
         luaPath, xmlPath, err.message, JSON.stringify(report)]
      );
    } catch { /* ignore recording failure */ }
  }

  return report;
}

// ── Re-deploy all flows (called after bind/unbind) ────────────────────────────

export async function redeployAll() {
  const { rows: flows } = await query(
    `SELECT DISTINCT f.flow_uuid, f.name,
            v.version_number
     FROM ivr_flows f
     JOIN ivr_flow_versions v ON v.ivr_flow_id = f.id
       AND v.version_number = (
         SELECT MAX(v2.version_number) FROM ivr_flow_versions v2
         WHERE v2.ivr_flow_id = f.id
       )
     JOIN emergency_numbers en ON en.ivr_flow_id = f.id
     WHERE en.deleted_at IS NULL AND en.is_active = true`
  );

  if (flows.length === 0) return { message: 'No bound flows to deploy' };

  // Only regenerate XML + reloadxml (Lua executor is the same for all)
  const { xmlPath, bindingCount } = await deployDialplanXml();

  try {
    await eslCommand('reloadxml');
  } catch { /* non-fatal */ }

  return {
    xml_path:      xmlPath,
    binding_count: bindingCount,
    flow_count:    flows.length,
  };
}

// ── Deployment history ────────────────────────────────────────────────────────

export async function getDeploymentHistory(flowUuid, limit = 10) {
  const { rows } = await query(
    `SELECT d.id, d.deployed_at, d.status, d.version_number,
            d.lua_path, d.xml_path, d.error_message,
            u.email AS deployed_by_email
     FROM ivr_flow_deployments d
     LEFT JOIN users u ON u.id = d.deployed_by
     WHERE d.flow_uuid = $1
     ORDER BY d.deployed_at DESC
     LIMIT $2`,
    [flowUuid, limit]
  );
  return rows;
}

// ── Generate preview (no file write) ─────────────────────────────────────────

export async function previewDeployment(flowUuid, tenantId) {
  const { rows: [flow] } = await query(
    `SELECT f.name, f.flow_uuid, v.version_number, v.graph AS published_graph
     FROM ivr_flows f
     JOIN ivr_flow_versions v ON v.ivr_flow_id = f.id
     WHERE f.flow_uuid = $1
       AND ($2::int IS NULL OR f.tenant_id = $2)
     ORDER BY v.version_number DESC LIMIT 1`,
    [flowUuid, tenantId || null]
  );
  if (!flow) return null;

  const graph  = typeof flow.published_graph === 'string'
    ? JSON.parse(flow.published_graph)
    : flow.published_graph;

  const audioIssues = await validateAudioFiles(graph);

  const { rows: bindings } = await query(
    `SELECT en.number FROM emergency_numbers en
     WHERE en.ivr_flow_id = (SELECT id FROM ivr_flows WHERE flow_uuid = $1)
       AND en.deleted_at IS NULL AND en.is_active = true`,
    [flowUuid]
  );

  return {
    flow_name:       flow.name,
    version_number:  flow.version_number,
    lua_target:      fsPathService.getExecutorLuaFile(),
    xml_target:      await fsPathService.getIvrDialplanFile(),
    bound_numbers:   bindings.map(b => b.number),
    audio_issues:    audioIssues,
    paths:           fsPathService.getSummary(),
  };
}
