import { RotateCcw, Zap } from 'lucide-react';

/**
 * ChangesBar — sticky banner shown when there are unsaved changes.
 *
 * Props:
 *  count      — number of pending changes
 *  previewing — boolean, disable button while fetching preview
 *  deploying  — boolean, disable button during deploy
 *  onDeploy   — fn() triggered when Deploy is clicked
 *  onDiscard  — fn() discards all pending changes
 */
export default function ChangesBar({ count, previewing, deploying, onDeploy, onDiscard }) {
  if (!count) return null;

  return (
    <div className="sticky top-0 z-30 -mx-4 md:-mx-6 px-4 md:px-6 py-2.5
                    bg-amber-50 dark:bg-amber-950
                    border-b border-amber-200 dark:border-amber-800
                    flex items-center gap-3">
      <span className="flex items-center gap-1.5 text-xs font-semibold
                       text-amber-700 dark:text-amber-300">
        <span className="w-2 h-2 rounded-full bg-amber-500 animate-pulse" />
        {count} unsaved {count === 1 ? 'change' : 'changes'}
      </span>
      <div className="ml-auto flex items-center gap-2">
        <button
          onClick={onDiscard}
          className="btn-ghost flex items-center gap-1 text-xs px-3 py-1.5 rounded-lg
                     text-amber-700 dark:text-amber-300 hover:bg-amber-100 dark:hover:bg-amber-900">
          <RotateCcw size={12} />
          Discard
        </button>
        <button
          onClick={onDeploy}
          disabled={previewing || deploying}
          className="flex items-center gap-1.5 text-xs font-semibold px-3 py-1.5
                     rounded-lg bg-brand text-white hover:bg-brand/90
                     disabled:opacity-40 disabled:cursor-not-allowed transition-colors">
          <Zap size={12} />
          Review &amp; Deploy
        </button>
      </div>
    </div>
  );
}
