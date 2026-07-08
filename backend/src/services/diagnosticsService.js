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
import { fsPathService } from './freeSwitchPathService.js';
import { eslCommand, eslStatus } from './eslService.js';

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
    'Dialplan Directory (XML)',
    fsPathService.getDialplanDir(),
    'Grant write to freeswitch user: chown freeswitch:freeswitch ' + fsPathService.getDialplanDir()
  ));

  // 3. ENRS sound dir
  checks.push(await checkAudioCount());

  // 4. Recording dirs
  checks.push(await checkDirExists('IVR Recording Directory', fsPathService.getIvrRecordingDir()));

  // 5. Deployed files
  checks.push(await checkFileExists(
    'Lua Executor (ivr_executor.lua)',
    fsPathService.getExecutorLuaFile()
  ));
  checks.push(await checkFileExists(
    'Dialplan XML (enrs_ivr.xml)',
    fsPathService.getIvrDialplanFile()
  ));

  // 6. Path comparison vs actual FS global vars
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
