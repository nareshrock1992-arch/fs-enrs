/**
 * ConfigurationProvider — Abstract base class for all config file handlers.
 *
 * Each FreeSWITCH configuration file type (vars.xml, acl.conf.xml, etc.)
 * is managed by one concrete provider that extends this class.
 *
 * Contract:
 *  - parse() and serialize() are PURE — no I/O, no side effects.
 *  - All filesystem I/O belongs to DeploymentManager, never to providers.
 *  - getFilePath() resolves via the injected driver (no hardcoded paths).
 *  - validate() must be called before serialize() in the deploy pipeline.
 */
export class ConfigurationProvider {

  #driver;

  constructor(driver) {
    if (!driver) {
      throw new Error(
        `${this.constructor.name}: driver is required. ` +
        'Pass the active PlatformDriver when constructing the provider.'
      );
    }
    this.#driver = driver;
  }

  // ── Identity (must override) ──────────────────────────────────────────────────

  /** Machine-readable provider ID — matches the URL segment. */
  get id() { return this._abstract('id'); }

  /** Human-readable name shown in the UI. */
  get name() { return this._abstract('name'); }

  /** One-line description of what this provider manages. */
  get description() { return this._abstract('description'); }

  /** The DeploymentStrategy object from DeploymentStrategy.js. */
  get deploymentStrategy() { return this._abstract('deploymentStrategy'); }

  /**
   * Resolve the absolute filesystem path of the config file.
   * Must use this.driver.resolveConfigPath() — never access process.env directly.
   */
  getFilePath() { return this._abstract('getFilePath'); }

  // ── Parse / serialize (must override) ────────────────────────────────────────

  /**
   * Parse raw file content into an internal document representation.
   * @param {string} rawContent — raw UTF-8 file bytes
   * @returns {object}          — provider-specific internal document
   */
  parse(rawContent) { return this._abstract('parse'); }

  /**
   * Serialise an internal document back to raw file content.
   * @param {object} doc        — internal document from parse()
   * @returns {string}          — raw UTF-8 file content
   */
  serialize(doc) { return this._abstract('serialize'); }

  /**
   * Apply a list of changes to an internal document, returning a new document.
   * Must not mutate the input document.
   * @param {object} doc
   * @param {Array}  changes
   * @returns {object} new document
   */
  applyChanges(doc, changes) { return this._abstract('applyChanges'); }

  // ── Validation ────────────────────────────────────────────────────────────────

  /**
   * Validate an internal document.
   * Default implementation: always valid. Override for business-rule checks.
   * @param {object} doc
   * @returns {{ valid: boolean, errors: string[], warnings: string[] }}
   */
  validate(_doc) {
    return { valid: true, errors: [], warnings: [] };
  }

  // ── Diff ──────────────────────────────────────────────────────────────────────

  /**
   * Generate a human-readable diff between old and new raw content.
   * Default: override in each provider for better domain-specific diffs.
   * @param {string} oldRaw
   * @param {string} newRaw
   * @returns {string}
   */
  diff(oldRaw, newRaw) {
    if (oldRaw === newRaw) return '(no changes)';
    const oldLines = oldRaw.split('\n');
    const newLines = newRaw.split('\n');
    const removed  = oldLines.filter(l => !newLines.includes(l));
    const added    = newLines.filter(l => !oldLines.includes(l));
    const lines    = [
      ...removed.map(l => `- ${l}`),
      ...added.map(l => `+ ${l}`),
    ];
    return lines.slice(0, 200).join('\n');
  }

  // ── Optional hooks ────────────────────────────────────────────────────────────

  /** Called by DeploymentManager before writing the file. Override to add checks. */
  async beforeDeploy(_doc) {}

  /** Called by DeploymentManager after a successful deploy. Override for side effects. */
  async afterDeploy(_result) {}

  /**
   * Provider-specific post-deploy verification.
   * Default: delegates to the strategy's defaultVerify. Override to add
   * domain-specific checks (e.g. query the switch for the new value).
   */
  async verifyDeployment(_driver, _changes) {
    return { passed: true, checks: [] };
  }

  // ── Accessor ──────────────────────────────────────────────────────────────────

  get driver() { return this.#driver; }

  // ── Internal ──────────────────────────────────────────────────────────────────

  _abstract(name) {
    throw new Error(
      `${this.constructor.name}.${name}() is not implemented. ` +
      'Extend ConfigurationProvider and override all abstract members.'
    );
  }
}
