/**
 * FreeSwitchPathService
 *
 * Single source of truth for every FreeSWITCH filesystem path.
 * All deployment, audio, and diagnostic code imports from here.
 * Never access process.env.FS_* directly — use this service.
 */

import path from 'path';
import { promises as fs } from 'fs';
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

  // ── Dialplan target auto-detection ─────────────────────────────────────────

  /**
   * Determine the directory FreeSWITCH actually merges into the live
   * "default" routing context — NOT necessarily FS_DIALPLAN_DIR itself.
   *
   * Some installs load extensions straight from dialplan/*.xml (flat).
   * Others assemble the "default" context from a nested include, e.g.
   * dialplan/default.xml containing:
   *   <context name="default">
   *     <X-PRE-PROCESS cmd="include" data="default/*.xml"/>
   *   </context>
   * A file written to the parent dialplan/ directory in that case declares
   * a sibling <context name="default"> node that is never merged into the
   * one FreeSWITCH actually routes calls through — reloadxml reports
   * success regardless, so this failure is otherwise invisible.
   *
   * Re-run on every deploy (not cached at boot) — the file is small and
   * the FreeSWITCH config on a box can change between deploys.
   */
  /**
   * @returns {Promise<{dir: string, nested: boolean}>}
   *   dir    — the resolved directory FreeSWITCH actually loads from
   *   nested — true when `dir` sits INSIDE an already-open <context name="default">
   *            (via default.xml's own nested X-PRE-PROCESS include), meaning any
   *            file written there must NOT declare its own <context> wrapper —
   *            a second nested <context> tag at that splice point is invalid XML
   *            and FreeSWITCH silently drops the whole fragment with no error.
   *            false — flat layout: dialplan/*.xml siblings, each file DOES need
   *            its own <context name="default"> wrapper.
   */
  async detectDialplanTargetDir() {
    const dialplanDir  = this.getDialplanDir();
    const defaultXmlPath = path.posix.join(dialplanDir, 'default.xml');

    let content;
    try {
      content = await fs.readFile(defaultXmlPath, 'utf8');
    } catch {
      console.log(`[deploy] Detected dialplan target: ${dialplanDir} (default.xml not readable at ${defaultXmlPath} — using root, wrapped)`);
      return { dir: dialplanDir, nested: false };
    }

    const contextMatch = content.match(/<context\s+name="default"\s*>([\s\S]*?)<\/context>/i);
    if (!contextMatch) {
      console.log(`[deploy] Detected dialplan target: ${dialplanDir} (no <context name="default"> block in default.xml — using root, wrapped)`);
      return { dir: dialplanDir, nested: false };
    }

    const includeMatch = contextMatch[1].match(/<X-PRE-PROCESS\s+cmd="include"\s+data="([^"]+)"\s*\/>/i);
    if (!includeMatch) {
      console.log(`[deploy] Detected dialplan target: ${dialplanDir} (no nested include found in default.xml, using root, wrapped)`);
      return { dir: dialplanDir, nested: false };
    }

    const includePattern = includeMatch[1]; // e.g. "default/*.xml"
    const targetDir = includePattern.startsWith('/')
      ? path.posix.dirname(includePattern)
      : path.posix.join(dialplanDir, path.posix.dirname(includePattern));

    console.log(`[deploy] Detected dialplan target: ${targetDir} (nested include "${includePattern}" in default.xml, bare — no <context> wrapper)`);
    return { dir: targetDir, nested: true };
  }

  // ── Specific file paths ────────────────────────────────────────────────────

  /** The single generated dialplan file that covers all IVR-bound numbers */
  async getIvrDialplanFile() {
    const { dir } = await this.detectDialplanTargetDir();
    return path.posix.join(dir, 'enrs_ivr.xml');
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
