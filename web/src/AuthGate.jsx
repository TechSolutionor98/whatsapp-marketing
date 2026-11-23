import { useEffect, useRef, useState } from 'react';
import { useApp } from './store.jsx';
import { Icon } from './icons.jsx';
import { api } from './api.js';
import { PasswordInput } from './ui.jsx';

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

// Seconds left before "Send a new code" works again.
function useCountdown(initial = 0) {
  const [left, setLeft] = useState(initial);
  useEffect(() => {
    if (left <= 0) return undefined;
    const t = setTimeout(() => setLeft((n) => n - 1), 1000);
    return () => clearTimeout(t);
  }, [left]);
  return [left, setLeft];
}

const digits = (v) => String(v || '').replace(/\D/g, '').slice(0, 6);

function CodeInput({ value, onChange, autoFocus = true }) {
  return (
    <input
      className="input auth-code"
      value={value}
      onChange={(e) => onChange(digits(e.target.value))}
      inputMode="numeric"
      pattern="[0-9]*"
      autoComplete="one-time-code"
      maxLength={6}
      placeholder="••••••"
      aria-label="6-digit code"
      autoFocus={autoFocus}
      required
    />
  );
}

function Sent({ email }) {
  return (
    <div className="auth-sent">
      <Icon.mail />
      <div>
        We sent a 6-digit code to <strong>{email}</strong>. Check your inbox, and the spam folder if it isn't there in a minute.
      </div>
    </div>
  );
}

function LoginForm({ signupMode, onSignup, onForgot, email: startEmail, notice }) {
  const { login, toast } = useApp();
  const [f, setF] = useState({ email: startEmail || '', password: '' });
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
        {notice && !err && <div className="auth-ok">{notice}</div>}
        {err && <div className="auth-error">{err}</div>}
        <div className="field">
          <label htmlFor="login-email">Email</label>
          <input id="login-email" className="input" type="email" value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} placeholder="you@example.com" autoComplete="username" autoFocus={!startEmail} />
        </div>
        <div className="field">
          <div className="auth-label-row">
            <label htmlFor="login-password">Password</label>
            <button type="button" className="auth-link" onClick={() => onForgot(f.email)}>Forgot password?</button>
          </div>
          <PasswordInput id="login-password" value={f.password} onChange={(e) => setF({ ...f, password: e.target.value })} placeholder="••••••••" autoComplete="current-password" autoFocus={!!startEmail} />
        </div>
        <button className="btn primary" disabled={busy}>
          <Icon.shield /> {busy ? 'Signing in…' : 'Sign in'}
        </button>
      </form>
    </Shell>
  );
}

// Forgot password, step 1: the email to send a code to.
function ForgotForm({ email: startEmail, onBack, onSent, onSignup }) {
  const [email, setEmail] = useState(startEmail || '');
  const [err, setErr] = useState('');
  const [noAccount, setNoAccount] = useState(false);
  const [busy, setBusy] = useState(false);

  async function submit(e) {
    e.preventDefault();
    setErr('');
    setNoAccount(false);
    setBusy(true);
    try {
      await api.post('/auth/forgot', { email });
      onSent(email.trim().toLowerCase());
    } catch (e) {
      setErr(e.message);
      setNoAccount(e.code === 'no_account');
    }
    setBusy(false);
  }

  const back = <button type="button" className="auth-link" onClick={() => onBack(email)}>Back to sign in</button>;
  return (
    <Shell title="Forgot your password?" subtitle="Enter your email and we'll send you a 6-digit code to set a new one" footer={back}>
      <form onSubmit={submit}>
        {err && (
          <div className="auth-error">
            {err}
            {noAccount && onSignup && (
              <div style={{ marginTop: 6 }}>
                <button type="button" className="auth-link" onClick={onSignup}>Create an account</button>
              </div>
            )}
          </div>
        )}
        <div className="field">
          <label htmlFor="forgot-email">Email</label>
          <input id="forgot-email" className="input" type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@example.com" autoComplete="username" autoFocus required />
        </div>
        <button className="btn primary" disabled={busy || !email.trim()}>
          <Icon.mail /> {busy ? 'Sending…' : 'Email me a code'}
        </button>
      </form>
    </Shell>
  );
}

// Forgot password, step 2: the code from the email + a new password.
function ResetForm({ email, onBack, onOtherEmail, onDone }) {
  const { resetPassword, toast } = useApp();
  const [code, setCode] = useState('');
  const [password, setPassword] = useState('');
  const [err, setErr] = useState('');
  const [info, setInfo] = useState('');
  const [busy, setBusy] = useState(false);
  const [left, setLeft] = useCountdown(60);

  async function submit(e) {
    e.preventDefault();
    setErr('');
    setInfo('');
    if (code.length !== 6) return setErr('Enter the 6-digit code from the email');
    if (password.length < 8) return setErr('Password must be at least 8 characters');
    setBusy(true);
    try {
      const r = await resetPassword(email, code, password);
      if (r.user) toast('Password changed. You\'re signed in', 'success');
      else onDone(r.message || 'Your password is changed. Sign in with it.');
    } catch (e) {
      setErr(e.message);
      if (/new code|run out|already used/i.test(e.message)) setCode('');
    }
    setBusy(false);
  }

  async function resend() {
    setErr('');
    setInfo('');
    try {
      await api.post('/auth/forgot', { email });
      setInfo('A new code is on its way. Use the newest email.');
      setCode('');
      setLeft(60);
    } catch (e) {
      const wait = Number(/(\d+) seconds/.exec(e.message)?.[1]);
      if (wait) setLeft(wait);
      setErr(e.message);
    }
  }

  return (
    <Shell title="Set a new password" subtitle="Enter the code from the email and choose a new password" footer={<button type="button" className="auth-link" onClick={onBack}>Back to sign in</button>}>
      <form onSubmit={submit}>
        <Sent email={email} />
        {info && !err && <div className="auth-ok">{info}</div>}
        {err && <div className="auth-error">{err}</div>}
        <div className="field">
          <label>Code</label>
          <CodeInput value={code} onChange={setCode} />
        </div>
        <div className="field">
          <label htmlFor="reset-password">New password</label>
          <PasswordInput id="reset-password" value={password} onChange={(e) => setPassword(e.target.value)} placeholder="At least 8 characters" autoComplete="new-password" minLength={8} required />
        </div>
        <button className="btn primary" disabled={busy}>
          <Icon.shield /> {busy ? 'Saving…' : 'Set new password'}
        </button>
        <div className="auth-row-links">
          <button type="button" className="auth-link" onClick={resend} disabled={left > 0}>{left > 0 ? `Send a new code (${left}s)` : 'Send a new code'}</button>
          <button type="button" className="auth-link" onClick={onOtherEmail}>Use a different email</button>
        </div>
      </form>
    </Shell>
  );
}

// Public sign-up: a new business gets its own workspace and the person becomes its admin.
// Linkable as <app>/#signup (e.g. from the landing page). The account is only created once
// the code we email is entered.
function SignupForm({ mode, onLogin }) {
  const { signup, verifySignup, toast } = useApp();
  const [f, setF] = useState({ business: '', name: '', email: '', password: '', website: '' });
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const [pending, setPending] = useState('');
  const [codeFor, setCodeFor] = useState(''); // the email a code was sent to
  const set = (k) => (e) => setF({ ...f, [k]: e.target.value });

  function done(r) {
    if (r.pending) setPending(r.message);
    else if (r.user) toast(`Welcome! ${f.business || r.workspace?.name || 'Your workspace'} is ready`, 'success');
  }

  async function submit(e) {
    e.preventDefault();
    setErr('');
    if (f.password.length < 8) return setErr('Password must be at least 8 characters');
    setBusy(true);
    try {
      const r = await signup(f);
      if (r.verify) setCodeFor(r.email);
      else done(r);
    } catch (e) {
      setErr(e.message);
    }
    setBusy(false);
  }

  if (pending) {
    return (
      <Shell title="You're signed up" subtitle="One last step" footer={<button type="button" className="auth-link" onClick={() => onLogin(f.email)}>Back to sign in</button>}>
        <div className="auth-done">
          <Icon.check />
          <div>{pending}</div>
        </div>
      </Shell>
    );
  }

  if (codeFor) {
    return <SignupCode email={codeFor} business={f.business} onBack={() => setCodeFor('')} onDone={done} verify={verifySignup} />;
  }

  return (
    <Shell
      title="Create your account"
      subtitle="Your own workspace: WhatsApp campaigns, a shared inbox and AI replies"
      footer={
        <>
          Already have an account?{' '}
          <button type="button" className="auth-link" onClick={() => onLogin(f.email)}>Sign in</button>
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
          <label htmlFor="signup-password">Password</label>
          <PasswordInput id="signup-password" value={f.password} onChange={set('password')} placeholder="At least 8 characters" required minLength={8} autoComplete="new-password" />
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

// Sign-up, step 2: the code we emailed. Entering it creates the account.
function SignupCode({ email, business, onBack, onDone, verify }) {
  const [code, setCode] = useState('');
  const [err, setErr] = useState('');
  const [info, setInfo] = useState('');
  const [busy, setBusy] = useState(false);
  const [left, setLeft] = useCountdown(60);
  const tried = useRef('');

  async function check(c = code) {
    if (busy) return;
    setErr('');
    setInfo('');
    if (c.length !== 6) return setErr('Enter the 6-digit code from the email');
    tried.current = c;
    setBusy(true);
    try {
      onDone(await verify(email, c));
    } catch (e) {
      setErr(e.message);
    }
    setBusy(false);
  }
  // All 6 digits typed or pasted → check at once.
  useEffect(() => {
    if (code.length === 6 && code !== tried.current) check(code);
  }, [code]);

  async function resend() {
    setErr('');
    setInfo('');
    try {
      await api.post('/auth/signup/resend', { email });
      setInfo('We sent a new code. Use the newest email.');
      setCode('');
      tried.current = '';
      setLeft(60);
    } catch (e) {
      const wait = Number(/(\d+) seconds/.exec(e.message)?.[1]);
      if (wait) setLeft(wait);
      setErr(e.message);
    }
  }

  return (
    <Shell title="Confirm your email" subtitle={`One step left to create ${business || 'your workspace'}`} footer={<button type="button" className="auth-link" onClick={onBack}>Change my details</button>}>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          check();
        }}
      >
        <Sent email={email} />
        {info && !err && <div className="auth-ok">{info}</div>}
        {err && <div className="auth-error">{err}</div>}
        <div className="field">
          <label>Code</label>
          <CodeInput value={code} onChange={setCode} />
        </div>
        <button className="btn primary" disabled={busy}>
          <Icon.check /> {busy ? 'Checking…' : 'Confirm and create account'}
        </button>
        <div className="auth-row-links">
          <button type="button" className="auth-link" onClick={resend} disabled={left > 0}>{left > 0 ? `Send a new code (${left}s)` : 'Send a new code'}</button>
        </div>
      </form>
    </Shell>
  );
}

export default function AuthGate() {
  const { authStatus, fetchStatus } = useApp();
  const [view, setView] = useState(() => (/signup|register/i.test(window.location.hash) ? 'signup' : 'login'));
  const [email, setEmail] = useState(''); // carried between sign-in, forgot and reset
  const [notice, setNotice] = useState('');
  const go = (v, mail) => {
    if (mail !== undefined) setEmail(mail);
    if (v !== 'login') setNotice('');
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
  if (view === 'signup' && mode !== 'off') return <SignupForm mode={mode} onLogin={(m) => go('login', m)} />;
  if (view === 'forgot') return <ForgotForm email={email} onBack={(m) => go('login', m)} onSent={(m) => go('reset', m)} onSignup={mode !== 'off' ? () => go('signup') : undefined} />;
  if (view === 'reset' && email)
    return (
      <ResetForm
        email={email}
        onBack={() => go('login')}
        onOtherEmail={() => go('forgot', '')}
        onDone={(msg) => {
          go('login');
          setNotice(msg);
        }}
      />
    );
  return <LoginForm key={email + notice} email={email} notice={notice} signupMode={mode} onSignup={() => go('signup')} onForgot={(m) => go('forgot', m)} />;
}
