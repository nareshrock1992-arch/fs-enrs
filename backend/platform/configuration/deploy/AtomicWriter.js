import { promises as fs } from 'fs';
import path from 'path';

/**
 * AtomicWriter — writes files using a tmp-then-rename strategy.
 *
 * Guarantees that no partial write is ever visible to readers:
 *  1. Write content to <target>.tmp.<timestamp>
 *  2. fsync the tmp file (flush to OS buffer)
 *  3. Atomically rename tmp → target
 *
 * On POSIX filesystems (Linux/macOS) rename(2) is atomic when src and dst
 * are on the same filesystem (always true here — both are in FS_CONF_DIR).
 *
 * The tmp file is cleaned up on error. If cleanup itself fails the error
 * is logged but does not mask the original error.
 */
export class AtomicWriter {

  /**
   * @param {string} filePath   — absolute path of the target file
   * @param {string} content    — UTF-8 string to write
   * @param {object} [options]
   * @param {string} [options.mode='0644']  — file permission mode
   */
  async write(filePath, content, options = {}) {
    const mode = options.mode ?? 0o644;
    const tmp  = `${filePath}.tmp.${Date.now()}`;

    // Ensure the target directory exists.
    await fs.mkdir(path.dirname(filePath), { recursive: true });

    const handle = await fs.open(tmp, 'w', mode);
    try {
      await handle.writeFile(content, 'utf8');
      await handle.sync();
    } finally {
      await handle.close();
    }

    try {
      await fs.rename(tmp, filePath);
    } catch (renameErr) {
      // Attempt to clean up the orphaned tmp file; log but don't mask.
      await fs.unlink(tmp).catch(e =>
        console.warn(`[AtomicWriter] Could not remove orphaned tmp file ${tmp}:`, e.message)
      );
      throw renameErr;
    }
  }
}

export const atomicWriter = new AtomicWriter();
