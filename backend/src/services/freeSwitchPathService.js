/**
 * FreeSwitchPathService
 *
 * Single source of truth for every FreeSWITCH filesystem path.
 * All deployment, audio, and diagnostic code imports from here.
 * Never access process.env.FS_* directly — use this service.
 */

import path from 'path';
import { fsConfig } from '../config/fsConfig.js';

class FreeSwitchPathService {
  #cfg;

  constructor(cfg = fsConfig) {
    this.#cfg = cfg;
  }

  // ── Standard FS directories ────────────────────────────────────────────────

  getConfigDir()    { return this.#cfg.confDir;      }
  getDialplanDir()  { return this.#cfg.dialplanDir;  }
  getScriptDir()    { return this.#cfg.scriptDir;    }
  getSoundDir()     { return this.#cfg.soundDir;     }
  getRecordingDir() { return this.#cfg.recordingDir; }
  getStorageDir()   { return this.#cfg.storageDir;   }
  getDbDir()        { return this.#cfg.dbDir;        }
  getLogDir()       { return this.#cfg.logDir;       }

  // ── ENRS-specific paths ────────────────────────────────────────────────────

  /** Sounds deployed by ENRS Audio Library live here */
  getEnrsSoundDir() {
    return path.posix.join(this.#cfg.soundDir, 'enrs');
  }

  /** IVR recordings per-call */
  getIvrRecordingDir() {
    return path.posix.join(this.#cfg.recordingDir, 'ivr');
  }

  /** ENS blast recordings */
  getEnsRecordingDir() {
    return path.posix.join(this.#cfg.recordingDir, 'ens');
  }

  /** ERS conference recordings */
  getErsRecordingDir() {
    return path.posix.join(this.#cfg.recordingDir, 'ers');
  }

  // ── Specific file paths ────────────────────────────────────────────────────

  /** The single generated dialplan file that covers all IVR-bound numbers */
  getIvrDialplanFile() {
    return path.posix.join(this.getDialplanDir(), 'enrs_ivr.xml');
  }

  /** The generic Lua executor — one file drives all flows */
  getExecutorLuaFile() {
    return path.posix.join(this.getScriptDir(), 'ivr_executor.lua');
  }

  // ── Media URI resolution ───────────────────────────────────────────────────

  /**
   * Resolve a /media/ URI to an absolute filesystem path.
   * /media/welcome.wav  →  ${FS_SOUND_DIR}/enrs/welcome.wav
   *
   * Returns null if uri does not start with /media/.
   */
  resolveMediaPath(mediaUri) {
    if (typeof mediaUri !== 'string' || !mediaUri.startsWith('/media/')) return null;
    const filename = mediaUri.slice(7); // strip "/media/"
    return path.posix.join(this.getEnrsSoundDir(), filename);
  }

  /**
   * Convert an absolute FS sound path back to a /media/ URI.
   * ${FS_SOUND_DIR}/enrs/welcome.wav  →  /media/welcome.wav
   */
  toMediaUri(fsPath) {
    const prefix = this.getEnrsSoundDir() + '/';
    if (fsPath.startsWith(prefix)) return '/media/' + fsPath.slice(prefix.length);
    return null;
  }

  // ── Summary ────────────────────────────────────────────────────────────────

  getSummary() {
    return {
      configDir:      this.getConfigDir(),
      dialplanDir:    this.getDialplanDir(),
      scriptDir:      this.getScriptDir(),
      soundDir:       this.getSoundDir(),
      enrsSoundDir:   this.getEnrsSoundDir(),
      recordingDir:   this.getRecordingDir(),
      ivrRecordingDir:this.getIvrRecordingDir(),
      ensRecordingDir:this.getEnsRecordingDir(),
      ersRecordingDir:this.getErsRecordingDir(),
      storageDir:     this.getStorageDir(),
      dbDir:          this.getDbDir(),
      logDir:         this.getLogDir(),
    };
  }
}

/** Singleton — import this in all deployment/audio/diagnostics code */
export const fsPathService = new FreeSwitchPathService();
export default FreeSwitchPathService;
