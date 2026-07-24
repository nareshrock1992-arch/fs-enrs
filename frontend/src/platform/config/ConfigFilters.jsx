import { Search } from 'lucide-react';

const VISIBILITY_LEVELS = [
  { id: 'basic',    label: 'Basic' },
  { id: 'advanced', label: 'Advanced' },
  { id: 'expert',   label: 'Expert' },
];

/**
 * ConfigFilters — filter controls for a configuration provider page.
 *
 * Renders search input, visibility level toggle, and category navigation.
 * In compact mode (mobile), renders as a horizontal row instead of a sidebar.
 *
 * Props:
 *   search            — current search string
 *   onSearchChange    — fn(string)
 *   visibilityLevel   — 'basic' | 'advanced' | 'expert'
 *   onVisibilityChange — fn(level)
 *   category          — currently selected category ('All' or category name)
 *   onCategoryChange  — fn(category)
 *   categories        — array of category strings including 'All'
 *   compact           — if true, render a mobile-friendly compact layout
 */
export default function ConfigFilters({
  search,
  onSearchChange,
  visibilityLevel,
  onVisibilityChange,
  category,
  onCategoryChange,
  categories,
  compact = false,
}) {
  return (
    <div className={compact ? 'flex flex-col gap-2' : 'space-y-4'}>

      {/* Search */}
      <div className="relative">
        <Search size={13} className="absolute left-3 top-1/2 -translate-y-1/2 text-text-muted pointer-events-none" />
        <input
          type="text"
          placeholder="Search variables…"
          value={search}
          onChange={e => onSearchChange(e.target.value)}
          className="w-full rounded-lg border border-surface-border bg-surface-panel
                     pl-8 pr-3 py-2 text-sm text-text-primary placeholder-text-muted
                     focus:outline-none focus:ring-2 focus:ring-brand/50"
        />
      </div>

      {/* Visibility toggle */}
      <div>
        {!compact && (
          <p className="text-[10px] font-semibold uppercase tracking-widest text-text-muted mb-1.5 px-1">
            Complexity
          </p>
        )}
        <div className="flex rounded-lg border border-surface-border overflow-hidden">
          {VISIBILITY_LEVELS.map(({ id, label }) => (
            <button
              key={id}
              onClick={() => onVisibilityChange(id)}
              title={`Show ${label.toLowerCase()} variables`}
              className={`flex-1 py-1.5 text-xs font-medium transition-colors
                ${visibilityLevel === id
                  ? 'bg-brand text-white'
                  : 'bg-surface-panel text-text-muted hover:bg-surface-bg'}`}>
              {label}
            </button>
          ))}
        </div>
      </div>

      {/* Category navigation */}
      <div>
        {!compact && (
          <p className="text-[10px] font-semibold uppercase tracking-widest text-text-muted mb-1.5 px-1">
            Category
          </p>
        )}
        {compact ? (
          <div className="flex flex-wrap gap-1">
            {categories.map(cat => (
              <button
                key={cat}
                onClick={() => onCategoryChange(cat)}
                className={`px-2.5 py-1 rounded-full text-xs transition-colors
                  ${category === cat
                    ? 'bg-brand/10 text-brand font-semibold'
                    : 'text-text-muted bg-surface-border hover:bg-surface-bg hover:text-text-primary'}`}>
                {cat}
              </button>
            ))}
          </div>
        ) : (
          <div className="space-y-0.5">
            {categories.map(cat => (
              <button
                key={cat}
                onClick={() => onCategoryChange(cat)}
                className={`w-full text-left px-3 py-1.5 rounded-lg text-xs transition-colors
                  ${category === cat
                    ? 'bg-brand/10 text-brand font-semibold'
                    : 'text-text-muted hover:bg-surface-bg hover:text-text-primary'}`}>
                {cat}
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
