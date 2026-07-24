import { promises as fs } from 'fs';
import path from 'path';

/**
 * PlatformHealthChecker — gathers platform health without throwing.
 *
 * Always returns a structured result. Individual check failures are surfaced
 * as check-level errors, not as HTTP errors. Callers must never assume this
 * throws; they should read the returned object.
 *
 * Injected dependencies keep this platform-agnostic:
 *  - driver: PlatformDriver — used for ESL connectivity and FS version
 *  - pathService: FreeSwitchPathService — resolves FS directory paths
 */
export class PlatformHealthChecker {

  #driver;
  #pathService;

  constructor(driver, pathService) {
    this.#driver      = driver;
    this.#pathService = pathService;
  }

  /**
   * Run all health checks and return a structured summary.
   *
   * @returns {Promise<{
   *   status: 'healthy'|'degraded'|'unhealthy',
   *   checkedAt: string,
   *   checks: Array<{ name, status, detail?, error? }>,
   *   eslConnected: boolean,
   * }>}
   */
  async check() {
    const checks = await Promise.all([
      this.#checkEsl(),
      this.#checkConfigDir(),
      this.#checkVarsXml(),
      this.#checkScriptDir(),
      this.#checkRecordingDir(),
      this.#checkBackupDir(),
    ]);

    const failed  = checks.filter(c => c.status === 'fail');
    const warned  = checks.filter(c => c.status === 'warn');
    const eslOk   = checks.find(c => c.name === 'esl_connection')?.status === 'ok';

    const status =
      failed.length > 0 ? 'unhealthy' :
      warned.length > 0 ? 'degraded'  :
      'healthy';

    return {
      status,
      checkedAt:    new Date().toISOString(),
      checks,
      eslConnected: eslOk,
    };
  }

  // ── Individual checks ─────────────────────────────────────────────────────────

  async #checkEsl() {
    try {
      const connected = await this.#driver.isConnected();
      return connected
        ? { name: 'esl_connection', status: 'ok',   detail: 'ESL connected' }
        : { name: 'esl_connection', status: 'fail',  detail: 'ESL not connected' };
    } catch (err) {
      return { name: 'esl_connection', status: 'fail', error: err.message };
    }
  }

  async #checkConfigDir() {
    return this.#checkDirReadable(
      'config_dir',
      this.#pathService.getConfigDir()
    );
  }

  async #checkVarsXml() {
    const filePath = path.posix.join(this.#pathService.getConfigDir(), 'vars.xml');
    try {
      await fs.access(filePath, fs.constants.R_OK | fs.constants.W_OK);
      return { name: 'vars_xml', status: 'ok', detail: filePath };
    } catch {
      return { name: 'vars_xml', status: 'fail', detail: `Not accessible: ${filePath}` };
    }
  }

  async #checkScriptDir() {
    return this.#checkDirReadable(
      'script_dir',
      this.#pathService.getScriptDir()
    );
  }

  async #checkRecordingDir() {
    return this.#checkDirWritable(
      'recording_dir',
      this.#pathService.getRecordingDir()
    );
  }

  async #checkBackupDir() {
    const baseDir = process.env.PLATFORM_DATA_DIR
      ? path.join(process.env.PLATFORM_DATA_DIR, 'config-backups')
      : path.join(process.cwd(), 'data', 'config-backups');
    try {
      await fs.mkdir(baseDir, { recursive: true });
      await fs.access(baseDir, fs.constants.W_OK);
      return { name: 'backup_dir', status: 'ok', detail: baseDir };
    } catch (err) {
      return { name: 'backup_dir', status: 'warn', detail: `Backup dir not writable: ${baseDir}`, error: err.message };
    }
  }

  async #checkDirReadable(name, dirPath) {
    try {
      await fs.access(dirPath, fs.constants.R_OK);
      return { name, status: 'ok', detail: dirPath };
    } catch {
      return { name, status: 'fail', detail: `Not readable: ${dirPath}` };
    }
  }

  async #checkDirWritable(name, dirPath) {
    try {
      await fs.access(dirPath, fs.constants.W_OK);
      return { name, status: 'ok', detail: dirPath };
    } catch {
      return { name, status: 'warn', detail: `Not writable: ${dirPath}` };
    }
  }
}
