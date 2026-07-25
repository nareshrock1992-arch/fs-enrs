import { create } from 'zustand';

/**
 * configChangesStore — cross-provider pending change tracking.
 *
 * Maps providerId → Map<key, changeObject>.
 * The dashboard reads total pending counts without making an API call.
 * ConfigPage migrates from local useState to this store.
 */

// Stable empty map — returned by getChanges when a provider has no pending changes.
// Using a singleton avoids creating a new Map() on every render, which would
// cause currentValues and filtered to recompute unnecessarily on each render pass.
const EMPTY_MAP = new Map();

export const useConfigChangesStore = create((set, get) => ({

  // Map<providerId → Map<key, change>>
  _changes: new Map(),

  /** Return the Map<key, change> for a provider (never null). */
  getChanges(providerId) {
    return get()._changes.get(providerId) ?? EMPTY_MAP;
  },

  /** Upsert a single change for a provider key. */
  setChange(providerId, change) {
    set(state => {
      const next = new Map(state._changes);
      const provMap = new Map(next.get(providerId) ?? new Map());
      provMap.set(change.key, change);
      next.set(providerId, provMap);
      return { _changes: next };
    });
  },

  /** Remove a single key from a provider's pending changes. */
  revertKey(providerId, key) {
    set(state => {
      const next = new Map(state._changes);
      const provMap = new Map(next.get(providerId) ?? new Map());
      provMap.delete(key);
      if (provMap.size === 0) {
        next.delete(providerId);
      } else {
        next.set(providerId, provMap);
      }
      return { _changes: next };
    });
  },

  /** Clear all pending changes for a provider (after deploy/discard). */
  clearProvider(providerId) {
    set(state => {
      const next = new Map(state._changes);
      next.delete(providerId);
      return { _changes: next };
    });
  },

  /** Total pending change count across all providers. */
  totalPending() {
    let total = 0;
    for (const m of get()._changes.values()) total += m.size;
    return total;
  },

  /** Per-provider pending count summary [{ providerId, count }]. */
  providerCounts() {
    const out = [];
    for (const [id, m] of get()._changes.entries()) {
      if (m.size > 0) out.push({ providerId: id, count: m.size });
    }
    return out;
  },
}));
