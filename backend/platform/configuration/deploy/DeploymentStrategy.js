/**
 * Deployment Strategy Capability Matrix.
 *
 * Each strategy is a named constant that describes:
 *  - which ESL commands to run after writing a config file
 *  - the risk level of those operations
 *  - whether the operator should confirm before proceeding
 *
 * Providers declare their required strategy via get deploymentStrategy().
 * The DeploymentManager executes it. No provider contains deployment logic.
 */

export const DeploymentStrategies = Object.freeze({

  /**
   * RELOAD_XML — Reload all FreeSWITCH XML configuration.
   * Risk: Low. Affects: vars.xml, acl.conf.xml, modules.conf.xml, dialplan, directory.
   */
  RELOAD_XML: {
    id:                   'reload_xml',
    label:                'Reload XML Configuration',
    description:          'Runs reloadxml to apply all XML configuration changes.',
    riskLevel:            'low',
    requiresConfirmation: false,
    steps: [
      {
        name:    'Reload XML',
        execute: async (driver) => driver.reloadXml(),
      },
    ],
    defaultVerify: async (driver, changes) => {
      const firstKey = changes?.find(c => c.op === 'set')?.key;
      if (!firstKey) return { passed: true, checks: [] };
      const actual = await driver.getGlobalVar(firstKey);
      const expected = changes.find(c => c.key === firstKey)?.value;
      return {
        passed: actual !== null,
        checks: [{ key: firstKey, expected: expected ?? '(any)', actual: actual ?? '(null)', passed: actual !== null }],
      };
    },
  },

  /**
   * SOFIA_RESCAN — Reload XML then rescan the external SIP profile.
   * Risk: Medium. Affects: sip_profiles, gateways.
   */
  SOFIA_RESCAN: {
    id:                   'sofia_rescan',
    label:                'Rescan SIP Profile',
    description:          'Runs reloadxml then sofia profile external rescan to apply gateway/profile changes.',
    riskLevel:            'medium',
    requiresConfirmation: false,
    steps: [
      {
        name:    'Reload XML',
        execute: async (driver) => driver.reloadXml(),
      },
      {
        name:    'Rescan external profile',
        execute: async (driver) => driver.reloadSofiaProfile('external'),
      },
    ],
    defaultVerify: async (driver) => {
      const status = await driver.getSofiaStatus();
      return { passed: !status.error, checks: [{ key: 'sofia_status', actual: status.raw?.slice(0, 100), passed: !status.error }] };
    },
  },

  /**
   * RELOAD_MODULE — Unload and reload a single module.
   * Risk: Medium. Requires moduleName in context.
   */
  RELOAD_MODULE: {
    id:                   'reload_module',
    label:                'Reload Module',
    description:          'Reloads the specified FreeSWITCH module to apply configuration changes.',
    riskLevel:            'medium',
    requiresConfirmation: false,
    steps: [
      {
        name:    'Reload module',
        execute: async (driver, ctx) => driver.reloadModule(ctx?.moduleName),
      },
    ],
    defaultVerify: async (driver, _changes, ctx) => {
      const result = await driver.getModuleStatus(ctx?.moduleName);
      return {
        passed: result.loaded,
        checks: [{ key: ctx?.moduleName, expected: 'loaded', actual: result.status, passed: result.loaded }],
      };
    },
  },

  /**
   * RESTART_MODULE — Fully unload then reload a module (brief interruption).
   * Risk: High. Requires explicit operator confirmation in the UI.
   */
  RESTART_MODULE: {
    id:                   'restart_module',
    label:                'Restart Module (service interruption)',
    description:          'Unloads then reloads the module. Causes a brief service interruption.',
    riskLevel:            'high',
    requiresConfirmation: true,
    steps: [
      {
        name:    'Unload module',
        execute: async (driver, ctx) => driver.unloadModule(ctx?.moduleName),
      },
      {
        name:    'Load module',
        execute: async (driver, ctx) => driver.loadModule(ctx?.moduleName),
      },
    ],
    defaultVerify: async (driver, _changes, ctx) => {
      const result = await driver.getModuleStatus(ctx?.moduleName);
      return {
        passed: result.loaded,
        checks: [{ key: ctx?.moduleName, expected: 'loaded', actual: result.status, passed: result.loaded }],
      };
    },
  },

});

/** Retrieve a strategy by ID string, throwing if not found. */
export function getStrategy(id) {
  const entry = Object.values(DeploymentStrategies).find(s => s.id === id);
  if (!entry) {
    throw new Error(
      `DeploymentStrategy: unknown strategy id '${id}'. ` +
      `Valid ids: ${Object.values(DeploymentStrategies).map(s => s.id).join(', ')}`
    );
  }
  return entry;
}
