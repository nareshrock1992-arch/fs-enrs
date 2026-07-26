/**
 * Provider manifest — single place to register all configuration providers.
 *
 * To add a static provider:
 *  1. Import its class here
 *  2. Add one registry.register() call in registerAll()
 *  3. No other file needs to change
 *
 * Gateway providers are discovered dynamically from the configured
 * sip_profiles directory and registered automatically — no changes needed
 * here when new gateway XML files are added to the filesystem.
 */
import { promises as fs } from 'fs';

import { VarsProvider }         from './VarsProvider.js';
import { SwitchCoreProvider }   from './SwitchCoreProvider.js';
import { EventSocketProvider }  from './EventSocketProvider.js';
import { AclProvider }          from './AclProvider.js';
import { SofiaProvider }        from './SofiaProvider.js';
import { ConferenceProvider }   from './ConferenceProvider.js';
import { GatewayFileProvider }  from './GatewayFileProvider.js';
import { DialplanFileProvider } from './DialplanFileProvider.js';

/**
 * Register all active providers with the given registry.
 * Returns a Promise — bootstrap() must await this call.
 *
 * @param {ProviderRegistry} registry
 * @param {PlatformDriver}   driver
 * @returns {Promise<void>}
 */
export async function registerAll(registry, driver) {
  // Static providers (one file each).
  registry.register(new VarsProvider(driver));
  registry.register(new SwitchCoreProvider(driver));
  registry.register(new EventSocketProvider(driver));
  registry.register(new AclProvider(driver));
  registry.register(new SofiaProvider(driver));
  registry.register(new ConferenceProvider(driver));

  // Dynamic gateway discovery: enumerate sip_profiles/<profile>/*.xml
  await discoverGatewayProviders(registry, driver);

  // Dynamic dialplan discovery: enumerate dialplan/*.xml and dialplan/<subdir>/*.xml
  await discoverDialplanProviders(registry, driver);
}

/**
 * Discover and register one GatewayFileProvider per gateway XML file found
 * under the configured sip_profiles directory.
 *
 * Layout expected:
 *   sip_profiles/
 *     external/          ← SIP profile directory
 *       avaya.xml        ← gateway file  →  id: gateway:external:avaya
 *       cucm.xml         ← gateway file  →  id: gateway:external:cucm
 *     internal/
 *       sbc.xml          ← gateway file  →  id: gateway:internal:sbc
 *
 * No profile or gateway names are hardcoded. Completely data-driven.
 * If the sip_profiles directory is absent or inaccessible (e.g. dev
 * environment), the function logs a warning and returns — the rest of the
 * platform continues to boot normally.
 *
 * @param {ProviderRegistry} registry
 * @param {PlatformDriver}   driver
 */
async function discoverGatewayProviders(registry, driver) {
  const sipProfileDir = driver.resolveSipProfilePath();

  let profileEntries;
  try {
    profileEntries = await fs.readdir(sipProfileDir, { withFileTypes: true });
  } catch (err) {
    if (err.code === 'ENOENT' || err.code === 'ENOTDIR' || err.code === 'EACCES') {
      console.warn(
        `[GatewayDiscovery] sip_profiles directory not accessible at '${sipProfileDir}' ` +
        `(${err.code}) — no gateway providers registered. ` +
        'Set FS_SIP_PROFILE_DIR to the correct path.'
      );
    } else {
      console.error('[GatewayDiscovery] Unexpected error reading sip_profiles directory:', err.message);
    }
    return;
  }

  let registered = 0;

  for (const entry of profileEntries) {
    if (!entry.isDirectory()) continue;

    const profileName = entry.name;
    // Skip hidden directories (e.g. .git, .backup)
    if (profileName.startsWith('.')) continue;

    let files;
    try {
      files = await fs.readdir(driver.resolveSipProfilePath(profileName));
    } catch {
      // Skip unreadable profile directories gracefully.
      continue;
    }

    for (const file of files) {
      if (!file.endsWith('.xml')) continue;
      // Skip hidden/temp files (.gateway.xml, _old.xml, etc.)
      if (file.startsWith('.') || file.startsWith('_')) continue;

      const fileBasename = file.slice(0, -4); // strip .xml
      try {
        registry.register(new GatewayFileProvider(driver, profileName, fileBasename));
        registered++;
      } catch (regErr) {
        // Duplicate ID (same file discovered twice) — log and continue.
        console.warn(`[GatewayDiscovery] Could not register gateway '${profileName}/${file}': ${regErr.message}`);
      }
    }
  }

  if (registered > 0) {
    console.log(`[GatewayDiscovery] Registered ${registered} gateway provider(s) from '${sipProfileDir}'.`);
  }
}

/**
 * Discover and register one DialplanFileProvider per managed dialplan XML file.
 *
 * Layout supported (two tiers — both enumerated automatically):
 *
 *   dialplan/
 *     default.xml          → id: dialplan:default
 *     public.xml           → id: dialplan:public
 *     default/
 *       cc.xml             → id: dialplan:default:cc
 *       01_example.com.xml → id: dialplan:default:01_example.com
 *     public/
 *       00_inbound_did.xml → id: dialplan:public:00_inbound_did
 *
 * Generated XML exclusion (Configuration Ownership rule):
 *   enrs_ivr.xml is excluded from discovery wherever it appears.
 *   It is owned by IVR Builder — its authoritative source is the database graph,
 *   and the XML is a derived artifact. Registering a Provider for it would give
 *   Configuration Center edit ownership of an IVR Builder artifact, violating
 *   ARCHITECTURE.md "Configuration Ownership" and "Managed vs Generated XML".
 *
 * Path Resolution rule compliance:
 *   All paths are obtained via driver.resolveConfigurationPath('dialplan', ...).
 *   No path is hardcoded. No fsConfig or freeSwitchPathService is imported.
 *
 * Boot safety:
 *   If the dialplan directory is absent or inaccessible, a warning is logged
 *   and the function returns. Platform startup continues normally.
 *
 * @param {ProviderRegistry} registry
 * @param {PlatformDriver}   driver
 */
async function discoverDialplanProviders(registry, driver) {
  const dialplanDir = driver.resolveConfigurationPath('dialplan');

  // Generated XML files that must never be registered as managed providers.
  // Each entry is an exact basename. See Configuration Ownership rule in
  // ARCHITECTURE.md for the ownership reasoning behind each exclusion.
  const GENERATED_XML = new Set([
    'enrs_ivr.xml', // owned by IVR Builder — database graph is authoritative
  ]);

  let topEntries;
  try {
    topEntries = await fs.readdir(dialplanDir, { withFileTypes: true });
  } catch (err) {
    if (err.code === 'ENOENT' || err.code === 'ENOTDIR' || err.code === 'EACCES') {
      console.warn(
        `[DialplanDiscovery] dialplan directory not accessible at '${dialplanDir}' ` +
        `(${err.code}) — no dialplan providers registered. ` +
        'Set FS_DIALPLAN_DIR to the correct path.'
      );
    } else {
      console.error('[DialplanDiscovery] Unexpected error reading dialplan directory:', err.message);
    }
    return;
  }

  let registered = 0;

  // ── Tier 1: top-level XML files (dialplan/*.xml) ───────────────────────────

  for (const entry of topEntries) {
    if (entry.isDirectory()) continue;
    const file = entry.name;
    if (!file.endsWith('.xml')) continue;
    if (file.startsWith('.') || file.startsWith('_')) continue; // hidden / temp
    if (GENERATED_XML.has(file)) continue;                       // Generated XML

    try {
      registry.register(new DialplanFileProvider(driver, file));
      registered++;
    } catch (regErr) {
      console.warn(`[DialplanDiscovery] Could not register '${file}': ${regErr.message}`);
    }
  }

  // ── Tier 2: subdirectory XML files (dialplan/<subdir>/*.xml) ──────────────

  for (const entry of topEntries) {
    if (!entry.isDirectory()) continue;
    const subdir = entry.name;
    if (subdir.startsWith('.') || subdir.startsWith('_')) continue; // hidden / temp

    let files;
    try {
      files = await fs.readdir(driver.resolveConfigurationPath('dialplan', subdir));
    } catch {
      // Skip unreadable subdirectories gracefully.
      continue;
    }

    for (const file of files) {
      if (!file.endsWith('.xml')) continue;
      if (file.startsWith('.') || file.startsWith('_')) continue; // hidden / temp
      if (GENERATED_XML.has(file)) continue;                       // Generated XML

      const relativePath = `${subdir}/${file}`;
      try {
        registry.register(new DialplanFileProvider(driver, relativePath));
        registered++;
      } catch (regErr) {
        console.warn(`[DialplanDiscovery] Could not register '${relativePath}': ${regErr.message}`);
      }
    }
  }

  if (registered > 0) {
    console.log(`[DialplanDiscovery] Registered ${registered} dialplan provider(s) from '${dialplanDir}'.`);
  }
}
