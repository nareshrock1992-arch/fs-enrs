import { useMemo, useCallback, useState } from 'react';
import { useConfigChangesStore } from '../stores/configChangesStore.js';
import ConfigSection  from '../ConfigSection.jsx';
import ConfigFilters  from '../ConfigFilters.jsx';
import DetailsPanel   from '../DetailsPanel.jsx';
import {
  isVisible,
  shouldShow,
  getSearchText,
} from '../utils/metadataUtils.js';

/**
 * FlatRenderer — 3-pane layout for flat key-value configuration providers.
 *
 * Renders: [filter sidebar] [grouped entry list] [detail panel].
 * Manages its own search/filter/selection state; changes flow through
 * configChangesStore (flat slice).
 *
 * Used by ConfigPage when docType === 'flat' (the default).
 * Reused by vars, switch-core, event-socket, acl, sip-profiles, conference,
 * and all future flat providers without modification.
 */
export default function FlatRenderer({ providerId, entries, deploying }) {
  const { getChanges, setChange, revertKey } = useConfigChangesStore();
  const pending = getChanges(providerId);

  const [search,          setSearch]          = useState('');
  const [visibilityLevel, setVisibilityLevel] = useState('advanced');
  const [category,        setCategory]        = useState('All');
  const [selectedKey,     setSelectedKey]     = useState(null);

  const handleChange    = useCallback(c  => setChange(providerId, c),    [setChange, providerId]);
  const handleRevertKey = useCallback(k  => revertKey(providerId, k),    [revertKey, providerId]);
  const handleSelect    = useCallback(k  => setSelectedKey(s => s === k ? null : k), []);

  const currentValues = useMemo(() => {
    const map = {};
    for (const entry of entries) {
      const pc = pending.get(entry.key);
      map[entry.key] = pc?.value !== undefined ? pc.value : (entry.value ?? '');
    }
    return map;
  }, [entries, pending]);

  const categories = useMemo(() => {
    const cats = new Set(entries.map(e => (e.metadata ?? e).category).filter(Boolean));
    return ['All', ...cats];
  }, [entries]);

  const filtered = useMemo(() => {
    const q = search.toLowerCase();
    return entries.filter(e => {
      if (!isVisible(e, visibilityLevel))    return false;
      if (!shouldShow(e, currentValues))     return false;
      const meta = e.metadata ?? e;
      if (category !== 'All' && meta.category !== category) return false;
      if (q && !getSearchText(e).includes(q)) return false;
      return true;
    });
  }, [entries, visibilityLevel, category, search, currentValues]);

  const selectedEntry = useMemo(
    () => entries.find(e => e.key === selectedKey) ?? null,
    [entries, selectedKey]
  );

  return (
    <div className="flex gap-4 items-start">

      {/* Left: filter sidebar — visible xl+ */}
      <div className="hidden xl:block w-48 shrink-0">
        <ConfigFilters
          search={search}
          onSearchChange={setSearch}
          visibilityLevel={visibilityLevel}
          onVisibilityChange={setVisibilityLevel}
          category={category}
          onCategoryChange={setCategory}
          categories={categories}
        />
      </div>

      {/* Center: compact filters (mobile) + grouped entry list */}
      <div className="flex-1 min-w-0 space-y-3">
        <div className="xl:hidden">
          <ConfigFilters
            search={search}
            onSearchChange={setSearch}
            visibilityLevel={visibilityLevel}
            onVisibilityChange={setVisibilityLevel}
            category={category}
            onCategoryChange={setCategory}
            categories={categories}
            compact
          />
        </div>

        <ConfigSection
          entries={filtered}
          pending={pending}
          onChange={handleChange}
          onRevert={handleRevertKey}
          selectedKey={selectedKey}
          onSelect={handleSelect}
          disabled={deploying}
        />
      </div>

      {/* Right: detail panel — xl+ only, when an entry is selected */}
      {selectedKey && (
        <div className="hidden xl:block w-72 shrink-0">
          <DetailsPanel entry={selectedEntry} />
        </div>
      )}
    </div>
  );
}
