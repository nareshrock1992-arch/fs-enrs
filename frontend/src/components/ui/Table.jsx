export function Table({ children, className = '' }) {
  return (
    <div className={`overflow-x-auto rounded-xl border border-surface-border ${className}`}>
      <table className="w-full text-sm border-collapse">{children}</table>
    </div>
  );
}

export function Th({ children, className = '' }) {
  return (
    <th className={`table-head ${className}`}>{children}</th>
  );
}

export function Td({ children, className = '' }) {
  return (
    <td className={`table-cell ${className}`}>{children}</td>
  );
}

export function Tr({ children, onClick, className = '' }) {
  return (
    <tr
      onClick={onClick}
      className={`table-row hover:bg-surface-hover transition-colors duration-100
                  ${onClick ? 'cursor-pointer' : ''} ${className}`}
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
