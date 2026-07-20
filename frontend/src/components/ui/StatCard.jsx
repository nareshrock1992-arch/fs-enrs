import { TrendingUp, TrendingDown, Minus } from 'lucide-react';

const COLOR_MAP = {
  brand:  { bg: 'bg-brand/10',       text: 'text-brand',          border: 'border-brand/20' },
  green:  { bg: 'bg-green-500/10',   text: 'text-green-600 dark:text-green-400',  border: 'border-green-500/20' },
  yellow: { bg: 'bg-yellow-500/10',  text: 'text-yellow-600 dark:text-yellow-400', border: 'border-yellow-500/20' },
  red:    { bg: 'bg-red-500/10',     text: 'text-red-600 dark:text-red-400',    border: 'border-red-500/20' },
  blue:   { bg: 'bg-blue-500/10',    text: 'text-blue-600 dark:text-blue-400',   border: 'border-blue-500/20' },
  purple: { bg: 'bg-purple-500/10',  text: 'text-purple-600 dark:text-purple-400', border: 'border-purple-500/20' },
  orange: { bg: 'bg-orange-500/10',  text: 'text-orange-600 dark:text-orange-400', border: 'border-orange-500/20' },
  teal:   { bg: 'bg-teal-500/10',    text: 'text-teal-600 dark:text-teal-400',  border: 'border-teal-500/20' },
};

export default function StatCard({
  label,
  value,
  sub,
  icon: Icon,
  color = 'brand',
  trend,       // 'up' | 'down' | 'flat'
  trendValue,  // e.g. '+12%'
  trendGood,   // true if 'up' is good (default), false if 'up' is bad
  loading = false,
}) {
  const c = COLOR_MAP[color] || COLOR_MAP.brand;

  const TrendIcon = trend === 'up' ? TrendingUp : trend === 'down' ? TrendingDown : Minus;
  const trendIsPositive = trendGood === false
    ? trend === 'down'
    : trend === 'up';
  const trendColor = !trend || trend === 'flat'
    ? 'text-text-muted'
    : trendIsPositive
      ? 'text-green-600 dark:text-green-400'
      : 'text-red-600 dark:text-red-400';

  if (loading) {
    return (
      <div className="card flex items-start gap-4 p-5">
        <div className="w-10 h-10 rounded-xl skeleton shrink-0" />
        <div className="flex-1 space-y-2 pt-1">
          <div className="skeleton-sm w-20" />
          <div className="skeleton h-7 w-12" />
          <div className="skeleton-sm w-28" />
        </div>
      </div>
    );
  }

  return (
    <div className="card flex items-start gap-4 p-5 group hover:border-brand/25 transition-colors duration-150">
      {Icon && (
        <div className={`w-10 h-10 rounded-xl border flex items-center justify-center shrink-0
                         ${c.bg} ${c.text} ${c.border}`}>
          <Icon size={18} strokeWidth={2} />
        </div>
      )}
      <div className="min-w-0 flex-1">
        <p className="text-[11px] font-semibold uppercase tracking-wider text-text-muted truncate">
          {label}
        </p>
        <p className="text-2xl font-bold text-text-primary leading-tight tabular-nums mt-0.5">
          {value ?? '—'}
        </p>
        <div className="flex items-center gap-2 mt-1">
          {sub && <p className="text-xs text-text-muted truncate">{sub}</p>}
          {trend && trendValue && (
            <span className={`inline-flex items-center gap-0.5 text-[11px] font-semibold ${trendColor} ml-auto shrink-0`}>
              <TrendIcon size={11} />
              {trendValue}
            </span>
          )}
        </div>
      </div>
    </div>
  );
}
