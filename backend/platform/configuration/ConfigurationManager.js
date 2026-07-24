import { promises as fs } from 'fs';
import { deploymentManager } from './deploy/DeploymentManager.js';
import { versionManager } from './history/VersionManager.js';
import { auditLogger } from './audit/AuditLogger.js';

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
   * @param {string} providerId
   * @param {Array}  changes
   * @param {object} context
   * @returns {Promise<object>}
   */
  async preview(providerId, changes, context = {}) {
    const provider = this.#registry.get(providerId);
    return deploymentManager.preview(provider, changes, context);
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
}
