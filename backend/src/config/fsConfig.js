/**
 * FreeSWITCH filesystem path configuration.
 *
 * Priority:
 *   1. Environment variables (FS_SCRIPT_DIR, FS_RECORDING_DIR, etc.)
 *   2. Defaults based on most common FreeSWITCH package installations
 *
 * Auto-detection via fs_cli is performed lazily when autoDetect() is called.
 * In production, prefer setting all FS_* env vars explicitly so the process
 * does not depend on fs_cli being in PATH.
 *
 * Usage:
 *   import { fsConfig } from '../config/fsConfig.js';
 *   const scriptDir = fsConfig.scriptDir;
 */

import { execSync } from 'child_process';

function fsCli(cmd) {
  try {
    return execSync(`fs_cli -x "${cmd}"`, { timeout: 3000, stdio: ['pipe', 'pipe', 'pipe'] })
      .toString()
      .trim();
  } catch {
    return null;
  }
}

function env(key, fallback) {
  return process.env[key] || fallback;
}

// Build the config object from env vars with sensible defaults.
// All paths can be overridden per-variable or via FS_BASE_DIR.
function buildConfig() {
  const base       = env('FS_BASE_DIR', '/usr/share/freeswitch');
  // Accept both spellings: FS_RECORDINGS_DIR (with S, common in older ENRS docs)
  // and FS_RECORDING_DIR (without S). FS_RECORDINGS_DIR takes priority.
  const recordingDir = env('FS_RECORDINGS_DIR', env('FS_RECORDING_DIR', env('ENRS_REC_DIR', '/var/lib/freeswitch/recordings')));

  return {
    baseDir:      base,
    confDir:      env('FS_CONF_DIR',      '/etc/freeswitch'),
    dialplanDir:  env('FS_DIALPLAN_DIR',  '/etc/freeswitch/dialplan'),
    directoryDir: env('FS_DIRECTORY_DIR', '/etc/freeswitch/directory'),
    sipProfileDir:env('FS_SIP_PROFILE_DIR', '/etc/freeswitch/sip_profiles'),
    scriptDir:    env('FS_SCRIPT_DIR',    `${base}/scripts`),
    soundDir:     env('FS_SOUND_DIR',     `${base}/sounds`),
    recordingDir,
    storageDir:   env('FS_STORAGE_DIR',   '/var/lib/freeswitch/storage'),
    dbDir:        env('FS_DB_DIR',        '/var/lib/freeswitch/db'),
    logDir:       env('FS_LOG_DIR',       '/var/log/freeswitch'),

    // Application-specific sub-paths — all derived from the single resolved recordingDir
    ensRecordingDir:  `${recordingDir}/ens`,
    ersRecordingDir:  `${recordingDir}/ers`,
    ivrRecordingDir:  `${recordingDir}/ivr`,
    confRecordingDir: `${recordingDir}/conf`,
  };
}

// Attempt to auto-detect paths from a running FreeSWITCH instance.
// Returns an object with any values that were successfully detected.
export async function autoDetect() {
  const detected = {};

  const varMap = {
    scriptDir:    'script_dir',
    confDir:      'conf_dir',
    soundDir:     'sounds_dir',
    recordingDir: 'recordings_dir',
    storageDir:   'storage_dir',
    dbDir:        'db_dir',
    logDir:       'log_dir',
  };

  for (const [key, globalVar] of Object.entries(varMap)) {
    const val = fsCli(`global_getvar ${globalVar}`);
    if (val && val !== '' && !val.includes('FAIL')) {
      detected[key] = val;
    }
  }

  return detected;
}

export const fsConfig = buildConfig();
