import { query } from '../../../src/db/pool.js';

/**
 * AuditLogger — writes to config_audit_log.
 *
 * Always fires — even when a deploy fails — so there is a complete record
 * of every attempted operation. The status field distinguishes success from
 * failure; the error field carries the failure reason.
 */
export class AuditLogger {

  /**
   * @param {object} opts
   * @param {number|null}  opts.tenantId
   * @param {number|null}  opts.userId
   * @param {string}       opts.providerId
   * @param {string}       opts.action     — 'read'|'preview'|'deploy'|'rollback'
   * @param {string}       opts.filePath
   * @param {number|null}  [opts.versionId]
   * @param {object|null}  [opts.oldValue]
   * @param {object|null}  [opts.newValue]
   * @param {string}       opts.status     — 'success'|'failed'
   * @param {string|null}  [opts.error]
   * @param {number|null}  [opts.durationMs]
   * @param {string|null}  [opts.backupPath]
   * @param {object|null}  [opts.deployMeta]
   */
  async log(opts) {
    const {
      tenantId   = null,
      userId     = null,
      providerId,
      action,
      filePath,
      versionId  = null,
      oldValue   = null,
      newValue   = null,
      status,
      error      = null,
      durationMs = null,
      backupPath = null,
      deployMeta = null,
    } = opts;

    try {
      await query(
        `INSERT INTO config_audit_log
           (tenant_id, user_id, provider_id, action, file_path, version_id,
            old_value, new_value, status, error, duration_ms, backup_path, deploy_meta)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
        [
          tenantId,
          userId,
          providerId,
          action,
          filePath,
          versionId,
          oldValue   ? JSON.stringify(oldValue)  : null,
          newValue   ? JSON.stringify(newValue)   : null,
          status,
          error      ? String(error).slice(0, 2000) : null,
          durationMs,
          backupPath,
          deployMeta ? JSON.stringify(deployMeta) : null,
        ]
      );
    } catch (logErr) {
      // Audit log failures must never crash a deploy.
      console.error('[AuditLogger] Failed to write audit entry:', logErr.message);
    }
  }

  /**
   * Paginated audit log for a single provider.
   */
  async getProviderLog(providerId, { limit = 50, offset = 0 } = {}) {
    const { rows } = await query(
      `SELECT al.*, u.full_name AS user_name, u.email AS user_email
       FROM config_audit_log al
       LEFT JOIN users u ON u.id = al.user_id
       WHERE al.provider_id = $1
       ORDER BY al.performed_at DESC
       LIMIT $2 OFFSET $3`,
      [providerId, limit, offset]
    );
    return rows;
  }

  /**
   * Paginated audit log across all providers (admin-level view).
   */
  async getGlobalLog({ tenantId, limit = 100, offset = 0 } = {}) {
    const { rows } = await query(
      `SELECT al.*, u.full_name AS user_name, u.email AS user_email
       FROM config_audit_log al
       LEFT JOIN users u ON u.id = al.user_id
       ${tenantId ? 'WHERE al.tenant_id = $3' : ''}
       ORDER BY al.performed_at DESC
       LIMIT $1 OFFSET $2`,
      tenantId ? [limit, offset, tenantId] : [limit, offset]
    );
    return rows;
  }
}

export const auditLogger = new AuditLogger();
