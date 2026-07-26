import { create } from 'zustand';

/**
 * configChangesStore — cross-provider pending change tracking.
 *
 * Supports two modes in a single store:
 *
 * FLAT MODE  (existing flat providers: vars, switch, acl, gateways, …)
 *   Maps providerId → Map<key, changeObject>.
 *   API: getChanges / setChange / revertKey
 *
 * ORDERED MODE  (hierarchical providers: dialplan, directory, IVR, call center, …)
 *   Maps providerId → { ops: ChangeOperation[], pointer: number }.
 *   API: getOps / appendOp / undoLast / redoNext / canUndo / canRedo
 *
 * The two modes are completely isolated:
 *  - Flat providers never call ordered-mode selectors.
 *  - Hierarchical providers never call flat-mode selectors.
 *  - clearProvider / totalPending / providerCounts handle both.
 *
 * Flat-mode consumers (ConfigPage and all existing pages) are unaffected —
 * every existing method signature, return type, and behavior is preserved.
 */

// ── Flat-mode sentinel ─────────────────────────────────────────────────────────
// Stable empty map — returned by getChanges when a provider has no pending changes.
// Singleton avoids creating a new Map() on every render, which would cause
// currentValues and filtered to recompute unnecessarily on each render pass.
const EMPTY_MAP = new Map();

// ── Ordered-mode sentinel ──────────────────────────────────────────────────────
// Frozen empty array — returned by getOps when a provider has no active ops.
const EMPTY_OPS = Object.freeze([]);

export const useConfigChangesStore = create((set, get) => ({

  // ── Flat-mode state ───────────────────────────────────────────────────────────
  // Map<providerId → Map<key, change>>
  _changes: new Map(),

  // ── Ordered-mode state ────────────────────────────────────────────────────────
  // Map<providerId → { ops: ChangeOperation[], pointer: number }>
  //
  // ops     — full list of operations including undone ones
  // pointer — index of the last ACTIVE operation; -1 means no active ops
  //
  // Active ops: ops.slice(0, pointer + 1)
  // Undone ops: ops.slice(pointer + 1)   ← available for redo
  _ops: new Map(),

  // ── Flat-mode API (existing — unchanged) ─────────────────────────────────────

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

  // ── Ordered-mode API (new — hierarchical providers only) ─────────────────────

  /**
   * Return the active change operations for a hierarchical provider.
   * Active = ops[0..pointer+1]. Returns a frozen empty array if none.
   *
   * @param {string} providerId
   * @returns {ChangeOperation[]}
   */
  getOps(providerId) {
    const entry = get()._ops.get(providerId);
    if (!entry || entry.pointer < 0) return EMPTY_OPS;
    return entry.ops.slice(0, entry.pointer + 1);
  },

  /**
   * Append a new change operation. Discards any redoable operations that
   * existed after the current pointer (standard linear undo model).
   *
   * @param {string}          providerId
   * @param {ChangeOperation} op  — plain JSON object with at minimum { op: string }
   */
  appendOp(providerId, op) {
    set(state => {
      const next  = new Map(state._ops);
      const entry = next.get(providerId) ?? { ops: [], pointer: -1 };
      const active = entry.ops.slice(0, entry.pointer + 1);
      const ops    = [...active, op];
      next.set(providerId, { ops, pointer: ops.length - 1 });
      return { _ops: next };
    });
  },

  /**
   * Undo the last active operation.
   * @param {string} providerId
   * @returns {ChangeOperation | null} the undone op, or null
   */
  undoLast(providerId) {
    let undone = null;
    set(state => {
      const next  = new Map(state._ops);
      const entry = next.get(providerId);
      if (!entry || entry.pointer < 0) return state;
      undone = entry.ops[entry.pointer];
      next.set(providerId, { ...entry, pointer: entry.pointer - 1 });
      return { _ops: next };
    });
    return undone;
  },

  /**
   * Redo the next undone operation.
   * @param {string} providerId
   * @returns {ChangeOperation | null} the redone op, or null
   */
  redoNext(providerId) {
    let redone = null;
    set(state => {
      const next  = new Map(state._ops);
      const entry = next.get(providerId);
      if (!entry || entry.pointer >= entry.ops.length - 1) return state;
      const newPointer = entry.pointer + 1;
      redone = entry.ops[newPointer];
      next.set(providerId, { ...entry, pointer: newPointer });
      return { _ops: next };
    });
    return redone;
  },

  /** True if there is at least one active operation that can be undone. */
  canUndo(providerId) {
    const entry = get()._ops.get(providerId);
    return !!entry && entry.pointer >= 0;
  },

  /** True if there is at least one undone operation that can be redone. */
  canRedo(providerId) {
    const entry = get()._ops.get(providerId);
    return !!entry && entry.pointer < entry.ops.length - 1;
  },

  // ── Shared API (handles both modes) ──────────────────────────────────────────

  /**
   * Clear all pending changes for a provider (called after deploy or discard).
   * Clears both flat changes and ordered ops for the provider.
   * For flat providers: _ops.delete is a no-op (never written to).
   * For hierarchical providers: _changes.delete is a no-op (never written to).
   */
  clearProvider(providerId) {
    set(state => {
      const nextChanges = new Map(state._changes);
      nextChanges.delete(providerId);
      const nextOps = new Map(state._ops);
      nextOps.delete(providerId);
      return { _changes: nextChanges, _ops: nextOps };
    });
  },

  /**
   * Total pending change count across all providers (both modes).
   * For flat providers: counts entries in the key-map.
   * For hierarchical providers: counts active ops (ops[0..pointer+1]).
   */
  totalPending() {
    let total = 0;
    for (const m of get()._changes.values()) total += m.size;
    for (const entry of get()._ops.values()) {
      if (entry.pointer >= 0) total += entry.pointer + 1;
    }
    return total;
  },

  /**
   * Per-provider pending count summary [{ providerId, count }].
   * Includes both flat and hierarchical providers with pending changes.
   */
  providerCounts() {
    const out = [];
    for (const [id, m] of get()._changes.entries()) {
      if (m.size > 0) out.push({ providerId: id, count: m.size });
    }
    for (const [id, entry] of get()._ops.entries()) {
      const count = entry.pointer + 1;
      if (count > 0) out.push({ providerId: id, count });
    }
    return out;
  },
}));
