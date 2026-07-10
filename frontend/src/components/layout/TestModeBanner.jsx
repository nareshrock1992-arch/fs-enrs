import { useEffect, useState } from 'react';
import { AlertTriangle } from 'lucide-react';
import { api } from '../../api/client.js';

// Persistent, unmissable indicator shown to EVERY authenticated role
// (not just admins) whenever Test Mode is enabled — it changes what a real
// call does (caller-ID override on flows marked as test flows), so anyone
// who could place or observe a test call needs to see it, not just the
// admin who flipped the switch in Settings.
export default function TestModeBanner() {
  const [state, setState] = useState(null);

  useEffect(() => {
    let cancelled = false;
    async function check() {
      try {
        const r = await api.settings.testMode();
        if (!cancelled) setState(r);
      } catch {
        if (!cancelled) setState(null);
      }
    }
    check();
    const id = setInterval(check, 30_000);
    return () => { cancelled = true; clearInterval(id); };
  }, []);

  if (!state?.enabled) return null;

  return (
    <div className="flex items-center justify-center gap-2 bg-amber-500 text-black text-xs font-bold
                    py-1.5 px-4 shrink-0">
      <AlertTriangle size={14} />
      TEST MODE ACTIVE — flows marked as test flows override caller ID (
      {state.caller_id}). Do not use in production.
    </div>
  );
}
