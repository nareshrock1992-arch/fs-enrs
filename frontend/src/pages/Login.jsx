import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ShieldAlert, Sun, Moon } from 'lucide-react';
import { api } from '../api/client.js';
import { useAuthStore } from '../store/authStore.js';
import { useTheme } from '../hooks/useTheme.js';

export default function Login() {
  const [email, setEmail]       = useState('');
  const [password, setPassword] = useState('');
  const [error, setError]       = useState('');
  const [loading, setLoading]   = useState(false);
  const { login }               = useAuthStore();
  const { isDark, toggle }      = useTheme();
  const navigate                = useNavigate();

  async function handleSubmit(e) {
    e.preventDefault();
    setError('');
    setLoading(true);
    try {
      const { token, user } = await api.login(email, password);
      login(token, user);
      navigate('/');
    } catch (err) {
      setError(err.message || 'Login failed');
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="min-h-screen bg-surface-bg flex items-center justify-center p-4 relative">
      <button onClick={toggle}
              className="absolute top-4 right-4 btn-ghost p-2"
              aria-label="Toggle theme">
        {isDark ? <Sun size={18} /> : <Moon size={18} />}
      </button>

      <div className="w-full max-w-sm">
        <div className="text-center mb-8">
          <div className="inline-flex items-center justify-center w-14 h-14 rounded-2xl
                          bg-brand/10 border border-brand/20 mb-4">
            <ShieldAlert size={28} className="text-brand" />
          </div>
          <h1 className="text-xl font-bold text-text-primary">fs-enrs</h1>
          <p className="text-sm text-text-muted mt-1">Emergency Notification & Response System</p>
        </div>

        <div className="card">
          <form onSubmit={handleSubmit} className="space-y-4">
            <div>
              <label className="label">Email</label>
              <input
                type="email"
                className="input"
                value={email}
                onChange={e => setEmail(e.target.value)}
                required
                autoFocus
                placeholder="admin@example.com"
              />
            </div>
            <div>
              <label className="label">Password</label>
              <input
                type="password"
                className="input"
                value={password}
                onChange={e => setPassword(e.target.value)}
                required
                placeholder="••••••••"
              />
            </div>

            {error && (
              <p className="text-sm text-red-500 bg-red-500/10 border border-red-500/20
                            rounded-lg px-3 py-2">{error}</p>
            )}

            <button type="submit" disabled={loading}
                    className="btn-primary w-full">
              {loading ? 'Signing in…' : 'Sign in'}
            </button>
          </form>
        </div>
      </div>
    </div>
  );
}
