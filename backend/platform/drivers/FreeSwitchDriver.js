import path from 'path';
import { PlatformDriver } from './PlatformDriver.js';

/**
 * FreeSwitchDriver — Concrete PlatformDriver for FreeSWITCH.
 *
 * Delegates all ESL communication to the existing eslService singleton and
 * all path resolution to the existing freeSwitchPathService singleton.
 * Neither service is modified. This driver is a thin coordination layer only.
 */
export class FreeSwitchDriver extends PlatformDriver {

  #eslService;
  #pathService;

  /**
   * @param {object} eslService   — the exported eslService module
   * @param {object} pathService  — the FreeSwitchPathService singleton
   */
  constructor(eslService, pathService) {
    super();
    this.#eslService  = eslService;
    this.#pathService = pathService;
  }

  // ── Identity ─────────────────────────────────────────────────────────────────

  get driverName()    { return 'freeswitch'; }
  get driverVersion() { return '1.0.0'; }
  get capabilities()  {
    return ['reload_xml', 'sofia_rescan', 'reload_module', 'restart_module'];
  }

  // ── Connection ────────────────────────────────────────────────────────────────

  async isConnected() {
    return this.#eslService.eslStatus().connected;
  }

  async getConnectionInfo() {
    const s = this.#eslService.eslStatus();
    return {
      host:      s.host,
      port:      s.port,
      connected: s.connected,
    };
  }

  // ── Path resolution ───────────────────────────────────────────────────────────

  resolveConfigPath(relativePath) {
    return path.posix.join(this.#pathService.getConfigDir(), relativePath);
  }

  resolveScriptPath(filename) {
    return path.posix.join(this.#pathService.getScriptDir(), filename);
  }

  resolveSoundPath(filename) {
    return path.posix.join(this.#pathService.getSoundDir(), filename);
  }

  /**
   * Resolve a path relative to the SIP profiles directory.
   * With no argument returns the sip profiles directory itself.
   * Delegates to FreeSwitchPathService.getSipProfileDir() — never reads
   * process.env directly.
   *
   * @param {string} [relativePath]  — optional sub-path (e.g. 'external/avaya.xml')
   * @returns {string}
   */
  resolveSipProfilePath(relativePath) {
    const sipDir = this.#pathService.getSipProfileDir();
    if (!relativePath) return sipDir;
    return path.posix.join(sipDir, relativePath);
  }

  /**
   * Resolve a path for any named configuration directory.
   * Generic alternative to module-specific resolve methods.
   * Delegates to FreeSwitchPathService — never reads process.env directly.
   *
   * Supported types:
   *   'sipProfile' — sip_profiles/  (e.g. 'external/avaya.xml')
   *   'dialplan'   — dialplan/       (e.g. 'default.xml')
   *   'script'     — scripts/        (e.g. 'ens_blast_trigger.lua')
   *   'sound'      — sounds/
   *   'recording'  — recordings/
   *
   * With no relativePath returns the directory itself.
   * New configuration types should be added here rather than as new methods.
   *
   * @param {string} type           — one of the supported type strings above
   * @param {string} [relativePath] — optional sub-path within the directory
   * @returns {string}
   */
  resolveConfigurationPath(type, relativePath) {
    const dirs = {
      sipProfile: () => this.#pathService.getSipProfileDir(),
      dialplan:   () => this.#pathService.getDialplanDir(),
      script:     () => this.#pathService.getScriptDir(),
      sound:      () => this.#pathService.getSoundDir(),
      recording:  () => this.#pathService.getRecordingDir(),
    };
    const getDir = dirs[type];
    if (!getDir) {
      throw new Error(
        `FreeSwitchDriver.resolveConfigurationPath: unknown type '${type}'. ` +
        `Supported: ${Object.keys(dirs).join(', ')}`
      );
    }
    const dir = getDir();
    if (!relativePath) return dir;
    return path.posix.join(dir, relativePath);
  }

  // ── Reload operations ─────────────────────────────────────────────────────────

  async reloadXml() {
    // reloadxml on a large config tree can take 10–20 s. The default eslCommand
    // timeout (10 s) is too low; use 20 s to avoid false timeout failures.
    const output = await this.#eslService.eslCommand('reloadxml', 20_000);
    const success = typeof output === 'string'
      && (output.includes('+OK') || output.includes('Reloading XML'));
    return { success, output: String(output) };
  }

  async reloadModule(moduleName) {
    const output = await this.#eslService.eslCommand(`reload ${moduleName}`);
    const success = typeof output === 'string' && output.includes('+OK');
    return { success, output: String(output) };
  }

  async unloadModule(moduleName) {
    const output = await this.#eslService.eslCommand(`unload ${moduleName}`);
    const success = typeof output === 'string' && output.includes('+OK');
    return { success, output: String(output) };
  }

  async loadModule(moduleName) {
    const output = await this.#eslService.eslCommand(`load ${moduleName}`);
    const success = typeof output === 'string' && output.includes('+OK');
    return { success, output: String(output) };
  }

  async reloadSofiaProfile(profileName) {
    const output = await this.#eslService.eslCommand(
      `sofia profile ${profileName} rescan`
    );
    const success = typeof output === 'string'
      && (output.includes('+OK') || output.includes('Reloading'));
    return { success, output: String(output) };
  }

  async rescanSofiaGateway(profileName) {
    const output = await this.#eslService.eslCommand(
      `sofia profile ${profileName} rescan`
    );
    const success = typeof output === 'string'
      && (output.includes('+OK') || output.includes('Reloading'));
    return { success, output: String(output) };
  }

  // ── Verification ──────────────────────────────────────────────────────────────

  async getGlobalVar(varName) {
    try {
      const output = await this.#eslService.eslCommand(`global_getvar ${varName}`);
      return typeof output === 'string' ? output.trim() : null;
    } catch {
      return null;
    }
  }

  async getSofiaStatus() {
    try {
      const output = await this.#eslService.eslCommand('sofia status');
      return { raw: String(output) };
    } catch (err) {
      return { raw: '', error: err.message };
    }
  }

  async getModuleStatus(moduleName) {
    try {
      const output = await this.#eslService.eslCommand(`module_exists ${moduleName}`);
      const loaded = typeof output === 'string' && output.trim() === 'true';
      return { loaded, status: loaded ? 'running' : 'not_loaded' };
    } catch {
      return { loaded: false, status: 'unknown' };
    }
  }

  async verifyExtension(extensionName) {
    try {
      const output = await this.#eslService.eslCommand(
        `xml_locate dialplan context name default`
      );
      const loaded = typeof output === 'string' && output.includes(extensionName);
      return { loaded };
    } catch {
      return { loaded: false };
    }
  }

  async getFreeSwitchVersion() {
    try {
      const output = await this.#eslService.eslCommand('version');
      return typeof output === 'string' ? output.trim() : null;
    } catch {
      return null;
    }
  }
}
