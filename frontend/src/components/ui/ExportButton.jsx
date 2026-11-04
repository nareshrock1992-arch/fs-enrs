import { useState } from 'react';
import { Download } from 'lucide-react';

// Runs an export that returns a Blob and saves it. Shows progress and failures in place.
export default function ExportButton({ run, filename, label = 'Export to Excel', disabled = false }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  async function exportFile() {
    setBusy(true);
    setError(null);
    try {
      const url = URL.createObjectURL(await run());
      const a = document.createElement('a');
      a.href = url;
      a.download = filename;
      a.click();
      URL.revokeObjectURL(url);
    } catch (e) {
      setError(e.message || 'The export failed.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <span className="inline-flex items-center gap-2">
      {error && <span className="text-xs text-red-500 max-w-xs" role="alert">{error}</span>}
      <button type="button" onClick={exportFile} disabled={busy || disabled} className="btn-secondary btn-sm">
        <Download size={12} />
        {busy ? 'Preparing…' : label}
      </button>
    </span>
  );
}
