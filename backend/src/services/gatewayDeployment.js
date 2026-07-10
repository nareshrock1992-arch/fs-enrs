/**
 * SIP Gateway deployment — Phase 4.
 *
 * Reuses the exact same pipeline shape deploymentEngine.js already uses
 * for IVR dialplan XML: generate → write to disk → reloadxml via ESL →
 * verify it actually loaded. Adding a real Avaya/Cisco trunk is meant to
 * be a config change through this same mechanism, never a bespoke
 * second deployment path.
 */

import { promises as fs } from 'fs';
import path from 'path';
import { fsPathService } from './freeSwitchPathService.js';
import { generateGatewayXml } from '../utils/gatewayXmlGenerator.js';
import { eslCommand } from './eslService.js';
import { query } from '../db/pool.js';

function gatewayFilePath(name) {
  return path.posix.join(fsPathService.getSipProfileDir(), 'external', `${name}.xml`);
}

export async function deployGateway(gatewayId) {
  const { rows: [gw] } = await query(
    `SELECT * FROM sip_gateways WHERE id = $1 AND deleted_at IS NULL`,
    [gatewayId]
  );
  if (!gw) throw Object.assign(new Error('Gateway not found'), { status: 404 });

  const xml = generateGatewayXml(gw);
  const filePath = gatewayFilePath(gw.name);

  await fs.mkdir(path.posix.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, xml, 'utf8');
  await fs.chmod(filePath, 0o644).catch(() => {});

  let reloaded = true;
  let reloadError = null;
  try {
    await eslCommand('reloadxml');
    // Rescan the external profile so the new/changed gateway actually
    // registers — reloadxml alone re-parses config but does not by
    // itself force mod_sofia to pick up a new gateway file.
    await eslCommand('sofia profile external rescan');
  } catch (err) {
    reloaded = false;
    reloadError = err.message;
  }

  let verified = false;
  let verifyRaw = '';
  if (reloaded) {
    try {
      // A short settle delay before checking — mirrors the retry
      // rationale in eslService.js's verifyExtensionLoaded: profile
      // rescans are not instantaneous.
      await new Promise(r => setTimeout(r, 500));
      verifyRaw = await eslCommand(`sofia status gateway ${gw.name}`);
      verified = typeof verifyRaw === 'string' && verifyRaw.toLowerCase().includes(gw.name.toLowerCase());
    } catch (err) {
      verifyRaw = err.message;
    }
  }

  const status = reloaded && verified ? 'success' : 'failed';
  await query(
    `UPDATE sip_gateways SET last_deployed_at = now(), last_deployment_status = $2, updated_at = now() WHERE id = $1`,
    [gatewayId, status]
  );

  return {
    status,
    file_path: filePath,
    reloaded,
    reload_error: reloadError,
    verified,
    verify_detail: verifyRaw,
  };
}
