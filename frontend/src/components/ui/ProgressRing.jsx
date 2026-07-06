/**
 * SVG circular progress ring.
 *
 * Props:
 *   value      0–100 (percentage filled)
 *   size       diameter in px (default 56)
 *   stroke     ring thickness (default 5)
 *   color      stroke color (default 'rgb(99 102 241)')
 *   trackColor track color (default 'rgba(128,128,128,0.15)')
 *   children   centre label (optional)
 */
export default function ProgressRing({
  value = 0,
  size = 56,
  stroke = 5,
  color = 'rgb(99 102 241)',
  trackColor = 'rgba(128,128,128,0.15)',
  children,
}) {
  const r = (size - stroke) / 2;
  const circ = 2 * Math.PI * r;
  const offset = circ - (Math.min(100, Math.max(0, value)) / 100) * circ;

  return (
    <div className="relative inline-flex items-center justify-center" style={{ width: size, height: size }}>
      <svg width={size} height={size} style={{ transform: 'rotate(-90deg)' }}>
        <circle cx={size / 2} cy={size / 2} r={r}
          fill="none" stroke={trackColor} strokeWidth={stroke} />
        <circle cx={size / 2} cy={size / 2} r={r}
          fill="none" stroke={color} strokeWidth={stroke}
          strokeDasharray={circ} strokeDashoffset={offset}
          strokeLinecap="round"
          style={{ transition: 'stroke-dashoffset 0.4s ease' }} />
      </svg>
      {children && (
        <div className="absolute inset-0 flex items-center justify-center">
          {children}
        </div>
      )}
    </div>
  );
}
