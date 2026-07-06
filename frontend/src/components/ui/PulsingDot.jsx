/**
 * Animated status indicator dot.
 *
 * Props:
 *   active   boolean — green + pulse when true, red when false
 *   size     'sm' | 'md' (default 'md')
 */
export default function PulsingDot({ active = false, size = 'md' }) {
  const dim = size === 'sm' ? 'w-2 h-2' : 'w-2.5 h-2.5';
  if (!active) {
    return <span className={`${dim} rounded-full bg-red-500 inline-block`} />;
  }
  return (
    <span className="relative inline-flex">
      <span className={`${dim} rounded-full bg-green-500 inline-block`} />
      <span className={`animate-ping absolute inline-flex ${dim} rounded-full bg-green-400 opacity-75`} />
    </span>
  );
}
