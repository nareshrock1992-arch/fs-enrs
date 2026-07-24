import path from 'path';
import { promises as fs } from 'fs';

/**
 * BackupManager — creates timestamped backups of config files before any deploy.
 *
 * Backup location: ${PLATFORM_DATA_DIR}/config-backups/{providerId}/{timestamp}_{filename}
 * PLATFORM_DATA_DIR defaults to <cwd>/data.
 *
 * Contract:
 *  - Never overwrites an existing backup (timestamp collision → millisecond suffix).
 *  - Returns the absolute path of the backup file created.
 *  - Throws if the source file cannot be read or the backup cannot be written.
 */
export class BackupManager {

  #baseDir;

  constructor() {
    // Use cwd/data so backups are in the application directory, not the FS config tree.
    this.#baseDir = process.env.PLATFORM_DATA_DIR
      ? path.join(process.env.PLATFORM_DATA_DIR, 'config-backups')
      : path.join(process.cwd(), 'data', 'config-backups');
  }

  /**
   * Copy filePath to the backup directory and return the backup path.
   *
   * @param {string} providerId   — e.g. 'vars'
   * @param {string} filePath     — absolute path of the file to back up
   * @returns {Promise<string>}   — absolute path of the created backup
   */
  async backup(providerId, filePath) {
    const content = await fs.readFile(filePath, 'utf8');

    const ts   = new Date().toISOString().replace(/[:.]/g, '-');
    const name = path.basename(filePath);
    const dir  = path.join(this.#baseDir, providerId);

    await fs.mkdir(dir, { recursive: true });

    let backupPath = path.join(dir, `${ts}_${name}`);

    // Extremely rare collision guard: append a counter suffix.
    let attempt = 0;
    while (true) {
      try {
        await fs.access(backupPath);
        // File exists — try a suffixed name.
        attempt++;
        backupPath = path.join(dir, `${ts}_${attempt}_${name}`);
      } catch {
        // fs.access threw → file does not exist → safe to write.
        break;
      }
    }

    await fs.writeFile(backupPath, content, 'utf8');
    return backupPath;
  }

  /**
   * Restore a previously backed-up file to targetPath.
   * Used by RollbackManager when rolling back from a backup file path
   * rather than a DB snapshot.
   */
  async restore(backupPath, targetPath) {
    const content = await fs.readFile(backupPath, 'utf8');
    // AtomicWriter is imported lazily to avoid circular deps.
    const { atomicWriter } = await import('./AtomicWriter.js');
    await atomicWriter.write(targetPath, content);
  }

  /**
   * Count backup files across all providers (or a specific provider).
   * Returns 0 if the backup directory does not exist yet.
   *
   * @param {string} [providerId] — optional; counts only this provider's backups
   * @returns {Promise<number>}
   */
  async countBackups(providerId) {
    const dir = providerId
      ? path.join(this.#baseDir, providerId)
      : this.#baseDir;
    try {
      const entries = await fs.readdir(dir, { recursive: !providerId });
      return entries.filter(e => typeof e === 'string' && !e.endsWith('/')).length;
    } catch {
      return 0;
    }
  }

  /**
   * Return metadata about the most recent backup for a provider.
   * Returns null if no backups exist.
   *
   * @param {string} providerId
   * @returns {Promise<{path:string, createdAt:Date}|null>}
   */
  async getLatestBackup(providerId) {
    const dir = path.join(this.#baseDir, providerId);
    try {
      const names = await fs.readdir(dir);
      if (names.length === 0) return null;
      // Filenames are timestamp-prefixed — lexicographic sort gives chronological order.
      const latest = names.sort().at(-1);
      const fullPath = path.join(dir, latest);
      const stat = await fs.stat(fullPath);
      return { path: fullPath, createdAt: stat.mtime };
    } catch {
      return null;
    }
  }
}

export const backupManager = new BackupManager();
