export function Table({ children, className = '' }) {
  return (
    <div className={`overflow-x-auto rounded-xl border border-surface-border ${className}`}>
      <table className="w-full text-sm border-collapse">{children}</table>
    </div>
  );
}

export function Th({ children, className = '', ...rest }) {
  return (
    <th className={`table-head ${className}`} {...rest}>{children}</th>
  );
}

export function Td({ children, className = '', ...rest }) {
  return (
    <td className={`table-cell ${className}`} {...rest}>{children}</td>
  );
}

// A clickable row is also reachable and operable from the keyboard (Tab, Enter, Space).
export function Tr({ children, onClick, className = '', selected = false, label }) {
  const onKeyDown = onClick ? (e) => {
    if (e.target !== e.currentTarget) return;   // keys inside a cell's own controls are theirs
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onClick(e); }
  } : undefined;
  return (
    <tr
      onClick={onClick}
      onKeyDown={onKeyDown}
      tabIndex={onClick ? 0 : undefined}
      aria-selected={onClick ? selected : undefined}
      aria-label={label}
      className={`table-row hover:bg-surface-hover transition-colors duration-100
                  ${onClick ? 'cursor-pointer focus-visible:bg-surface-hover' : ''} ${selected ? 'bg-surface-hover' : ''} ${className}`}
    >
      {children}
    </tr>
  );
}

export function EmptyRow({ cols, message = 'No records found.' }) {
  return (
    <tr>
      <td colSpan={cols} className="py-12 text-center text-text-muted text-sm">
        {message}
      </td>
    </tr>
  );
}
