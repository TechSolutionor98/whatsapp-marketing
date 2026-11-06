import { useState } from 'react';
import { useApp } from './store.jsx';
import { Icon } from './icons.jsx';

const Logo = () => (
  <div className="auth-logo">
    <svg viewBox="0 0 24 24" fill="white">
      <path d="M12 2a10 10 0 00-8.7 14.9L2 22l5.3-1.4A10 10 0 1012 2z" />
    </svg>
  </div>
);

function Shell({ title, subtitle, children, footer }) {
  return (
    <div className="auth-screen">
      <div className="auth-card">
        <div className="auth-top">
          <Logo />
          <h1>{title}</h1>
          <p>{subtitle}</p>
        </div>
        <div className="auth-body">{children}</div>
        {footer && <div className="auth-foot">{footer}</div>}
      </div>
    </div>
  );
}

function DbDown({ status, onRetry }) {
  return (
    <Shell title="Database unavailable" subtitle="Pulse needs MongoDB for accounts & login">
      <div className="auth-error">Can't reach MongoDB{status?.error ? `: ${status.error}` : ''}</div>
      <div className="auth-note">
        Start a MongoDB server, then retry. Two easy options:
        <br />
        <strong>Local (Homebrew):</strong>
        <br />
        <code>brew tap mongodb/brew</code>
        <br />
        <code>brew install mongodb-community</code>
        <br />
        <code>brew services start mongodb-community</code>
        <br />
        <br />
        <strong>Or MongoDB Atlas (free cloud):</strong> create a cluster, then set{' '}
        <code>MONGODB_URI</code> to its connection string before starting the server.
      </div>
      <button className="btn primary" onClick={onRetry}>
        <Icon.refresh /> Retry connection
      </button>
    </Shell>
  );
}

function LoginForm() {
  const { login, toast } = useApp();
  const [f, setF] = useState({ email: '', password: '' });
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);

  async function submit(e) {
    e.preventDefault();
    setErr('');
    setBusy(true);
    try {
      await login(f.email, f.password);
      toast('Welcome back', 'success');
    } catch (e) {
      setErr(e.message);
    }
    setBusy(false);
  }

  return (
    <Shell
      title="Sign in to Pulse"
      subtitle="WhatsApp Campaign Studio"
      footer="Need access? Ask your administrator to create your account."
    >
      <form onSubmit={submit}>
        {err && <div className="auth-error">{err}</div>}
        <div className="field">
          <label>Email</label>
          <input className="input" type="email" value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} placeholder="you@example.com" autoFocus />
        </div>
        <div className="field">
          <label>Password</label>
          <input className="input" type="password" value={f.password} onChange={(e) => setF({ ...f, password: e.target.value })} placeholder="••••••••" />
        </div>
        <button className="btn primary" disabled={busy}>
          <Icon.shield /> {busy ? 'Signing in…' : 'Sign in'}
        </button>
      </form>
    </Shell>
  );
}

export default function AuthGate() {
  const { authStatus, fetchStatus } = useApp();

  if (!authStatus) {
    return (
      <div className="auth-screen">
        <div className="spinner" />
      </div>
    );
  }
  if (!authStatus.mongoConnected) return <DbDown status={authStatus} onRetry={fetchStatus} />;
  // No public signup — accounts are created by an admin. Always show the login form.
  return <LoginForm />;
}
