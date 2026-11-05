import { useEffect, useRef, useState } from 'react';
import { Columns3 } from 'lucide-react';

// "Columns" menu: one checkbox per optional column. Closes on Escape or a click outside.
export default function ColumnChooser({ columns, selected, onToggle, onReset }) {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);

  useEffect(() => {
    if (!open) return undefined;
    const onDown = (e) => { if (ref.current && !ref.current.contains(e.target)) setOpen(false); };
    const onKey  = (e) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('mousedown', onDown); document.removeEventListener('keydown', onKey); };
  }, [open]);

  return (
    <div className="relative" ref={ref}>
      <button type="button" className="btn-secondary btn-sm" aria-haspopup="true" aria-expanded={open}
              onClick={() => setOpen(o => !o)}>
        <Columns3 size={13} aria-hidden="true" /> Columns
      </button>
      {open && (
        <div role="group" aria-label="Visible columns"
             className="absolute right-0 z-20 mt-1 w-48 rounded-xl border border-surface-border bg-surface-panel p-2 shadow-lg">
          {columns.map(c => (
            <label key={c.key} className="flex items-center gap-2 px-2 py-1 rounded-lg text-xs hover:bg-surface-hover cursor-pointer">
              <input type="checkbox" checked={selected.includes(c.key)} onChange={() => onToggle(c.key)} />
              {c.label}
            </label>
          ))}
          <button type="button" className="btn-ghost btn-sm w-full mt-1" onClick={onReset}>Reset to default</button>
        </div>
      )}
    </div>
  );
}
