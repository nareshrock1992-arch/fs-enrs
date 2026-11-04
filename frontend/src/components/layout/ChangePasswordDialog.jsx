import { useState } from 'react';
import Modal from '../ui/Modal.jsx';
import { api } from '../../api/client.js';
import { notify } from '../ui/Toast.jsx';
import { passwordProblems } from './passwordRules.js';

// Self-service password change. The server applies the same rule and is authoritative;
// the checklist here only saves a round trip. A successful change replaces the
// account's refresh session (server side): other devices cannot renew theirs and must
// sign in again once their current access token expires; this one stays signed in.
export default function ChangePasswordDialog({ onClose }) {
  const [form, setForm] = useState({ current: '', next: '', confirm: '' });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const problems = passwordProblems(form.next);
  const mismatch = form.confirm !== '' && form.confirm !== form.next;
  const canSave = form.current && form.next && problems.length === 0 && form.confirm === form.next && !saving;
  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }));

  async function submit(e) {
    e.preventDefault();
    if (!canSave) return;
    setSaving(true); setError('');
    try {
      await api.changePassword(form.current, form.next);
      notify('Password changed. Other devices signed in to this account must sign in again.', 'success');
      onClose();
    } catch (err) {
      setError(err.message || 'Password could not be changed');
    } finally { setSaving(false); }
  }

  return (
    <Modal title="Change password" onClose={onClose} size="sm">
      <form onSubmit={submit} className="space-y-4" noValidate>
        <div>
          <label className="label" htmlFor="pw-current">Current password</label>
          <input id="pw-current" type="password" autoComplete="current-password" className="input" value={form.current} onChange={set('current')} autoFocus />
        </div>
        <div>
          <label className="label" htmlFor="pw-next">New password</label>
          <input id="pw-next" type="password" autoComplete="new-password" className={`input ${form.next && problems.length ? 'input-error' : ''}`}
                 value={form.next} onChange={set('next')} aria-describedby="pw-rules" />
          <ul id="pw-rules" className="mt-2 space-y-0.5 text-xs" aria-live="polite">
            {passwordProblems('').map((rule) => {
              const ok = form.next !== '' && !problems.includes(rule);
              return <li key={rule} className={ok ? 'text-success' : 'text-text-muted'}>{ok ? '✓' : '•'} {rule}</li>;
            })}
          </ul>
        </div>
        <div>
          <label className="label" htmlFor="pw-confirm">Confirm new password</label>
          <input id="pw-confirm" type="password" autoComplete="new-password" className={`input ${mismatch ? 'input-error' : ''}`}
                 value={form.confirm} onChange={set('confirm')} aria-invalid={mismatch} />
          {mismatch && <p className="error-text">The passwords do not match.</p>}
        </div>
        {error && <p className="text-sm text-danger" role="alert">{error}</p>}
        <div className="flex justify-end gap-2 pt-1">
          <button type="button" className="btn-secondary btn-sm" onClick={onClose}>Cancel</button>
          <button type="submit" className="btn-primary btn-sm" disabled={!canSave}>{saving ? 'Saving…' : 'Change password'}</button>
        </div>
      </form>
    </Modal>
  );
}
