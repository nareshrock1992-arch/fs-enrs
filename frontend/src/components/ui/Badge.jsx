const variants = {
  default:  'bg-surface-border/50 text-text-secondary',
  success:  'bg-green-500/15 text-green-600 dark:text-green-400',
  warning:  'bg-yellow-500/15 text-yellow-600 dark:text-yellow-400',
  danger:   'bg-red-500/15 text-red-600 dark:text-red-400',
  info:     'bg-blue-500/15 text-blue-600 dark:text-blue-400',
  brand:    'bg-brand/15 text-brand',
};

export default function Badge({ children, variant = 'default', className = '' }) {
  return (
    <span className={`badge ${variants[variant]} ${className}`}>
      {children}
    </span>
  );
}

export function StatusBadge({ status }) {
  const map = {
    ACTIVE:     { label: 'Active',     v: 'success' },
    INACTIVE:   { label: 'Inactive',   v: 'default' },
    PENDING:    { label: 'Pending',    v: 'warning' },
    SENT:       { label: 'Sent',       v: 'info'    },
    FAILED:     { label: 'Failed',     v: 'danger'  },
    COMPLETED:  { label: 'Completed',  v: 'success' },
    QUEUED:     { label: 'Queued',     v: 'warning' },
    IN_PROGRESS:{ label: 'In Progress',v: 'brand'   },
    CANCELLED:  { label: 'Cancelled',  v: 'default' },
    ADMIN:      { label: 'Admin',      v: 'brand'   },
    OPERATOR:   { label: 'Operator',   v: 'info'    },
    VIEWER:     { label: 'Viewer',     v: 'default' },
  };
  const m = map[status] || { label: status, v: 'default' };
  return <Badge variant={m.v}>{m.label}</Badge>;
}
