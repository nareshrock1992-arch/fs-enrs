import { useState, useMemo, useEffect } from 'react';
import { ChevronDown, ChevronRight } from 'lucide-react';
import { groupByHierarchy, UNGROUPED } from './utils/metadataUtils.js';
import ConfigCard from './ConfigCard.jsx';
import { diagL3Grouped, diagL4Toggle, diagL5Summary, diagL6DomAndCss } from './__configDiag.js';

/**
 * ConfigSection — grouped accordion list of configuration entries.
 *
 * Groups entries by category → group using groupByHierarchy(), then renders
 * collapsible category sections with optional group sub-headers.
 *
 * When only one category is present (e.g. after filtering), the accordion
 * wrapper is skipped and entries render as a flat list.
 *
 * Props:
 *   entries    — filtered ConfigurationObject[] to render
 *   pending    — Map<key, pendingChange> from configChangesStore
 *   onChange   — fn({ key, op, value, enabled })
 *   onRevert   — fn(key)
 *   selectedKey — currently selected entry key (for DetailsPanel)
 *   onSelect   — fn(key) — called when a card is clicked
 *   disabled   — disables all inputs when true (during deploy)
 */
export default function ConfigSection({
  entries,
  pending,
  onChange,
  onRevert,
  selectedKey,
  onSelect,
  disabled,
}) {
  const grouped    = useMemo(() => groupByHierarchy(entries), [entries]);
  const categories = Object.keys(grouped);
  // DIAG L3
  diagL3Grouped(grouped, categories);

  // All sections start collapsed. Click to expand (standard accordion UX).
  // Previously used collapsed={} where !collapsed[cat]=!undefined=true (always
  // open), which meant clicking a ChevronDown header closed sections — exactly
  // the opposite of what users expect.
  const [expanded, setExpanded] = useState(new Set());

  // DIAG L5 + L6: after every expand/collapse, report card count and inspect DOM
  useEffect(() => {
    diagL5Summary();
    if (expanded.size > 0) diagL6DomAndCss();
  }, [expanded]);

  const toggleCategory = (cat) => {
    setExpanded(prev => {
      const next = new Set(prev);
      if (next.has(cat)) next.delete(cat); else next.add(cat);
      // DIAG L4
      diagL4Toggle(cat, [...next]);
      return next;
    });
  };

  if (entries.length === 0) {
    return (
      <p className="text-sm text-text-muted italic py-8 text-center">
        No variables match your filter.
      </p>
    );
  }

  // Single category: skip accordion chrome, render flat
  if (categories.length === 1) {
    const groups = grouped[categories[0]];
    return (
      <div className="space-y-2">
        {Object.entries(groups).flatMap(([group, groupEntries]) =>
          groupEntries.map(entry => (
            <EntryRow
              key={entry.key}
              entry={entry}
              pending={pending}
              onChange={onChange}
              onRevert={onRevert}
              selectedKey={selectedKey}
              onSelect={onSelect}
              disabled={disabled}
            />
          ))
        )}
      </div>
    );
  }

  // Multiple categories: collapsible accordion per category
  return (
    <div className="space-y-2" data-cfg-section>
      {categories.map(cat => {
        const groups     = grouped[cat];
        const allEntries = Object.values(groups).flat();
        const dirtyCount = allEntries.filter(e => pending.has(e.key)).length;
        const isOpen     = expanded.has(cat);

        return (
          <div key={cat} className="rounded-xl border border-surface-border overflow-hidden">
            <button
              onClick={() => toggleCategory(cat)}
              className="w-full flex items-center justify-between px-4 py-3
                         bg-surface-panel hover:bg-surface-bg transition-colors text-left">
              <div className="flex items-center gap-2">
                {isOpen
                  ? <ChevronDown  size={14} className="text-text-muted shrink-0" />
                  : <ChevronRight size={14} className="text-text-muted shrink-0" />}
                <span className="text-sm font-semibold text-text-primary">{cat}</span>
                <span className="text-[10px] text-text-muted">({allEntries.length})</span>
              </div>
              {dirtyCount > 0 && (
                <span className="text-[10px] font-bold bg-brand/20 text-brand
                                 px-1.5 py-0.5 rounded-full shrink-0">
                  {dirtyCount} modified
                </span>
              )}
            </button>

            {isOpen && (
              <div className="border-t border-surface-border" data-cfg-accordion-body>
                {Object.entries(groups).map(([group, groupEntries]) => (
                  <div key={group}>
                    {group !== UNGROUPED && (
                      <p className="px-4 py-1.5 text-[10px] font-semibold uppercase tracking-widest
                                    text-text-muted bg-surface-bg/60 border-b border-surface-border/50">
                        {group}
                      </p>
                    )}
                    <div className="p-2 space-y-1">
                      {groupEntries.map(entry => (
                        <EntryRow
                          key={entry.key}
                          entry={entry}
                          pending={pending}
                          onChange={onChange}
                          onRevert={onRevert}
                          selectedKey={selectedKey}
                          onSelect={onSelect}
                          disabled={disabled}
                        />
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

function EntryRow({ entry, pending, onChange, onRevert, selectedKey, onSelect, disabled }) {
  const pendingChange = pending.get(entry.key);
  return (
    <div className="group relative">
      <ConfigCard
        entry={entry}
        pendingChange={pendingChange}
        onChange={onChange}
        disabled={disabled}
        onSelect={onSelect}
        isSelected={selectedKey === entry.key}
      />
      {pendingChange && (
        <button
          onClick={() => onRevert(entry.key)}
          className="absolute right-2 top-2 hidden group-hover:flex
                     items-center gap-0.5 text-text-muted hover:text-text-primary
                     text-xs px-1.5 py-0.5 rounded bg-surface-bg border border-surface-border">
          ↩ revert
        </button>
      )}
    </div>
  );
}
