import { useEffect, useState } from 'react';
import { Phone, Link, Unlink } from 'lucide-react';
import Modal from '../../ui/Modal.jsx';
import { api } from '../../../api/client.js';

export default function BindNumbersModal({ flowUuid, flowName, boundNumbers, onClose, onChanged }) {
  const [allNumbers, setAllNumbers] = useState([]);
  const [loading,    setLoading]    = useState(true);
  const [busy,       setBusy]       = useState(null); // id being processed

  const boundIds = new Set((boundNumbers || []).map(n => n.id));

  useEffect(() => {
    // Fetch all emergency numbers for this tenant
    api.settings.emergencyNumbers()
      .then(r => setAllNumbers(r.numbers || []))
      .catch(() => setAllNumbers([]))
      .finally(() => setLoading(false));
  }, []);

  async function toggle(num) {
    setBusy(num.id);
    try {
      if (boundIds.has(num.id)) {
        await api.ivr.unbind(flowUuid, num.id);
      } else {
        await api.ivr.bind(flowUuid, num.id);
      }
      onChanged?.();
    } catch (e) {
      console.error(e);
    } finally {
      setBusy(null);
    }
  }

  return (
    <Modal title={`Bind Numbers — ${flowName}`} onClose={onClose} size="md">
      <p className="text-xs text-text-muted mb-4">
        Select which emergency numbers route through this IVR flow.
        Inbound calls to bound numbers will execute this flow on FreeSWITCH.
      </p>

      {loading && <p className="text-xs text-text-muted py-4 text-center">Loading numbers…</p>}

      {!loading && allNumbers.length === 0 && (
        <div className="text-center py-6">
          <Phone size={24} className="mx-auto text-text-muted mb-2" />
          <p className="text-xs text-text-muted">No emergency numbers configured</p>
          <p className="text-[10px] text-text-muted mt-1">Add numbers in Settings → Emergency Numbers</p>
        </div>
      )}

      <div className="space-y-2">
        {allNumbers.map(num => {
          const isBound  = boundIds.has(num.id);
          const isBusy   = busy === num.id;
          return (
            <div key={num.id}
                 className={`flex items-center gap-3 px-3 py-2.5 rounded-xl border transition-colors
                   ${isBound
                     ? 'bg-brand/10 border-brand/30'
                     : 'bg-surface border-surface-border hover:bg-surface-hover'}`}>
              <Phone size={13} className={isBound ? 'text-brand' : 'text-text-muted'} />
              <div className="flex-1 min-w-0">
                <p className="text-xs font-mono font-medium text-text-primary">{num.number}</p>
                <p className="text-[10px] text-text-muted">{num.type}</p>
              </div>
              <button
                onClick={() => toggle(num)}
                disabled={isBusy}
                className={`flex items-center gap-1 text-[11px] px-2.5 py-1 rounded-lg border
                            font-medium transition-colors
                  ${isBound
                    ? 'bg-red-500/10 text-red-400 border-red-500/20 hover:bg-red-500/20'
                    : 'bg-brand/10 text-brand border-brand/20 hover:bg-brand/20'}
                  ${isBusy ? 'opacity-50 cursor-wait' : ''}`}
              >
                {isBusy
                  ? '…'
                  : isBound
                  ? <><Unlink size={10} /> Unbind</>
                  : <><Link size={10} /> Bind</>}
              </button>
            </div>
          );
        })}
      </div>
    </Modal>
  );
}
