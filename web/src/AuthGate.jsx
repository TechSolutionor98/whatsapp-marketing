import { useState } from 'react';
import { useApp } from './store.jsx';
import { Icon } from './icons.jsx';

const Logo = () => (
  <div className="auth-logo">
    <img src="/logo.png" alt="Tech Watsapi" />
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
    <Shell title="Database unavailable" subtitle="Tech Watsapi needs MongoDB for accounts & login">
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

function LoginForm({ signupMode, onSignup }) {
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
      title="Sign in to Tech Watsapi"
      subtitle="WhatsApp marketing & AI sales assistant"
      footer={
        signupMode && signupMode !== 'off' ? (
          <>
            New to Tech Watsapi?{' '}
            <button type="button" className="auth-link" onClick={onSignup}>Create an account</button>
          </>
        ) : (
          'Need access? Ask your administrator to create your account.'
        )
      }
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

// Public sign-up: a new business gets its own workspace and the person becomes its admin.
// Linkable as <app>/#signup (e.g. from the landing page).
function SignupForm({ mode, onLogin }) {
  const { signup, toast } = useApp();
  const [f, setF] = useState({ business: '', name: '', email: '', password: '', website: '' });
  const [show, setShow] = useState(false);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const [pending, setPending] = useState('');
  const set = (k) => (e) => setF({ ...f, [k]: e.target.value });

  async function submit(e) {
    e.preventDefault();
    setErr('');
    if (f.password.length < 8) return setErr('Password must be at least 8 characters');
    setBusy(true);
    try {
      const r = await signup(f);
      if (r.pending) setPending(r.message);
      else toast(`Welcome! ${f.business} is ready`, 'success');
    } catch (e) {
      setErr(e.message);
    }
    setBusy(false);
  }

  if (pending) {
    return (
      <Shell title="You're signed up" subtitle="One last step" footer={<button type="button" className="auth-link" onClick={onLogin}>Back to sign in</button>}>
        <div className="auth-done">
          <Icon.check />
          <div>{pending}</div>
        </div>
      </Shell>
    );
  }

  return (
    <Shell
      title="Create your account"
      subtitle="Your own workspace: WhatsApp campaigns, a shared inbox and AI replies"
      footer={
        <>
          Already have an account?{' '}
          <button type="button" className="auth-link" onClick={onLogin}>Sign in</button>
        </>
      }
    >
      <form onSubmit={submit} autoComplete="on">
        {err && <div className="auth-error">{err}</div>}
        <div className="field">
          <label>Business name</label>
          <input className="input" value={f.business} onChange={set('business')} placeholder="e.g. Al Noor Electronics" autoFocus required maxLength={80} autoComplete="organization" />
        </div>
        <div className="field">
          <label>Your name</label>
          <input className="input" value={f.name} onChange={set('name')} placeholder="Full name" required maxLength={80} autoComplete="name" />
        </div>
        <div className="field">
          <label>Email</label>
          <input className="input" type="email" value={f.email} onChange={set('email')} placeholder="you@business.com" required autoComplete="email" />
        </div>
        <div className="field">
          <label>Password</label>
          <div className="auth-pw">
            <input className="input" type={show ? 'text' : 'password'} value={f.password} onChange={set('password')} placeholder="At least 8 characters" required minLength={8} autoComplete="new-password" />
            <button type="button" className="auth-pw-toggle" onClick={() => setShow(!show)}>{show ? 'Hide' : 'Show'}</button>
          </div>
        </div>
        {/* Left empty by people; bots fill it in. */}
        <input className="auth-hp" tabIndex={-1} autoComplete="off" aria-hidden="true" value={f.website} onChange={set('website')} name="website" />
        <button className="btn primary" disabled={busy}>
          <Icon.sparkles /> {busy ? 'Creating your workspace…' : 'Create account'}
        </button>
        <div className="auth-fine">
          {mode === 'approval' ? 'New accounts are reviewed before they can sign in. ' : ''}
          Message only people who expect to hear from you, and give them a way to opt out.
        </div>
      </form>
    </Shell>
  );
}

export default function AuthGate() {
  const { authStatus, fetchStatus } = useApp();
  const [view, setView] = useState(() => (/signup|register/i.test(window.location.hash) ? 'signup' : 'login'));
  const go = (v) => {
    setView(v);
    window.location.hash = v === 'signup' ? 'signup' : '';
  };

  if (!authStatus) {
    return (
      <div className="auth-screen">
        <div className="spinner" />
      </div>
    );
  }
  if (!authStatus.mongoConnected) return <DbDown status={authStatus} onRetry={fetchStatus} />;
  const mode = authStatus.signup || 'off';
  if (view === 'signup' && mode !== 'off') return <SignupForm mode={mode} onLogin={() => go('login')} />;
  return <LoginForm signupMode={mode} onSignup={() => go('signup')} />;
}
