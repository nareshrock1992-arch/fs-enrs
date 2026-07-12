/**
 * Loading skeleton primitives.
 *
 * Usage:
 *   <Skeleton />              — single line
 *   <Skeleton h={48} />      — taller block
 *   <SkeletonCard />         — full card placeholder
 *   <SkeletonTable rows={5} /> — table rows
 */

export default function Skeleton({ h = 14, w, className = '' }) {
  return (
    <div
      className={`rounded animate-pulse bg-surface-raised ${className}`}
      style={{ height: h, width: w ?? '100%' }}
    />
  );
}

export function SkeletonCard({ lines = 3, className = '' }) {
  return (
    <div className={`card p-4 space-y-3 ${className}`}>
      <Skeleton h={16} w="60%" />
      {Array.from({ length: lines }).map((_, i) => (
        <Skeleton key={i} h={12} w={i === lines - 1 ? '40%' : '100%'} />
      ))}
    </div>
  );
}

export function SkeletonTable({ rows = 5, cols = 4 }) {
  return (
    <div className="space-y-1">
      {Array.from({ length: rows }).map((_, i) => (
        <div key={i} className="flex gap-4 px-4 py-3 border-b border-surface-border/60">
          {Array.from({ length: cols }).map((_, j) => (
            <Skeleton key={j} h={12} w={j === 0 ? '30%' : '20%'} />
          ))}
        </div>
      ))}
    </div>
  );
}
