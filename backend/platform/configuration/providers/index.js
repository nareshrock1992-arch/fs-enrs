/**
 * Provider manifest — single place to register all configuration providers.
 *
 * To add a provider:
 *  1. Import its class here
 *  2. Add one registry.register() call in registerAll()
 *  3. No other file needs to change
 */
import { VarsProvider }         from './VarsProvider.js';
import { SwitchCoreProvider }   from './SwitchCoreProvider.js';
import { EventSocketProvider }  from './EventSocketProvider.js';
import { AclProvider }          from './AclProvider.js';

/**
 * Register all active providers with the given registry.
 * @param {ProviderRegistry} registry
 * @param {PlatformDriver}   driver
 */
export function registerAll(registry, driver) {
  registry.register(new VarsProvider(driver));
  registry.register(new SwitchCoreProvider(driver));
  registry.register(new EventSocketProvider(driver));
  registry.register(new AclProvider(driver));
}
