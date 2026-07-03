import { useEffect, useState } from 'react';
import { Save, Wifi, WifiOff, ToggleLeft, ToggleRight } from 'lucide-react';
import { api } from '../../api/client.js';
import Badge from '../../components/ui/Badge.jsx';

export default function SettingsPage() {
  const [settings, setSettings] = useState([]);
  const [flags,    setFlags]    = useState([]);
  const [esl,      setEsl]      = useState(null);
  const [vals,     setVals]     = useState({});
  const [saving,   setSaving]   = useState(null);

  async function load() {
    try {
      const [s, f, e] = await Promise.all([
        api.settings.list(),
        api.settings.flags(),
        api.settings.eslStatus(),
      ]);
      setSettings(s.settings || []);
      setFlags(f.flags || []);
      setEsl(e);
      const init = {};
      (s.settings || []).forEach(x => { init[x.key] = x.value; });
      setVals(init);
    } catch {}
  }
  useEffect(() => { load(); }, []);

  async function saveSetting(key) {
    setSaving(key);
    try { await api.settings.update(key, vals[key]); } catch (e) { alert(e.message); } finally { setSaving(null); }
  }

  async function toggleFlag(key, cur) {
    try { await api.settings.setFlag(key, !cur); load(); } catch (e) { alert(e.message); }
  }

  return (
    <div className="space-y-6 max-w-2xl">
      <h1 className="text-xl font-bold text-text-primary">Settings</h1>

      {/* ESL Status */}
      <div className="card flex items-center gap-4">
        <div className={`w-10 h-10 rounded-xl flex items-center justify-center
          ${esl?.connected ? 'bg-green-500/15 text-green-500' : 'bg-red-500/15 text-red-500'}`}>
          {esl?.connected ? <Wifi size={18} /> : <WifiOff size={18} />}
        </div>
        <div className="flex-1">
          <p className="text-sm font-semibold text-text-primary">FreeSWITCH ESL</p>
          <p className="text-xs text-text-muted">{esl?.host}:{esl?.port}</p>
        </div>
        <Badge variant={esl?.connected ? 'success' : 'danger'}>
          {esl?.connected ? 'Connected' : 'Disconnected'}
        </Badge>
      </div>

      {/* System Settings */}
      {settings.length > 0 && (
        <div className="card space-y-4">
          <h2 className="font-semibold text-text-primary text-sm">System Settings</h2>
          {settings.map(s => (
            <div key={s.key} className="flex items-end gap-3">
              <div className="flex-1 min-w-0">
                <label className="label">{s.key.replace(/_/g, ' ')}</label>
                <input className="input" value={vals[s.key] ?? ''} onChange={e => setVals(p => ({ ...p, [s.key]: e.target.value }))} />
              </div>
              <button onClick={() => saveSetting(s.key)} disabled={saving === s.key}
                      className="btn-primary flex items-center gap-1.5 shrink-0">
                <Save size={13} />{saving === s.key ? '…' : 'Save'}
              </button>
            </div>
          ))}
        </div>
      )}

      {/* Feature Flags */}
      {flags.length > 0 && (
        <div className="card space-y-3">
          <h2 className="font-semibold text-text-primary text-sm">Feature Flags</h2>
          {flags.map(fl => (
            <div key={fl.key} className="flex items-center justify-between py-2
                                          border-b border-surface-border last:border-0">
              <div>
                <p className="text-sm font-medium text-text-primary">{fl.key.replace(/_/g, ' ')}</p>
                {fl.description && <p className="text-xs text-text-muted">{fl.description}</p>}
              </div>
              <button onClick={() => toggleFlag(fl.key, fl.is_enabled)} className="btn-ghost p-1">
                {fl.is_enabled
                  ? <ToggleRight size={22} className="text-green-500" />
                  : <ToggleLeft size={22} className="text-text-muted" />}
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
