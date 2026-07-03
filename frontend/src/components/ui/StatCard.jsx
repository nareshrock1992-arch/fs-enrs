export default function StatCard({ label, value, sub, icon: Icon, color = 'brand' }) {
  const colors = {
    brand:  'bg-brand/10 text-brand border-brand/20',
    green:  'bg-green-500/10 text-green-500 border-green-500/20',
    yellow: 'bg-yellow-500/10 text-yellow-500 border-yellow-500/20',
    red:    'bg-red-500/10 text-red-500 border-red-500/20',
    blue:   'bg-blue-500/10 text-blue-500 border-blue-500/20',
  };

  return (
    <div className="card flex items-start gap-4">
      {Icon && (
        <div className={`w-10 h-10 rounded-xl border flex items-center justify-center shrink-0 ${colors[color]}`}>
          <Icon size={18} />
        </div>
      )}
      <div className="min-w-0">
        <p className="text-xs text-text-muted uppercase tracking-wide truncate">{label}</p>
        <p className="text-2xl font-bold text-text-primary leading-tight">{value ?? '—'}</p>
        {sub && <p className="text-xs text-text-muted mt-0.5">{sub}</p>}
      </div>
    </div>
  );
}
