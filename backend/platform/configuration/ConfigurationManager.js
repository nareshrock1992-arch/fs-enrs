import { promises as fs } from 'fs';
import { deploymentManager } from './deploy/DeploymentManager.js';
import { versionManager } from './history/VersionManager.js';
import { auditLogger } from './audit/AuditLogger.js';
import { backupManager } from './deploy/BackupManager.js';
import { query } from '../../src/db/pool.js';

/**
 * ConfigurationManager — top-level orchestrator for all configuration operations.
 *
 * Application code (route handlers) only ever calls this class.
 * It delegates to the correct provider via the registry, then to the
 * DeploymentManager for all I/O.
 *
 * Constructed once at startup and exported as a singleton.
 */
export class ConfigurationManager {

  #registry;

  constructor(registry) {
    this.#registry = registry;
  }

  // ── Provider discovery ────────────────────────────────────────────────────────

  /** List all registered providers (metadata only). */
  listProviders() {
    return this.#registry.list();
  }

  /** Get a provider by ID; throws 404 if not found. */
  getProvider(id) {
    return this.#registry.get(id);
  }

  // ── Read ──────────────────────────────────────────────────────────────────────

  /**
   * Read and parse the current config file. Always reads from disk.
   *
   * @param {string} providerId
   * @param {object} context — { userId, tenantId }
   * @returns {Promise<object>} { providerId, filePath, entries, checksum, parsedAt }
   */
  async read(providerId, context = {}) {
    const provider = this.#registry.get(providerId);
    const filePath = provider.getFilePath();

    let rawContent;
    try {
      rawContent = await fs.readFile(filePath, 'utf8');
    } catch (err) {
      if (err.code === 'ENOENT') {
        throw Object.assign(
          new Error(`Config file not found: ${filePath}`),
          { statusCode: 404 }
        );
      }
      throw err;
    }

    const parsed = provider.parse(rawContent);

    await auditLogger.log({
      tenantId:   context.tenantId,
      userId:     context.userId,
      providerId,
      action:     'read',
      filePath,
      status:     'success',
    });

    return {
      providerId,
      filePath,
      entries:    parsed.entries  ?? [],
      checksum:   parsed.checksum ?? null,
      parsedAt:   new Date().toISOString(),
      // Pass raw catalog if available (the UI uses it for descriptions)
      catalog:    provider.catalog ?? {},
    };
  }

  // ── Preview ───────────────────────────────────────────────────────────────────

  /**
   * Preview the effect of changes without writing anything.
   * Augments DeploymentManager result with provider deploymentMeta.
   * @param {string} providerId
   * @param {Array}  changes
   * @param {object} context
   * @returns {Promise<object>}
   */
  async preview(providerId, changes, context = {}) {
    const provider = this.#registry.get(providerId);
    const result   = await deploymentManager.preview(provider, changes, context);
    return { ...result, deploymentMeta: provider.deploymentMeta };
  }

  // ── Deploy ────────────────────────────────────────────────────────────────────

  /**
   * Full deploy pipeline.
   * @param {string} providerId
   * @param {Array}  changes
   * @param {object} context — { userId, tenantId, reason? }
   * @returns {Promise<DeploymentResult>}
   */
  async deploy(providerId, changes, context = {}) {
    const provider = this.#registry.get(providerId);
    return deploymentManager.deploy(provider, changes, context);
  }

  // ── Rollback ──────────────────────────────────────────────────────────────────

  /**
   * Restore a specific version by its config_versions.id.
   * @param {string} providerId
   * @param {number} versionId
   * @param {object} context
   * @returns {Promise<DeploymentResult>}
   */
  async rollback(providerId, versionId, context = {}) {
    const provider = this.#registry.get(providerId);
    return deploymentManager.rollback(provider, versionId, context);
  }

  // ── History ───────────────────────────────────────────────────────────────────

  /**
   * @param {string} providerId
   * @param {object} opts — { limit, offset, tenantId }
   * @returns {Promise<Array>}
   */
  async getHistory(providerId, opts = {}) {
    this.#registry.get(providerId); // validate provider exists
    return versionManager.getHistory(providerId, opts);
  }

  /**
   * @param {number} versionId1
   * @param {number} versionId2
   * @param {number|null} tenantId — required to prevent cross-tenant version access
   * @returns {Promise<object>}
   */
  async diffVersions(versionId1, versionId2, tenantId) {
    const [v1, v2] = await Promise.all([
      versionManager.getVersion(versionId1, tenantId),
      versionManager.getVersion(versionId2, tenantId),
    ]);
    if (!v1) throw Object.assign(new Error(`Version ${versionId1} not found`), { statusCode: 404 });
    if (!v2) throw Object.assign(new Error(`Version ${versionId2} not found`), { statusCode: 404 });
    if (v1.provider_id !== v2.provider_id) {
      throw Object.assign(new Error('Cannot diff versions from different providers'), { statusCode: 400 });
    }
    const provider = this.#registry.get(v1.provider_id);
    return {
      v1:    { id: v1.id, versionNum: v1.version_num, deployedAt: v1.deployed_at },
      v2:    { id: v2.id, versionNum: v2.version_num, deployedAt: v2.deployed_at },
      diff:  provider.diff(v1.xml_content, v2.xml_content),
    };
  }

  // ── Audit ─────────────────────────────────────────────────────────────────────

  async getAuditLog(providerId, opts = {}) {
    if (providerId) this.#registry.get(providerId); // validate
    return providerId
      ? auditLogger.getProviderLog(providerId, opts)
      : auditLogger.getGlobalLog(opts);
  }

  // ── Summary (dashboard) ───────────────────────────────────────────────────────

  /**
   * Aggregate status summary for all registered providers.
   * Used by the ConfigDashboard landing page.
   *
   * @param {number|null} tenantId
   * @returns {Promise<object>}
   */
  async getSummary(tenantId) {
    const providers = this.#registry.list();

    const providerSummaries = await Promise.all(
      providers.map(async (p) => {
        const provider = this.#registry.get(p.id);

        const [activeVersion, latestBackup] = await Promise.allSettled([
          versionManager.getActiveVersion(p.id, tenantId),
          backupManager.getLatestBackup(p.id),
        ]);

        return {
          id:             p.id,
          name:           p.name,
          description:    p.description,
          deploymentMeta: provider.deploymentMeta,
          activeVersion:  activeVersion.status === 'fulfilled' ? activeVersion.value : null,
          latestBackup:   latestBackup.status  === 'fulfilled' ? latestBackup.value  : null,
        };
      })
    );

    // DB schema version — latest applied migration.
    let dbSchemaVersion = null;
    try {
      const { rows } = await query('SELECT MAX(version) AS v FROM schema_migrations');
      dbSchemaVersion = rows[0]?.v ?? null;
    } catch {
      /* non-fatal */
    }

    // Platform version from package.json (read once at startup is fine).
    let platformVersion = null;
    try {
      const { createRequire } = await import('module');
      const req = createRequire(import.meta.url);
      platformVersion = req('../../../package.json').version;
    } catch {
      /* non-fatal */
    }

    const buildEnvironment = process.env.NODE_ENV ?? 'development';

    return {
      providers:      providerSummaries,
      platformInfo: {
        platformVersion,
        dbSchemaVersion,
        buildEnvironment,
      },
    };
  }

  /**
   * Read and validate every registered provider's current config file.
   * Returns per-provider validation results without writing anything.
   *
   * @param {number|null} tenantId
   * @returns {Promise<object>}
   */
  async getValidationSummary(tenantId) {
    const providers = this.#registry.list();

    const results = await Promise.all(
      providers.map(async (p) => {
        const provider = this.#registry.get(p.id);
        try {
          const filePath   = provider.getFilePath();
          const rawContent = await fs.readFile(filePath, 'utf8');
          const parsed     = provider.parse(rawContent);
          const validation = provider.validate(parsed);
          return {
            id:   p.id,
            name: p.name,
            ...validation,
            filePath,
          };
        } catch (err) {
          return {
            id:     p.id,
            name:   p.name,
            valid:  false,
            errors: [`Could not validate: ${err.message}`],
            warnings: [],
          };
        }
      })
    );

    const totalErrors   = results.reduce((n, r) => n + r.errors.length,   0);
    const totalWarnings = results.reduce((n, r) => n + r.warnings.length, 0);

    return {
      providers:     results,
      totalErrors,
      totalWarnings,
      allValid:      totalErrors === 0,
    };
  }
}
