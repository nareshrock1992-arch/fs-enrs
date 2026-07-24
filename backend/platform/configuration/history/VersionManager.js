import { query, withTransaction } from '../../../src/db/pool.js';

/**
 * VersionManager — CRUD for config_versions.
 *
 * One row per deploy. Only one row per provider is marked is_active = true
 * at any time (the most recently deployed version).
 */
export class VersionManager {

  /**
   * Create a new version snapshot and mark it as the active version.
   * Any previously active version for this provider is deactivated inside
   * the same transaction.
   *
   * @param {object} opts
   * @returns {Promise<number>} id of the created row
   */
  async createVersion(opts) {
    const {
      tenantId,
      providerId,
      filePath,
      xmlContent,
      checksum,
      deployedBy,
      reason,
      backupPath,
      diffSummary,
      changedKeys,
      deployMeta,
    } = opts;

    return withTransaction(async (tq) => {
      // Deactivate the current active version for this tenant+provider.
      await tq(
        `UPDATE config_versions
         SET is_active = false
         WHERE provider_id = $1
           AND tenant_id IS NOT DISTINCT FROM $2
           AND is_active = true`,
        [providerId, tenantId ?? null]
      );

      // Compute next version number scoped to this tenant+provider so each
      // tenant has its own independent sequence starting at 1.
      const { rows: [{ max_ver }] } = await tq(
        `SELECT COALESCE(MAX(version_num), 0) AS max_ver
         FROM config_versions
         WHERE provider_id = $1
           AND tenant_id IS NOT DISTINCT FROM $2`,
        [providerId, tenantId ?? null]
      );

      const versionNum = Number(max_ver) + 1;

      const { rows: [{ id }] } = await tq(
        `INSERT INTO config_versions
           (tenant_id, provider_id, file_path, version_num, xml_content,
            checksum, deployed_by, reason, is_active, backup_path,
            diff_summary, changed_keys, deploy_meta)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,true,$9,$10,$11,$12)
         RETURNING id`,
        [
          tenantId   ?? null,
          providerId,
          filePath,
          versionNum,
          xmlContent,
          checksum,
          deployedBy ?? null,
          reason     ?? null,
          backupPath ?? null,
          diffSummary ?? null,
          changedKeys ? JSON.stringify(changedKeys) : null,
          deployMeta  ? JSON.stringify(deployMeta)  : null,
        ]
      );

      return id;
    });
  }

  /**
   * Return paginated version history for a provider, newest first.
   * @param {string} providerId
   * @param {object} opts
   * @returns {Promise<Array>}
   */
  async getHistory(providerId, { limit = 20, offset = 0, tenantId } = {}) {
    const { rows } = await query(
      `SELECT cv.id, cv.provider_id, cv.file_path, cv.version_num,
              cv.checksum, cv.deployed_at, cv.reason, cv.is_active,
              cv.backup_path, cv.diff_summary, cv.changed_keys,
              u.full_name AS deployed_by_name, u.email AS deployed_by_email
       FROM config_versions cv
       LEFT JOIN users u ON u.id = cv.deployed_by
       WHERE cv.provider_id = $1
         AND cv.tenant_id IS NOT DISTINCT FROM $2
       ORDER BY cv.deployed_at DESC
       LIMIT $3 OFFSET $4`,
      [providerId, tenantId ?? null, limit, offset]
    );
    return rows;
  }

  /**
   * Return a single version including its xml_content (for rollback/diff).
   * tenantId is required to prevent cross-tenant version access.
   * @param {number} versionId
   * @param {number|null} tenantId
   * @returns {Promise<object|null>}
   */
  async getVersion(versionId, tenantId) {
    const { rows } = await query(
      `SELECT cv.*, u.full_name AS deployed_by_name, u.email AS deployed_by_email
       FROM config_versions cv
       LEFT JOIN users u ON u.id = cv.deployed_by
       WHERE cv.id = $1
         AND cv.tenant_id IS NOT DISTINCT FROM $2`,
      [versionId, tenantId ?? null]
    );
    return rows[0] ?? null;
  }

  /**
   * Return the currently active version for a provider.
   * @param {string} providerId
   * @param {number|null} tenantId
   * @returns {Promise<object|null>}
   */
  async getActiveVersion(providerId, tenantId) {
    const { rows } = await query(
      `SELECT * FROM config_versions
       WHERE provider_id = $1
         AND tenant_id IS NOT DISTINCT FROM $2
         AND is_active = true
       LIMIT 1`,
      [providerId, tenantId ?? null]
    );
    return rows[0] ?? null;
  }
}

export const versionManager = new VersionManager();
