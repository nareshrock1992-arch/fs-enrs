import { promises as fs } from 'fs';
import crypto from 'crypto';
import { atomicWriter } from './AtomicWriter.js';
import { backupManager } from './BackupManager.js';
import { versionManager } from '../history/VersionManager.js';
import { auditLogger } from '../audit/AuditLogger.js';

/**
 * DeploymentManager — executes the full 11-step deploy and rollback pipelines.
 *
 * Responsibilities:
 *  1. Re-read the config file from disk (never trust caller-supplied content)
 *  2. Delegate parse/apply/validate/serialize to the provider
 *  3. Backup, snapshot, atomic-write, reload, verify, audit
 *
 * Providers are pure — they never touch the filesystem.
 * This class owns all I/O.
 */
export class DeploymentManager {

  /**
   * Preview changes without writing anything to disk.
   *
   * @param {object} provider — ConfigurationProvider instance
   * @param {Array}  changes  — array of change objects
   * @param {object} context  — { userId, tenantId, reason? }
   * @returns {Promise<object>}
   */
  async preview(provider, changes, context = {}) {
    const started = Date.now();

    // Step 1: Read from disk.
    const filePath   = provider.getFilePath();
    const rawContent = await this.#readFile(filePath);

    // Step 2: Parse.
    const parsed = provider.parse(rawContent);

    // Step 3: Apply changes.
    const proposed = provider.applyChanges(parsed, changes);

    // Step 4: Validate proposed state.
    const validation = provider.validate(proposed);

    // Step 5: Serialize proposed state.
    const proposedRaw = provider.serialize(proposed);

    // Step 6: Compute diff.
    const diffSummary = provider.diff(rawContent, proposedRaw);

    // Step 7: Log preview to audit trail.
    await auditLogger.log({
      tenantId:   context.tenantId,
      userId:     context.userId,
      providerId: provider.id,
      action:     'preview',
      filePath,
      status:     'success',
      durationMs: Date.now() - started,
    });

    return {
      providerId:     provider.id,
      filePath,
      currentRaw:     rawContent,
      proposedRaw,
      diffSummary,
      validation,
      changesApplied: changes.length,
      durationMs:     Date.now() - started,
    };
  }

  /**
   * Execute the full deploy pipeline.
   *
   * @param {object} provider
   * @param {Array}  changes
   * @param {object} context  — { userId, tenantId, reason?, strategyContext? }
   * @returns {Promise<DeploymentResult>}
   */
  async deploy(provider, changes, context = {}) {
    const started   = Date.now();
    const filePath  = provider.getFilePath();
    const strategy  = provider.deploymentStrategy;
    const steps     = [];
    let   versionId = null;
    let   backupPath = null;
    let   error     = null;
    let   status    = 'failed';

    const recordStep = (name, fn) => this.#step(steps, name, fn);

    try {
      // ── Step 1: Re-read file from disk ────────────────────────────────────
      let rawContent;
      await recordStep('Read file', async () => {
        rawContent = await this.#readFile(filePath);
      });

      // ── Step 2: Parse ─────────────────────────────────────────────────────
      let parsed;
      await recordStep('Parse', async () => {
        parsed = provider.parse(rawContent);
      });

      // ── Step 3: Apply changes ─────────────────────────────────────────────
      let proposed;
      await recordStep('Apply changes', async () => {
        proposed = provider.applyChanges(parsed, changes);
      });

      // ── Step 4: Validate ──────────────────────────────────────────────────
      let validation;
      await recordStep('Validate', async () => {
        validation = provider.validate(proposed);
        if (!validation.valid) {
          throw Object.assign(
            new Error(`Validation failed: ${validation.errors.join('; ')}`),
            { statusCode: 422 }
          );
        }
      });

      // ── Step 5: Serialize ─────────────────────────────────────────────────
      let proposedRaw;
      await recordStep('Serialize', async () => {
        proposedRaw = provider.serialize(proposed);
      });

      // ── Step 6: Generate diff ─────────────────────────────────────────────
      let diffSummary;
      await recordStep('Generate diff', async () => {
        diffSummary = provider.diff(rawContent, proposedRaw);
      });

      // ── Step 7: Provider beforeDeploy hook ────────────────────────────────
      await recordStep('Pre-deploy hook', async () => {
        if (provider.beforeDeploy) await provider.beforeDeploy(proposed);
      });

      // ── Step 8: Backup ────────────────────────────────────────────────────
      await recordStep('Backup', async () => {
        backupPath = await backupManager.backup(provider.id, filePath);
      });

      // ── Step 9: Atomic write ──────────────────────────────────────────────
      // Write the file BEFORE creating the DB snapshot. This ensures the
      // DB record is only created when the new content is confirmed on disk.
      // If the write fails, no version row is created and the DB stays
      // consistent with the live file.
      await recordStep('Atomic write', async () => {
        await atomicWriter.write(filePath, proposedRaw);
      });

      // ── Step 10: Execute deployment strategy ──────────────────────────────
      for (const stratStep of strategy.steps) {
        await recordStep(stratStep.name, async () => {
          const result = await stratStep.execute(provider.driver, context.strategyContext);
          if (result && !result.success) {
            throw new Error(`${stratStep.name} returned failure: ${result.output}`);
          }
        });
      }

      // ── Step 11: Snapshot to DB ───────────────────────────────────────────
      // Created after the atomic write so is_active=true in the DB only when
      // the file on disk already matches xml_content.
      const checksumBefore = sha256(rawContent);
      const checksumAfter  = sha256(proposedRaw);
      const changedKeys    = changes.map(c => c.key).filter(Boolean);
      const deployMeta     = {
        durationMs:    null, // filled in at end
        strategy:      strategy.id,
        changedKeys,
        checksumBefore,
        checksumAfter,
        steps,
      };

      await recordStep('Create version snapshot', async () => {
        versionId = await versionManager.createVersion({
          tenantId:    context.tenantId,
          providerId:  provider.id,
          filePath,
          xmlContent:  proposedRaw,
          checksum:    checksumAfter,
          deployedBy:  context.userId,
          reason:      context.reason,
          backupPath,
          diffSummary,
          changedKeys,
          deployMeta,
        });
      });

      // ── Step 12: Verify ───────────────────────────────────────────────────
      let verification = { passed: true, checks: [] };
      await recordStep('Verify deployment', async () => {
        if (provider.verifyDeployment) {
          verification = await provider.verifyDeployment(provider.driver, changes);
        } else if (strategy.defaultVerify) {
          verification = await strategy.defaultVerify(provider.driver, changes, context.strategyContext);
        }
      });

      // ── Step 13: Provider afterDeploy hook ────────────────────────────────
      await recordStep('Post-deploy hook', async () => {
        if (provider.afterDeploy) await provider.afterDeploy({ versionId, verification });
      });

      status = 'success';

      const result = {
        success:        true,
        providerId:     provider.id,
        filePath,
        versionId,
        backupPath,
        checksumBefore,
        checksumAfter,
        changedKeys,
        diffSummary,
        verification,
        steps,
        durationMs:     Date.now() - started,
        deployedAt:     new Date().toISOString(),
      };

      await auditLogger.log({
        tenantId:   context.tenantId,
        userId:     context.userId,
        providerId: provider.id,
        action:     'deploy',
        filePath,
        versionId,
        newValue:   { changedKeys, checksumAfter },
        oldValue:   { checksumBefore },
        status:     'success',
        durationMs: result.durationMs,
        backupPath,
        deployMeta: result,
      });

      return result;

    } catch (err) {
      error = err.message;

      await auditLogger.log({
        tenantId:   context.tenantId,
        userId:     context.userId,
        providerId: provider.id,
        action:     'deploy',
        filePath,
        versionId,
        status:     'failed',
        error,
        durationMs: Date.now() - started,
        backupPath,
      });

      throw err;
    }
  }

  /**
   * Roll back to a previously deployed version.
   *
   * @param {object} provider
   * @param {number} versionId    — config_versions.id to restore
   * @param {object} context      — { userId, tenantId, reason? }
   * @returns {Promise<DeploymentResult>}
   */
  async rollback(provider, versionId, context = {}) {
    const started  = Date.now();
    const filePath = provider.getFilePath();
    const strategy = provider.deploymentStrategy;
    const steps    = [];
    let   error    = null;
    let   backupPath = null;
    let   newVersionId = null;

    const recordStep = (name, fn) => this.#step(steps, name, fn);

    try {
      // Load the target version from DB, scoped to this tenant to prevent
      // cross-tenant rollback by guessing a version ID.
      const targetVersion = await versionManager.getVersion(versionId, context.tenantId);
      if (!targetVersion) {
        throw Object.assign(
          new Error(`Version ${versionId} not found`),
          { statusCode: 404 }
        );
      }

      // Validate it belongs to this provider.
      if (targetVersion.provider_id !== provider.id) {
        throw Object.assign(
          new Error(`Version ${versionId} belongs to provider '${targetVersion.provider_id}', not '${provider.id}'`),
          { statusCode: 400 }
        );
      }

      // Validate restored content before touching the filesystem.
      await recordStep('Validate restored content', async () => {
        const validation = provider.validate(
          provider.parse(targetVersion.xml_content)
        );
        if (!validation.valid) {
          throw new Error(`Restored content failed validation: ${validation.errors.join('; ')}`);
        }
      });

      // Read current file for checksum and backup.
      let rawCurrent;
      await recordStep('Read current file', async () => {
        rawCurrent = await this.#readFile(filePath);
      });

      const checksumBefore = sha256(rawCurrent);
      const checksumAfter  = sha256(targetVersion.xml_content);

      // Backup the current live file.
      await recordStep('Backup current file', async () => {
        backupPath = await backupManager.backup(provider.id, filePath);
      });

      // Snapshot the rollback state in DB.
      await recordStep('Create version snapshot', async () => {
        newVersionId = await versionManager.createVersion({
          tenantId:    context.tenantId,
          providerId:  provider.id,
          filePath,
          xmlContent:  targetVersion.xml_content,
          checksum:    checksumAfter,
          deployedBy:  context.userId,
          reason:      context.reason ?? `Rollback to version ${versionId}`,
          backupPath,
          deployMeta:  { rollbackOf: versionId, strategy: strategy.id },
        });
      });

      // Atomic write.
      await recordStep('Atomic write', async () => {
        await atomicWriter.write(filePath, targetVersion.xml_content);
      });

      // Execute strategy.
      for (const stratStep of strategy.steps) {
        await recordStep(stratStep.name, async () => {
          await stratStep.execute(provider.driver, context.strategyContext);
        });
      }

      const result = {
        success:         true,
        providerId:      provider.id,
        filePath,
        versionId:       newVersionId,
        rolledBackFrom:  versionId,
        backupPath,
        checksumBefore,
        checksumAfter,
        steps,
        durationMs:      Date.now() - started,
        deployedAt:      new Date().toISOString(),
      };

      await auditLogger.log({
        tenantId:   context.tenantId,
        userId:     context.userId,
        providerId: provider.id,
        action:     'rollback',
        filePath,
        versionId:  newVersionId,
        status:     'success',
        durationMs: result.durationMs,
        backupPath,
        deployMeta: result,
      });

      return result;

    } catch (err) {
      error = err.message;

      await auditLogger.log({
        tenantId:   context.tenantId,
        userId:     context.userId,
        providerId: provider.id,
        action:     'rollback',
        filePath,
        status:     'failed',
        error,
        durationMs: Date.now() - started,
      });

      throw err;
    }
  }

  // ── Internals ─────────────────────────────────────────────────────────────────

  async #readFile(filePath) {
    try {
      return await fs.readFile(filePath, 'utf8');
    } catch (err) {
      if (err.code === 'ENOENT') {
        throw Object.assign(
          new Error(`Config file not found: ${filePath}. Ensure FreeSWITCH is installed and FS_CONF_DIR is correct.`),
          { statusCode: 404 }
        );
      }
      throw err;
    }
  }

  async #step(steps, name, fn) {
    const start = Date.now();
    const entry = { name, status: 'pending', startedAt: new Date().toISOString(), finishedAt: null, output: null, error: null };
    steps.push(entry);
    try {
      const result = await fn();
      entry.status     = 'ok';
      entry.finishedAt = new Date().toISOString();
      entry.output     = result ? String(result).slice(0, 500) : null;
      entry.durationMs = Date.now() - start;
    } catch (err) {
      entry.status     = 'failed';
      entry.finishedAt = new Date().toISOString();
      entry.error      = err.message;
      entry.durationMs = Date.now() - start;
      throw err;
    }
  }
}

export const deploymentManager = new DeploymentManager();

function sha256(str) {
  return crypto.createHash('sha256').update(str, 'utf8').digest('hex');
}
