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

  getConfigDir()      { return this.#cfg.confDir;      }
  getDialplanDir()    { return this.#cfg.dialplanDir;  }
  getScriptDir()      { return this.#cfg.scriptDir;    }
  getSoundDir()       { return this.#cfg.soundDir;     }
  getRecordingDir()   { return this.#cfg.recordingDir; }
  getStorageDir()     { return this.#cfg.storageDir;   }
  getDbDir()          { return this.#cfg.dbDir;        }
  getLogDir()         { return this.#cfg.logDir;       }
  getSipProfileDir()  { return this.#cfg.sipProfileDir; }

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
    const dialplanDir = this.getDialplanDir();

    // Extract the nested include's target dir from a default.xml, if that
    // file declares one inside its <context name="default"> block.
    // Returns the resolved directory or null. Regexes are deliberately
    // tolerant of attribute spacing and self-close style ("/>" vs " />").
    const nestedIncludeDirOf = async (defaultXmlPath, baseDir) => {
      let content;
      try {
        content = await fs.readFile(defaultXmlPath, 'utf8');
      } catch {
        return null;
      }
      const contextMatch = content.match(/<context\s+name\s*=\s*"default"[^>]*>([\s\S]*?)<\/context>/i);
      if (!contextMatch) return null;
      const includeMatch = contextMatch[1].match(/<X-PRE-PROCESS\s+cmd\s*=\s*"include"\s+data\s*=\s*"([^"]+)"\s*\/?\s*>/i);
      if (!includeMatch) return null;
      const pattern = includeMatch[1]; // e.g. "default/*.xml"
      return pattern.startsWith('/')
        ? path.posix.dirname(pattern)
        : path.posix.join(baseDir, path.posix.dirname(pattern));
    };

    // Case 1 — FS_DIALPLAN_DIR is the search root (documented setup):
    // its own default.xml declares the nested include.
    const ownTarget = await nestedIncludeDirOf(path.posix.join(dialplanDir, 'default.xml'), dialplanDir);
    if (ownTarget) {
      console.log(`[deploy] Detected dialplan target: ${ownTarget} (nested include in ${dialplanDir}/default.xml, bare — no <context> wrapper)`);
      return { dir: ownTarget, nested: true };
    }

    // Case 2 — FS_DIALPLAN_DIR was set to the nested TARGET directory
    // itself (e.g. .../dialplan/default instead of .../dialplan). Real
    // field failure: with no default.xml in that dir, the old code fell
    // back to "flat → wrap in <context>", writing a <context>-wrapped
    // file INTO a directory whose contents are spliced inside an
    // already-open <context name="default"> — a doubled context tag that
    // FreeSWITCH's parser silently drops with zero error. Check the
    // PARENT directory's default.xml: if its nested include resolves back
    // to this very directory, we're inside a nested layout and must emit
    // bare fragments.
    const parentDir = path.posix.dirname(dialplanDir.replace(/\\/g, '/'));
    const parentTarget = await nestedIncludeDirOf(path.posix.join(parentDir, 'default.xml'), parentDir);
    if (parentTarget && path.posix.normalize(parentTarget) === path.posix.normalize(dialplanDir.replace(/\\/g, '/'))) {
      console.log(`[deploy] Detected dialplan target: ${dialplanDir} (FS_DIALPLAN_DIR points at the nested include dir itself — parent ${parentDir}/default.xml includes it; bare, no <context> wrapper)`);
      return { dir: dialplanDir, nested: true };
    }

    // Case 3 — genuinely flat layout: extensions load from dialplan/*.xml
    // siblings, each file needs its own <context name="default"> wrapper.
    console.log(`[deploy] Detected dialplan target: ${dialplanDir} (no nested include found in own or parent default.xml — flat layout, wrapped)`);
    return { dir: dialplanDir, nested: false };
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
