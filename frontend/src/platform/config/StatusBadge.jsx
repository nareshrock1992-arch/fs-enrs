/**
 * StatusBadge — consistent risk/health status chip.
 *
 * Props:
 *  status  — 'low'|'medium'|'high'|'healthy'|'degraded'|'unhealthy'|'ok'|'warn'|'fail'
 *  label   — override display text (defaults to status)
 *  size    — 'xs' (default) | 'sm'
 */

const STYLES = {
  low:       'bg-emerald-100 dark:bg-emerald-900/40 text-emerald-700 dark:text-emerald-300',
  ok:        'bg-emerald-100 dark:bg-emerald-900/40 text-emerald-700 dark:text-emerald-300',
  healthy:   'bg-emerald-100 dark:bg-emerald-900/40 text-emerald-700 dark:text-emerald-300',
  medium:    'bg-amber-100  dark:bg-amber-900/40  text-amber-700  dark:text-amber-300',
  warn:      'bg-amber-100  dark:bg-amber-900/40  text-amber-700  dark:text-amber-300',
  degraded:  'bg-amber-100  dark:bg-amber-900/40  text-amber-700  dark:text-amber-300',
  high:      'bg-red-100    dark:bg-red-900/40    text-red-700    dark:text-red-300',
  fail:      'bg-red-100    dark:bg-red-900/40    text-red-700    dark:text-red-300',
  unhealthy: 'bg-red-100    dark:bg-red-900/40    text-red-700    dark:text-red-300',
};

const DEFAULT_STYLE = 'bg-surface-border text-text-muted';

export default function StatusBadge({ status, label, size = 'xs' }) {
  const style = STYLES[status] ?? DEFAULT_STYLE;
  const text  = label ?? status ?? '—';
  const sizeClass = size === 'sm'
    ? 'text-xs px-2.5 py-1'
    : 'text-[10px] px-2 py-0.5';

  return (
    <span className={`inline-flex items-center rounded-full font-semibold uppercase
                      tracking-wide ${sizeClass} ${style}`}>
      {text}
    </span>
  );
}
