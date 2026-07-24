/**
 * ProviderRegistry — maps provider IDs to their singleton instances.
 *
 * Providers register themselves at startup. The ConfigurationManager and
 * route handlers only ever look up a provider by ID — they never import
 * a provider class directly.
 */
export class ProviderRegistry {

  #providers = new Map();

  /**
   * Register a provider instance.
   * Throws if a provider with the same ID is already registered.
   *
   * @param {ConfigurationProvider} provider
   */
  register(provider) {
    if (this.#providers.has(provider.id)) {
      throw new Error(
        `ProviderRegistry: provider '${provider.id}' is already registered. ` +
        'Each provider ID must be unique.'
      );
    }
    this.#providers.set(provider.id, provider);
  }

  /**
   * @param {string} id
   * @returns {ConfigurationProvider}
   * @throws if not found
   */
  get(id) {
    const p = this.#providers.get(id);
    if (!p) {
      throw Object.assign(
        new Error(`Provider '${id}' is not registered.`),
        { statusCode: 404 }
      );
    }
    return p;
  }

  /** Returns true if a provider with this ID is registered. */
  has(id) {
    return this.#providers.has(id);
  }

  /** List all registered providers (metadata only — no internal state). */
  list() {
    return Array.from(this.#providers.values()).map(p => ({
      id:               p.id,
      name:             p.name,
      description:      p.description,
      strategy:         p.deploymentStrategy.id,
      strategyLabel:    p.deploymentStrategy.label,
      riskLevel:        p.deploymentStrategy.riskLevel,
      requiresConfirmation: p.deploymentStrategy.requiresConfirmation,
    }));
  }
}
