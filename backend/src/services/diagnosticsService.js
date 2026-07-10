/**
 * FreeSWITCH Diagnostics Service
 *
 * Verifies every integration point between the ENRS backend and FreeSWITCH:
 *
 *   ESL connectivity        — can Node.js talk to FreeSWITCH ESL?
 *   Directory writability   — can backend write Lua + XML + audio?
 *   Path comparison         — do .env paths match running FS global vars?
 *   Lua file existence      — is ivr_executor.lua deployed?
 *   XML file existence      — is enrs_ivr.xml deployed?
 *   Audio directory         — does the ENRS sound dir exist?
 *
 * Each check returns: { label, status: 'pass'|'warn'|'fail', detail, action? }
 */

import { promises as fs, constants as fsc } from 'fs';
import path from 'path';
import { execSync } from 'child_process';
import { fsPathService } from './freeSwitchPathService.js';
import { eslCommand, eslStatus } from './eslService.js';
import { query } from '../db/pool.js';

// ── Status helpers ────────────────────────────────────────────────────────────

const pass = (label, detail)         => ({ label, status: 'pass', detail });
const warn = (label, detail, action) => ({ label, status: 'warn', detail, action });
const fail = (label, detail, action) => ({ label, status: 'fail', detail, action });

// ── Individual checks ─────────────────────────────────────────────────────────

async function checkEsl() {
  const st = eslStatus();
  if (!st.connected) {
    return fail(
      'ESL Connectivity',
      `Not connected to FreeSWITCH ESL at ${st.host}:${st.port}`,
      'Verify FreeSWITCH is running and ESL password in .env matches event_socket.conf.xml'
    );
  }
  try {
    const res = await eslCommand('status');
    return pass('ESL Connectivity', `Connected to ${st.host}:${st.port} — ${(res || '').split('\n')[0]}`);
  } catch (e) {
    return warn('ESL Connectivity', `Connected but command failed: ${e.message}`);
  }
}

async function checkDirWritable(label, dirPath, action) {
  try {
    await fs.access(dirPath, fsc.F_OK);
  } catch {
    return fail(label, `Directory does not exist: ${dirPath}`,
      action || `Create the directory: mkdir -p "${dirPath}"`);
  }
  try {
    await fs.access(dirPath, fsc.W_OK);
    return pass(label, dirPath);
  } catch {
    return fail(label, `Directory not writable: ${dirPath}`,
      `Grant write permission: chmod a+w "${dirPath}" or chown freeswitch:freeswitch "${dirPath}"`);
  }
}

async function checkDirExists(label, dirPath) {
  try {
    await fs.access(dirPath, fsc.F_OK);
    const stat = await fs.stat(dirPath);
    if (!stat.isDirectory()) return fail(label, `Path exists but is not a directory: ${dirPath}`);
    return pass(label, dirPath);
  } catch {
    return warn(label, `Directory does not exist yet: ${dirPath}`,
      `It will be created automatically on first Deploy`);
  }
}

async function checkFileExists(label, filePath, action) {
  try {
    await fs.access(filePath, fsc.F_OK);
    const stat = await fs.stat(filePath);
    return pass(label, `${filePath} (${(stat.size / 1024).toFixed(1)} KB)`);
  } catch {
    return warn(label, `File not yet deployed: ${filePath}`,
      action || 'Use the Deploy button in the IVR Builder to generate this file');
  }
}

async function checkFsGlobalVars() {
  const varMap = {
    'conf_dir':        { key: 'configDir',    env: 'FS_CONF_DIR' },
    'script_dir':      { key: 'scriptDir',    env: 'FS_SCRIPT_DIR' },
    'sounds_dir':      { key: 'soundDir',     env: 'FS_SOUND_DIR' },
    'recordings_dir':  { key: 'recordingDir', env: 'FS_RECORDING_DIR' },
    'storage_dir':     { key: 'storageDir',   env: 'FS_STORAGE_DIR' },
    'db_dir':          { key: 'dbDir',        env: 'FS_DB_DIR' },
    'log_dir':         { key: 'logDir',       env: 'FS_LOG_DIR' },
  };

  const results = [];
  const summary = fsPathService.getSummary();

  // Try to get FS global vars via ESL
  let eslOk = false;
  try {
    eslOk = eslStatus().connected;
  } catch { /* ignore */ }

  for (const [fsVar, { key, env: envVar }] of Object.entries(varMap)) {
    const configured = summary[key];
    let actual = null;

    if (eslOk) {
      try {
        const res = await eslCommand(`global_getvar ${fsVar}`);
        if (res && !res.toLowerCase().includes('fail') && !res.toLowerCase().includes('undef')) {
          actual = res.trim();
        }
      } catch { /* ignore — ESL may not support this var */ }
    }

    if (!actual) {
      results.push(warn(
        `FS Path: ${fsVar}`,
        `Configured: ${configured} | FreeSWITCH actual: unknown (ESL not available)`,
        'Connect ESL to compare paths, or set env var: ' + envVar
      ));
    } else if (actual === configured) {
      results.push(pass(`FS Path: ${fsVar}`, `MATCH — ${configured}`));
    } else {
      results.push(fail(
        `FS Path: ${fsVar}`,
        `MISMATCH — Configured: ${configured} | FreeSWITCH actual: ${actual}`,
        `Update ${envVar}="${actual}" in your .env file`
      ));
    }
  }

  return results;
}

async function checkAudioCount() {
  // Count audio files deployed to FS
  try {
    const soundDir = fsPathService.getEnrsSoundDir();
    await fs.access(soundDir, fsc.F_OK);
    const files = await fs.readdir(soundDir);
    const audioFiles = files.filter(f => /\.(wav|mp3|ogg|gsm|ul)$/i.test(f));
    return pass(
      'ENRS Audio Directory',
      `${soundDir} — ${audioFiles.length} audio file(s) deployed`
    );
  } catch {
    return warn(
      'ENRS Audio Directory',
      `${fsPathService.getEnrsSoundDir()} does not exist yet`,
      'Upload audio files via Audio Library and deploy them to FreeSWITCH'
    );
  }
}

// ── Dialplan include chain ────────────────────────────────────────────────────
//
// Walks the same include chain FreeSWITCH itself walks to assemble the live
// "default" routing context: freeswitch.xml's top-level dialplan include,
// then default.xml's own nested include (if any). Reports the fully-resolved
// directory extensions actually load from, as a setup step rather than a
// silent trap discovered only by tailing fs_cli logs during a real call.

async function checkDialplanChain() {
  const confDir            = fsPathService.getConfigDir();
  const dialplanDir        = fsPathService.getDialplanDir();
  const freeswitchXmlPath  = path.posix.join(confDir, 'freeswitch.xml');
  const defaultXmlPath     = path.posix.join(dialplanDir, 'default.xml');

  let topLevelPattern = null;
  try {
    const content = await fs.readFile(freeswitchXmlPath, 'utf8');
    const m = content.match(/<X-PRE-PROCESS\s+cmd="include"\s+data="([^"]*dialplan[^"]*)"\s*\/>/i);
    if (m) topLevelPattern = m[1];
  } catch { /* not readable from this box — reported below */ }

  const { dir: targetDir, nested } = await fsPathService.detectDialplanTargetDir();

  const chain = [
    { file: freeswitchXmlPath, include_pattern: topLevelPattern || '(not found)' },
    { file: defaultXmlPath,    resolved_target: targetDir, nested },
  ];

  if (!topLevelPattern) {
    return {
      ...warn(
        'Dialplan Include Chain',
        `Could not confirm ${freeswitchXmlPath} includes the dialplan directory — verify manually. ` +
        `Extensions will still be written to the detected target: ${targetDir}`,
        `Ensure freeswitch.xml has <X-PRE-PROCESS cmd="include" data="dialplan/*.xml"/>`
      ),
      chain,
    };
  }

  return {
    ...pass(
      'Dialplan Include Chain',
      `${freeswitchXmlPath} includes "${topLevelPattern}" → default.xml resolves live extensions to: ${targetDir}`
    ),
    chain,
  };
}

// ── Conflict scan ─────────────────────────────────────────────────────────────
//
// A matching <extension> earlier in file/glob order with continue="false"
// silently shadows our generated extension even after the target path is
// correct — this only ever surfaces as "the call routes somewhere else"
// with no error anywhere. Scan every other XML file in the detected target
// directory for destination_number conditions that could also match a
// number this app is about to bind.

async function checkDialplanConflicts(targetDir) {
  const { rows: boundNumbers } = await query(
    `SELECT DISTINCT number FROM emergency_numbers
     WHERE deleted_at IS NULL AND is_active = true AND ivr_flow_id IS NOT NULL`
  );
  if (boundNumbers.length === 0) {
    return { ...pass('Dialplan Conflict Scan', 'No IVR-bound numbers yet — nothing to check for shadowing.'), conflicts: [] };
  }

  let files;
  try {
    files = await fs.readdir(targetDir);
  } catch {
    return {
      ...warn('Dialplan Conflict Scan', `Target directory not readable yet: ${targetDir}`,
        'Will be checked again after first deploy creates it'),
      conflicts: [],
    };
  }

  const xmlFiles = files.filter(f => f.endsWith('.xml') && f !== 'enrs_ivr.xml');
  const conflicts = [];

  for (const file of xmlFiles) {
    let content;
    try {
      content = await fs.readFile(path.posix.join(targetDir, file), 'utf8');
    } catch { continue; }

    const extRe = /<extension\s+name="([^"]+)"([^>]*)>([\s\S]*?)<\/extension>/gi;
    let extMatch;
    while ((extMatch = extRe.exec(content))) {
      const [, extName, attrs, body] = extMatch;
      const continueAttr = /continue="([^"]+)"/i.exec(attrs)?.[1] ?? 'true';

      const condRe = /<condition\s+field="destination_number"\s+expression="([^"]+)"/gi;
      let condMatch;
      while ((condMatch = condRe.exec(body))) {
        const expr = condMatch[1];
        let regex;
        try { regex = new RegExp(expr); } catch { continue; }

        for (const { number } of boundNumbers) {
          if (regex.test(number)) {
            conflicts.push({
              file, extension_name: extName, continue: continueAttr, expression: expr, number,
              severity: continueAttr === 'false' ? 'blocking' : 'possible',
              message:
                `Legacy extension "${extName}" in ${file} (continue="${continueAttr}") matches number "${number}" ` +
                `via expression "${expr}"` +
                (continueAttr === 'false'
                  ? ' — this WILL shadow the ENRS extension if it loads earlier in glob order.'
                  : ' — may execute before the ENRS extension depending on glob order.'),
            });
          }
        }
      }
    }
  }

  if (conflicts.length === 0) {
    return {
      ...pass('Dialplan Conflict Scan', `${xmlFiles.length} other file(s) checked in ${targetDir} — no matching extensions found.`),
      conflicts,
    };
  }
  return {
    ...warn('Dialplan Conflict Scan', conflicts.map(c => c.message).join(' | '),
      'Rename or remove the conflicting legacy extension, or ensure it does not use continue="false" — see conflicts[] for one-click disable targets'),
    conflicts,
  };
}

// ── Disable a conflicting legacy extension (one-click fix) ───────────────────
//
// Safely comments out (never deletes) the specific matched <extension> block
// in the offending file, so a non-technical user can resolve a shadowing
// conflict from the Diagnostics UI without touching a shell. Reversible —
// the block is wrapped, not removed.

export async function disableLegacyExtension(targetDir, file, extensionName) {
  const safeFile = path.basename(file); // never allow path traversal out of targetDir
  const filePath = path.posix.join(targetDir, safeFile);

  const content = await fs.readFile(filePath, 'utf8');
  const escName = extensionName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const blockRe = new RegExp(`<extension\\s+name="${escName}"[^>]*>[\\s\\S]*?<\\/extension>`, 'i');
  const match = blockRe.exec(content);

  if (!match) {
    throw Object.assign(new Error(`Extension "${extensionName}" not found in ${safeFile}`), { status: 404 });
  }
  if (match[0].trim().startsWith('<!--')) {
    throw Object.assign(new Error(`Extension "${extensionName}" in ${safeFile} is already disabled`), { status: 409 });
  }

  const disabled =
    `<!-- DISABLED by ENRS Diagnostics (${new Date().toISOString()}) — was shadowing an ENRS-bound number.\n` +
    `     Re-enable by removing this comment wrapper.\n` +
    match[0] +
    `\n-->`;

  const updated = content.slice(0, match.index) + disabled + content.slice(match.index + match[0].length);
  await fs.writeFile(filePath, updated, 'utf8');

  return { file: safeFile, extension_name: extensionName, disabled: true };
}

// ── luasocket-free HTTP prerequisite check ────────────────────────────────────
//
// The generated ivr_executor.lua uses curl via io.popen (not luasocket) so
// there is no lua-socket/lua-cjson package dependency to install — but curl
// itself must be on PATH on the FreeSWITCH host. Node and FreeSWITCH run on
// the same box in this architecture, so checking PATH from here is accurate.

function checkCurlAvailable() {
  try {
    const out = execSync('curl --version', { timeout: 2000, stdio: ['pipe', 'pipe', 'pipe'] }).toString();
    return pass('curl Availability', out.split('\n')[0]);
  } catch {
    return fail('curl Availability',
      'curl was not found on PATH — the generated IVR executor script depends on it for every backend API call and will silently fail every call without it.',
      'Install curl: apt-get install -y curl   (Debian/Ubuntu)  OR  yum install -y curl   (RHEL/CentOS)'
    );
  }
}

// ── FreeSWITCH-user permission check ──────────────────────────────────────────
//
// A plain write failure at deploy time is cryptic ("EACCES") with no hint
// about *why*. Compare the target directory's owner/group/mode against the
// `freeswitch` system user directly so a mismatch reads as a clear warning
// during setup, not a mystery during a customer's first test call.

function getFreeswitchUidGid() {
  try {
    const uid = Number(execSync('id -u freeswitch', { timeout: 2000, stdio: ['pipe', 'pipe', 'pipe'] }).toString().trim());
    const gid = Number(execSync('id -g freeswitch', { timeout: 2000, stdio: ['pipe', 'pipe', 'pipe'] }).toString().trim());
    return Number.isFinite(uid) && Number.isFinite(gid) ? { uid, gid } : null;
  } catch {
    return null;
  }
}

async function checkFreeswitchPermissions(label, dirPath) {
  let stat;
  try {
    stat = await fs.stat(dirPath);
  } catch {
    return warn(label, `Directory does not exist yet: ${dirPath}`, 'Will be created automatically on first Deploy');
  }

  const nodeCanWrite = await fs.access(dirPath, fsc.W_OK).then(() => true).catch(() => false);
  if (!nodeCanWrite) {
    return fail(label, `Not writable by the OS user running this backend process`,
      `chown -R $(whoami) "${dirPath}"  OR run this process as a user with write access to it`);
  }

  const fsIds = getFreeswitchUidGid();
  const mode = stat.mode & 0o777;
  if (!fsIds) {
    return warn(label,
      `${dirPath} — owner uid=${stat.uid} gid=${stat.gid} mode=${mode.toString(8)}. ` +
      `Could not resolve the 'freeswitch' system user on this box to compare (id command unavailable).`);
  }

  const worldReadable  = (mode & 0o004) !== 0;
  const groupReadable  = stat.gid === fsIds.gid && (mode & 0o040) !== 0;
  const ownerReadable  = stat.uid === fsIds.uid && (mode & 0o400) !== 0;

  if (worldReadable || groupReadable || ownerReadable) {
    return pass(label, `${dirPath} — readable by freeswitch (uid=${fsIds.uid}, gid=${fsIds.gid}), mode=${mode.toString(8)}`);
  }
  return fail(label,
    `${dirPath} owned by uid=${stat.uid} gid=${stat.gid} mode=${mode.toString(8)} — NOT readable by freeswitch (uid=${fsIds.uid}, gid=${fsIds.gid})`,
    `chown freeswitch:freeswitch "${dirPath}"  OR  chmod o+r "${dirPath}"`
  );
}

// ── Main diagnostic runner ────────────────────────────────────────────────────

export async function runDiagnostics() {
  const started = new Date().toISOString();
  const checks  = [];

  // 1. ESL
  checks.push(await checkEsl());

  // 2. Writable directories
  checks.push(await checkDirWritable(
    'Script Directory (Lua)',
    fsPathService.getScriptDir(),
    'Grant write to freeswitch user: chown freeswitch:freeswitch ' + fsPathService.getScriptDir()
  ));
  checks.push(await checkDirWritable(
    'Dialplan Directory (search root)',
    fsPathService.getDialplanDir(),
    'Grant write to freeswitch user: chown freeswitch:freeswitch ' + fsPathService.getDialplanDir()
  ));

  // 3. Dialplan include chain — where extensions ACTUALLY end up live
  const dialplanChain = await checkDialplanChain();
  checks.push(dialplanChain);
  const { dir: dialplanTargetDir } = await fsPathService.detectDialplanTargetDir();

  // 3b. The detected target directory itself must be writable — this can
  // differ from FS_DIALPLAN_DIR (the search root) when a nested include
  // is in play, and is the directory that actually matters.
  if (dialplanTargetDir !== fsPathService.getDialplanDir()) {
    checks.push(await checkDirWritable(
      'Dialplan Target Directory (detected)',
      dialplanTargetDir,
      'Grant write to freeswitch user: chown freeswitch:freeswitch ' + dialplanTargetDir
    ));
  }

  // 3c. Conflict scan — other extensions in the target dir that could
  // shadow a number this app is about to bind.
  const conflictCheck = await checkDialplanConflicts(dialplanTargetDir);
  checks.push(conflictCheck);

  // 3d. freeswitch-user permission comparison on the directories that matter
  checks.push(await checkFreeswitchPermissions('Permissions: Dialplan Target Directory', dialplanTargetDir));
  checks.push(await checkFreeswitchPermissions('Permissions: Script Directory', fsPathService.getScriptDir()));

  // 4. ENRS sound dir
  checks.push(await checkAudioCount());

  // 5. Recording dirs
  checks.push(await checkDirExists('IVR Recording Directory', fsPathService.getIvrRecordingDir()));

  // 6. Deployed files
  checks.push(await checkFileExists(
    'Lua Executor (ivr_executor.lua)',
    fsPathService.getExecutorLuaFile()
  ));
  checks.push(await checkFileExists(
    'Dialplan XML (enrs_ivr.xml)',
    await fsPathService.getIvrDialplanFile()
  ));

  // 6b. curl must be on PATH — the generated Lua executor shells out to it
  // for every backend API call (no luasocket dependency by design).
  checks.push(checkCurlAvailable());

  // 7. Path comparison vs actual FS global vars
  const pathChecks = await checkFsGlobalVars();
  checks.push(...pathChecks);

  const pass_count = checks.filter(c => c.status === 'pass').length;
  const warn_count = checks.filter(c => c.status === 'warn').length;
  const fail_count = checks.filter(c => c.status === 'fail').length;

  const overall = fail_count > 0 ? 'fail'
    : warn_count > 0 ? 'warn'
    : 'pass';

  return {
    overall,
    started_at: started,
    finished_at: new Date().toISOString(),
    summary: { pass: pass_count, warn: warn_count, fail: fail_count, total: checks.length },
    checks,
    dialplan_chain: dialplanChain.chain,
    dialplan_target_dir: dialplanTargetDir,
    conflicts: conflictCheck.conflicts,
    paths: fsPathService.getSummary(),
  };
}

// ── Quick ESL ping ────────────────────────────────────────────────────────────

export async function pingEsl() {
  const st = eslStatus();
  if (!st.connected) return { ok: false, error: 'Not connected', ...st };
  try {
    const res = await eslCommand('status');
    return { ok: true, response: (res || '').split('\n')[0], ...st };
  } catch (e) {
    return { ok: false, error: e.message, ...st };
  }
}

// ── Reload XML ────────────────────────────────────────────────────────────────

export async function reloadXml() {
  if (!eslStatus().connected) throw new Error('ESL not connected');
  const res = await eslCommand('reloadxml');
  if (res && res.toLowerCase().includes('fail')) throw new Error('reloadxml failed: ' + res);
  return res || 'OK';
}
