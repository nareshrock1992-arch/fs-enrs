/**
 * PlatformDriver — Abstract base class for all telephony platform adapters.
 *
 * Providers and the DeploymentManager communicate with the underlying switch
 * exclusively through this interface. A concrete driver (FreeSwitchDriver,
 * future AsteriskDriver, etc.) implements every method below.
 *
 * This abstraction means:
 *  - Providers contain zero platform-specific code.
 *  - Adding a new switch platform requires only one new file.
 */
export class PlatformDriver {
  // ── Identity ─────────────────────────────────────────────────────────────────

  /** Machine-readable driver name: 'freeswitch', 'asterisk', etc. */
  get driverName() { return this._abstract('driverName'); }

  /** Semver string of the driver implementation */
  get driverVersion() { return this._abstract('driverVersion'); }

  /**
   * List of DeploymentStrategy IDs this driver supports.
   * e.g. ['reload_xml', 'sofia_rescan', 'reload_module', 'restart_module']
   */
  get capabilities() { return this._abstract('capabilities'); }

  // ── Connection ────────────────────────────────────────────────────────────────

  /** @returns {Promise<boolean>} */
  async isConnected() { return this._abstract('isConnected'); }

  /** @returns {Promise<{host:string, port:number, connected:boolean, uptime?:number}>} */
  async getConnectionInfo() { return this._abstract('getConnectionInfo'); }

  // ── Path resolution ───────────────────────────────────────────────────────────
  // These return host-OS paths (POSIX strings on Linux servers).

  /** Resolve a config-relative path to an absolute filesystem path. */
  resolveConfigPath(relativePath) { return this._abstract('resolveConfigPath'); }

  /** Resolve a script-relative path to an absolute filesystem path. */
  resolveScriptPath(filename) { return this._abstract('resolveScriptPath'); }

  /** Resolve a sound-relative path to an absolute filesystem path. */
  resolveSoundPath(filename) { return this._abstract('resolveSoundPath'); }

  // ── Reload operations ─────────────────────────────────────────────────────────

  /** Reload all XML configuration files.
   *  @returns {Promise<{success:boolean, output:string}>}
   */
  async reloadXml() { return this._abstract('reloadXml'); }

  /** Reload a specific module by name (e.g. 'mod_event_socket').
   *  @returns {Promise<{success:boolean, output:string}>}
   */
  async reloadModule(moduleName) { return this._abstract('reloadModule'); }

  /** Unload a module without reloading it (first half of RESTART_MODULE).
   *  @returns {Promise<{success:boolean, output:string}>}
   */
  async unloadModule(moduleName) { return this._abstract('unloadModule'); }

  /** Load a previously unloaded module (second half of RESTART_MODULE).
   *  @returns {Promise<{success:boolean, output:string}>}
   */
  async loadModule(moduleName) { return this._abstract('loadModule'); }

  /** Reload all gateways registered under a SIP profile.
   *  @returns {Promise<{success:boolean, output:string}>}
   */
  async reloadSofiaProfile(profileName) { return this._abstract('reloadSofiaProfile'); }

  /** Rescan gateways under a SIP profile without a full reload.
   *  @returns {Promise<{success:boolean, output:string}>}
   */
  async rescanSofiaGateway(profileName) { return this._abstract('rescanSofiaGateway'); }

  // ── Verification ──────────────────────────────────────────────────────────────

  /** Read a runtime global variable (post-reload spot-check).
   *  @returns {Promise<string|null>}
   */
  async getGlobalVar(varName) { return this._abstract('getGlobalVar'); }

  /** Read full sofia status.
   *  @returns {Promise<object>}
   */
  async getSofiaStatus() { return this._abstract('getSofiaStatus'); }

  /** Check whether a module is loaded and running.
   *  @returns {Promise<{loaded:boolean, status:string}>}
   */
  async getModuleStatus(moduleName) { return this._abstract('getModuleStatus'); }

  /** Verify that a named dialplan extension is reachable.
   *  @returns {Promise<{loaded:boolean}>}
   */
  async verifyExtension(extensionName) { return this._abstract('verifyExtension'); }

  // ── Internal ──────────────────────────────────────────────────────────────────

  _abstract(name) {
    throw new Error(
      `PlatformDriver: ${this.constructor.name}.${name}() is not implemented. ` +
      `Extend PlatformDriver and implement all abstract methods.`
    );
  }
}
