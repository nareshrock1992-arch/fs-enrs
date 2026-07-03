export function Table({ children, className = '' }) {
  return (
    <div className={`overflow-x-auto rounded-lg border border-surface-border ${className}`}>
      <table className="w-full text-sm">{children}</table>
    </div>
  );
}

export function Th({ children, className = '' }) {
  return (
    <th className={`table-th ${className}`}>{children}</th>
  );
}

export function Td({ children, className = '' }) {
  return (
    <td className={`table-td ${className}`}>{children}</td>
  );
}

export function Tr({ children, onClick, className = '' }) {
  return (
    <tr
      onClick={onClick}
      className={`table-row border-b border-surface-border last:border-0
                  ${onClick ? 'cursor-pointer hover:bg-surface-hover' : ''} ${className}`}
    >
      {children}
    </tr>
  );
}

export function EmptyRow({ cols, message = 'No records found.' }) {
  return (
    <tr>
      <td colSpan={cols} className="py-10 text-center text-text-muted text-sm">
        {message}
      </td>
    </tr>
  );
}
