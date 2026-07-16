/**
 * IncidentCardSkeleton — loading placeholder while incidents are being fetched.
 */
export function IncidentCardSkeleton() {
  return (
    <div className="rounded-xl border border-surface-border bg-surface-card overflow-hidden animate-pulse">
      <div className="h-0.5 w-full bg-surface-hover" />
      <div className="p-3 space-y-2">
        <div className="flex items-start gap-2">
          <div className="w-6 h-4 rounded bg-surface-hover shrink-0" />
          <div className="flex-1 space-y-1">
            <div className="h-3 bg-surface-hover rounded w-3/4" />
            <div className="h-2.5 bg-surface-hover rounded w-1/2" />
          </div>
        </div>
        <div className="h-2.5 bg-surface-hover rounded w-2/3" />
        <div className="h-2.5 bg-surface-hover rounded w-1/2" />
        <div className="h-2.5 bg-surface-hover rounded w-1/3" />
        <div className="pt-1.5 border-t border-surface-border/30 flex justify-between">
          <div className="h-2.5 bg-surface-hover rounded w-10" />
          <div className="h-2.5 bg-surface-hover rounded w-16" />
        </div>
      </div>
    </div>
  );
}
