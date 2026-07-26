/**
 * Unit tests for discoverDialplanProviders (via registerAll).
 *
 * The discovery function is not exported, so it is exercised through
 * registerAll() with a pre-populated static registry and mock driver.
 * All filesystem I/O is mocked via vi.mock — no real files are read.
 *
 * Path Resolution Rule compliance:
 *   No FreeSWITCH filesystem path is hardcoded in this file.
 *   The mock driver defines the path namespace; every path used by fs.readdir
 *   mocks is derived from the driver's own return values via DIALPLAN_DIR /
 *   SIP_DIR constants. Changing the constants propagates everywhere automatically.
 *
 * Coverage:
 *   - top-level XML discovery
 *   - subdirectory XML discovery
 *   - hidden file skipping (.hidden.xml)
 *   - temp file skipping (_backup.xml)
 *   - Generated XML exclusion (enrs_ivr.xml)
 *   - missing dialplan directory (ENOENT) → non-fatal
 *   - unreadable subdirectory → skip gracefully
 *   - duplicate provider ID → warn, continue, no throw
 *   - registration count log
 *   - provider IDs use ':' not '/' as separator
 *   - existing providers (gateway, vars, …) unaffected
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ── fs mock setup ─────────────────────────────────────────────────────────────

vi.mock('fs', async () => {
  const actual = await vi.importActual('fs');
  return {
    ...actual,
    promises: {
      ...actual.promises,
      readdir: vi.fn(),
    },
  };
});

import { promises as fs } from 'fs';
import { registerAll } from '../../../platform/configuration/providers/index.js';
import { ProviderRegistry } from '../../../platform/configuration/ProviderRegistry.js';

// ── Mock path namespace ───────────────────────────────────────────────────────
//
// Arbitrary test-only values — deliberately NOT real FreeSWITCH paths.
// All path comparisons in fs.readdir mocks are derived from these constants.
// Changing a constant here propagates automatically to every mock.

const DIALPLAN_DIR = '/mock/fs/dialplan';
const SIP_DIR      = '/mock/fs/sip_profiles';

// ── Mock driver ───────────────────────────────────────────────────────────────

/**
 * Minimal driver mock that satisfies the driver contract expected by
 * discoverDialplanProviders and discoverGatewayProviders.
 *
 * Implements only the two path methods called during discovery.
 * resolveConfigurationPath delegates to DIALPLAN_DIR.
 * resolveSipProfilePath delegates to SIP_DIR.
 * No FreeSWITCH path is hardcoded here.
 */
function makeDriver() {
  return {
    resolveConfigurationPath: (type, rel) => {
      if (type !== 'dialplan') throw new Error(`mock driver: unexpected type '${type}'`);
      return rel ? `${DIALPLAN_DIR}/${rel}` : DIALPLAN_DIR;
    },
    resolveSipProfilePath: (rel) => rel ? `${SIP_DIR}/${rel}` : SIP_DIR,
  };
}

// ── Dirent factory ────────────────────────────────────────────────────────────

/** Build a minimal dirent-like object for fs.readdir({ withFileTypes: true }). */
function dirent(name, isDir = false) {
  return { name, isDirectory: () => isDir };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('discoverDialplanProviders (via registerAll)', () => {

  let registry;
  let driver;

  beforeEach(() => {
    registry = new ProviderRegistry();
    driver   = makeDriver();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.clearAllMocks();
  });

  // ── fs.readdir mock helper ─────────────────────────────────────────────────
  //
  // All path comparisons are built from DIALPLAN_DIR and SIP_DIR — no
  // filesystem path literal appears below. The driver is the authority.

  function setupFs(topLevel, subdirMap = {}) {
    fs.readdir.mockImplementation(async (dirPath, opts) => {
      // Gateway sip_profiles directory — always ENOENT so it doesn't interfere.
      if (dirPath === SIP_DIR) {
        throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      }

      // Dialplan top-level directory.
      if (dirPath === DIALPLAN_DIR) {
        return opts?.withFileTypes ? topLevel : topLevel.map(d => d.name);
      }

      // Subdirectory: DIALPLAN_DIR/<subdir>
      for (const [sub, files] of Object.entries(subdirMap)) {
        if (dirPath === `${DIALPLAN_DIR}/${sub}`) {
          return files; // plain string array
        }
      }

      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    });
  }

  // ── Top-level XML discovery ────────────────────────────────────────────────

  it('registers top-level XML files as dialplan:<basename>', async () => {
    setupFs([
      dirent('default.xml'),
      dirent('public.xml'),
    ]);

    await registerAll(registry, driver);

    expect(registry.has('dialplan:default')).toBe(true);
    expect(registry.has('dialplan:public')).toBe(true);
  });

  it('top-level provider has correct id and docType', async () => {
    setupFs([dirent('default.xml')]);

    await registerAll(registry, driver);

    const p = registry.get('dialplan:default');
    expect(p.id).toBe('dialplan:default');
    expect(p.docType).toBe('hierarchical');
  });

  // ── Subdirectory XML discovery ─────────────────────────────────────────────

  it('registers subdirectory XML files as dialplan:<subdir>:<basename>', async () => {
    setupFs(
      [dirent('default.xml'), dirent('default', true)],
      { default: ['cc.xml', '01_example.com.xml'] }
    );

    await registerAll(registry, driver);

    expect(registry.has('dialplan:default')).toBe(true);
    expect(registry.has('dialplan:default:cc')).toBe(true);
    expect(registry.has('dialplan:default:01_example.com')).toBe(true);
  });

  it('subdirectory provider id uses ":" not "/"', async () => {
    setupFs(
      [dirent('default', true)],
      { default: ['cc.xml'] }
    );

    await registerAll(registry, driver);

    expect(registry.has('dialplan:default:cc')).toBe(true);
    expect(registry.has('dialplan:default/cc')).toBe(false);
  });

  it('discovers multiple subdirectories', async () => {
    setupFs(
      [dirent('default', true), dirent('public', true)],
      {
        default: ['cc.xml'],
        public:  ['00_inbound_did.xml'],
      }
    );

    await registerAll(registry, driver);

    expect(registry.has('dialplan:default:cc')).toBe(true);
    expect(registry.has('dialplan:public:00_inbound_did')).toBe(true);
  });

  // ── Hidden file skipping ───────────────────────────────────────────────────

  it('skips top-level hidden XML files (.hidden.xml)', async () => {
    setupFs([
      dirent('default.xml'),
      dirent('.hidden.xml'),
    ]);

    await registerAll(registry, driver);

    expect(registry.has('dialplan:default')).toBe(true);
    const ids = registry.list().map(p => p.id).filter(id => id.startsWith('dialplan:'));
    expect(ids).toHaveLength(1);
    expect(ids).not.toContain('dialplan:.hidden');
  });

  it('skips subdirectory hidden files', async () => {
    setupFs(
      [dirent('default', true)],
      { default: ['cc.xml', '.hidden.xml'] }
    );

    await registerAll(registry, driver);

    expect(registry.has('dialplan:default:cc')).toBe(true);
    const ids = registry.list().map(p => p.id).filter(id => id.startsWith('dialplan:'));
    expect(ids).not.toContain('dialplan:default:.hidden');
  });

  it('skips hidden subdirectories (.backup/)', async () => {
    setupFs([dirent('.backup', true)]);

    await registerAll(registry, driver);

    const ids = registry.list().map(p => p.id).filter(id => id.startsWith('dialplan:'));
    expect(ids).toHaveLength(0);
  });

  // ── Temp file skipping ─────────────────────────────────────────────────────

  it('skips top-level temp files (_backup.xml)', async () => {
    setupFs([
      dirent('default.xml'),
      dirent('_backup.xml'),
    ]);

    await registerAll(registry, driver);

    const ids = registry.list().map(p => p.id).filter(id => id.startsWith('dialplan:'));
    expect(ids).toHaveLength(1);
    expect(ids[0]).toBe('dialplan:default');
  });

  it('skips subdirectory temp files', async () => {
    setupFs(
      [dirent('default', true)],
      { default: ['cc.xml', '_old.xml'] }
    );

    await registerAll(registry, driver);

    expect(registry.has('dialplan:default:cc')).toBe(true);
    const ids = registry.list().map(p => p.id).filter(id => id.startsWith('dialplan:'));
    expect(ids).toHaveLength(1);
  });

  // ── Generated XML exclusion ────────────────────────────────────────────────

  it('excludes enrs_ivr.xml from registration (Generated XML — IVR Builder ownership)', async () => {
    setupFs(
      [dirent('default', true)],
      { default: ['cc.xml', 'enrs_ivr.xml'] }
    );

    await registerAll(registry, driver);

    expect(registry.has('dialplan:default:cc')).toBe(true);
    expect(registry.has('dialplan:default:enrs_ivr')).toBe(false);
    expect(registry.list().map(p => p.id)).not.toContain('dialplan:default:enrs_ivr');
  });

  it('excludes enrs_ivr.xml even if it appears at the top level', async () => {
    setupFs([
      dirent('default.xml'),
      dirent('enrs_ivr.xml'),
    ]);

    await registerAll(registry, driver);

    expect(registry.has('dialplan:default')).toBe(true);
    expect(registry.has('dialplan:enrs_ivr')).toBe(false);
  });

  // ── Missing directory — non-fatal ──────────────────────────────────────────

  it('continues boot when dialplan directory is missing (ENOENT)', async () => {
    fs.readdir.mockImplementation(async (dirPath) => {
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    });

    await expect(registerAll(registry, driver)).resolves.not.toThrow();

    expect(registry.has('vars')).toBe(true);
    expect(console.warn).toHaveBeenCalledWith(
      expect.stringContaining('[DialplanDiscovery]')
    );
  });

  it('continues boot when dialplan directory is inaccessible (EACCES)', async () => {
    fs.readdir.mockImplementation(async (dirPath) => {
      if (dirPath === SIP_DIR) {
        throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      }
      throw Object.assign(new Error('EACCES'), { code: 'EACCES' });
    });

    await expect(registerAll(registry, driver)).resolves.not.toThrow();
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('[DialplanDiscovery]'));
  });

  // ── Unreadable subdirectory — skip gracefully ──────────────────────────────

  it('skips an unreadable subdirectory and continues discovering others', async () => {
    // Derive subdirectory paths from the driver — no path literals here.
    const defaultSubdir = driver.resolveConfigurationPath('dialplan', 'default');
    const publicSubdir  = driver.resolveConfigurationPath('dialplan', 'public');

    fs.readdir.mockImplementation(async (dirPath, opts) => {
      if (dirPath === SIP_DIR) {
        throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      }
      if (dirPath === DIALPLAN_DIR) {
        return opts?.withFileTypes
          ? [dirent('default', true), dirent('public', true)]
          : [];
      }
      if (dirPath === defaultSubdir) {
        throw Object.assign(new Error('EACCES'), { code: 'EACCES' });
      }
      if (dirPath === publicSubdir) {
        return ['00_inbound_did.xml'];
      }
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    });

    await expect(registerAll(registry, driver)).resolves.not.toThrow();
    expect(registry.has('dialplan:public:00_inbound_did')).toBe(true);
    const ids = registry.list().map(p => p.id).filter(id => id.startsWith('dialplan:'));
    expect(ids).not.toContain('dialplan:default:cc');
  });

  // ── Duplicate provider ID — warn and continue ──────────────────────────────

  it('logs a warning on duplicate provider ID and continues without throwing', async () => {
    // Duplicate top-level entries — contrived but exercises the catch block.
    setupFs([
      dirent('default.xml'),
      dirent('default.xml'),
    ]);

    await expect(registerAll(registry, driver)).resolves.not.toThrow();
    expect(console.warn).toHaveBeenCalledWith(
      expect.stringContaining('[DialplanDiscovery]')
    );
  });

  // ── Registration count log ─────────────────────────────────────────────────

  it('logs registration count when providers are discovered', async () => {
    setupFs([dirent('default.xml'), dirent('public.xml')]);

    await registerAll(registry, driver);

    expect(console.log).toHaveBeenCalledWith(
      expect.stringMatching(/\[DialplanDiscovery\].*2.*dialplan provider/)
    );
  });

  it('does not log registration count when no providers are discovered', async () => {
    setupFs([]);

    await registerAll(registry, driver);

    const dialplanLogs = console.log.mock.calls
      .filter(args => String(args[0]).includes('[DialplanDiscovery]'));
    expect(dialplanLogs).toHaveLength(0);
  });

  // ── Existing providers unaffected ─────────────────────────────────────────

  it('static providers are always registered regardless of dialplan directory state', async () => {
    fs.readdir.mockImplementation(async () => {
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    });

    await registerAll(registry, driver);

    expect(registry.has('vars')).toBe(true);
    expect(registry.has('switch-core')).toBe(true);
    expect(registry.has('event-socket')).toBe(true);
    expect(registry.has('acl')).toBe(true);
    expect(registry.has('sip-profiles')).toBe(true);
    expect(registry.has('conference')).toBe(true);
  });

  it('dialplan providers do not collide with gateway provider IDs', async () => {
    setupFs([dirent('default.xml')]);

    await registerAll(registry, driver);

    const dialplanIds = registry.list().map(p => p.id).filter(id => id.startsWith('dialplan:'));
    const gatewayIds  = registry.list().map(p => p.id).filter(id => id.startsWith('gateway:'));
    expect(dialplanIds.some(id => gatewayIds.includes(id))).toBe(false);
  });

  // ── Non-XML files are ignored ──────────────────────────────────────────────

  it('ignores non-XML files in the dialplan directory', async () => {
    setupFs([
      dirent('default.xml'),
      dirent('README.md'),
      dirent('notes.txt'),
    ]);

    await registerAll(registry, driver);

    const dialplanIds = registry.list().map(p => p.id).filter(id => id.startsWith('dialplan:'));
    expect(dialplanIds).toHaveLength(1);
    expect(dialplanIds[0]).toBe('dialplan:default');
  });
});
