// Super Admin → Rules & controls → Email: the mail account (SMTP) that sends sign-up codes
// and password reset codes.
import { useEffect, useState } from 'react';
import { api } from '../api.js';
import { useApp } from '../store.jsx';
import { Icon } from '../icons.jsx';
import { PasswordInput, timeAgo } from '../ui.jsx';

// Common providers: one tap fills the server, port and security.
const PRESETS = [
  ['Gmail / Google Workspace', 'smtp.gmail.com', 465, 'ssl', 'Use an App Password (Google account → Security → 2-Step Verification → App passwords), not your normal password.'],
  ['Outlook / Microsoft 365', 'smtp.office365.com', 587, 'starttls', 'Your Microsoft admin may need to allow "Authenticated SMTP" for this mailbox.'],
  ['Zoho Mail', 'smtp.zoho.com', 465, 'ssl', 'For accounts in the EU or India data centre, use smtp.zoho.eu or smtp.zoho.in.'],
  ['Hostinger', 'smtp.hostinger.com', 465, 'ssl', 'Use the full email address and its mailbox password.'],
  ['Brevo', 'smtp-relay.brevo.com', 587, 'starttls', 'Use the SMTP login and SMTP key from Brevo → SMTP & API.'],
];

const blank = { host: '', port: 465, security: 'ssl', user: '', pass: '', fromEmail: '', fromName: '' };
const fromMail = (m) => ({ ...blank, ...(m || {}), pass: '' });

export function MailPanel({ mail, onChanged }) {
  const { user, toast } = useApp();
  const [f, setF] = useState(() => fromMail(mail));
  const [m, setM] = useState(mail);
  const [busy, setBusy] = useState('');
  const [hint, setHint] = useState('');
  const [to, setTo] = useState(user?.email || '');
  const set = (k) => (e) => setF({ ...f, [k]: e.target.value });

  useEffect(() => {
    api.get('/admin/mail').then((r) => {
      setM(r);
      setF(fromMail(r));
    }).catch(() => {});
  }, []);

  function preset([, host, port, security, tip]) {
    setF({ ...f, host, port, security });
    setHint(tip);
  }

  async function save() {
    setBusy('save');
    try {
      const r = await api.put('/admin/mail', { ...f, port: Number(f.port) });
      setM(r);
      setF(fromMail(r));
      toast('Email settings saved. Send a test to check them', 'success');
      onChanged?.();
    } catch (e) {
      toast(e.message, 'error');
    }
    setBusy('');
  }

  async function test() {
    setBusy('test');
    try {
      const r = await api.post('/admin/mail/test', { to });
      setM(r.mail);
      toast(`Test email sent to ${to}. Check the inbox`, 'success');
    } catch (e) {
      api.get('/admin/mail').then(setM).catch(() => {});
      toast(e.message, 'error');
    }
    setBusy('');
    onChanged?.();
  }

  async function remove() {
    if (!confirm('Remove the email settings?\n\nNew sign-ups will no longer confirm their email, and "Forgot password?" stops working until you set email up again.')) return;
    setBusy('remove');
    try {
      const r = await api.del('/admin/mail');
      setM(r);
      setF(fromMail(r));
      toast('Email settings removed', 'success');
      onChanged?.();
    } catch (e) {
      toast(e.message, 'error');
    }
    setBusy('');
  }

  const t = m?.lastTest;
  const status = !m?.ready
    ? { cls: 'gray', text: 'Not set up' }
    : t?.ok
      ? { cls: 'green', text: 'Working' }
      : t && !t.ok
        ? { cls: 'red', text: 'Last test failed' }
        : { cls: 'amber', text: 'Saved, not tested yet' };
  const changed = m?.source !== 'saved' || ['host', 'user', 'fromEmail', 'fromName', 'security'].some((k) => String(f[k] || '') !== String(m?.[k] || '')) || Number(f.port) !== Number(m?.port) || !!f.pass;

  return (
    <div className="card" style={{ marginBottom: 18 }}>
      <div className="card-head">
        <Icon.mail style={{ width: 18, color: 'var(--brand-700)' }} />
        <div>
          <h3>Email</h3>
          <div className="sub">Sends the code that confirms a new sign-up's email, and the code for "Forgot password?". Use your own mail account.</div>
        </div>
      </div>
      <div className="card-pad">
        <div className="mail-status" style={{ marginBottom: 14 }}>
          <span className={`badge ${status.cls}`}>{status.text}</span>
          {t && (
            <span>
              {t.ok ? `Test email went to ${t.to}` : t.error} · {timeAgo(t.at)}
            </span>
          )}
          {m?.source === 'env' && <span>Using the SMTP settings from the server's .env file. Saving here replaces them.</span>}
        </div>

        <div className="field">
          <label>Quick fill</label>
          <div className="flex" style={{ gap: 6, flexWrap: 'wrap' }}>
            {PRESETS.map((p) => (
              <button key={p[0]} type="button" className={`chip-btn ${f.host === p[1] ? 'on' : ''}`} onClick={() => preset(p)}>{p[0]}</button>
            ))}
          </div>
          {hint && <div className="hint">{hint}</div>}
        </div>

        <div className="mail-grid">
          <div className="field">
            <label htmlFor="mail-host">Mail server (SMTP)</label>
            <input id="mail-host" className="input" value={f.host} onChange={set('host')} placeholder="smtp.gmail.com" autoComplete="off" spellCheck={false} />
          </div>
          <div className="row" style={{ gap: 12 }}>
            <div className="field">
              <label htmlFor="mail-port">Port</label>
              <input id="mail-port" className="input" type="number" min={1} max={65535} value={f.port} onChange={set('port')} />
            </div>
            <div className="field">
              <label htmlFor="mail-sec">Security</label>
              <select id="mail-sec" className="select" value={f.security} onChange={set('security')}>
                <option value="ssl">SSL (port 465)</option>
                <option value="starttls">STARTTLS (port 587)</option>
                <option value="plain">None (local relay)</option>
              </select>
            </div>
          </div>
          <div className="field">
            <label htmlFor="mail-user">Username</label>
            <input id="mail-user" className="input" value={f.user} onChange={set('user')} placeholder="you@yourcompany.com" autoComplete="off" spellCheck={false} />
          </div>
          <div className="field">
            <label htmlFor="mail-pass">Password</label>
            <PasswordInput id="mail-pass" value={f.pass} onChange={set('pass')} placeholder={m?.hasPassword ? 'Saved. Leave empty to keep it' : 'Mailbox or app password'} autoComplete="new-password" />
          </div>
          <div className="field">
            <label htmlFor="mail-from">Send from (email)</label>
            <input id="mail-from" className="input" type="email" value={f.fromEmail} onChange={set('fromEmail')} placeholder="Same as the username if empty" autoComplete="off" />
          </div>
          <div className="field">
            <label htmlFor="mail-name">Sender name</label>
            <input id="mail-name" className="input" value={f.fromName} onChange={set('fromName')} placeholder="Tech Watsapi" maxLength={60} />
          </div>
        </div>

        <div className="flex" style={{ gap: 8, justifyContent: 'flex-end', flexWrap: 'wrap' }}>
          {m?.source === 'saved' && (
            <button className="btn ghost danger-text" onClick={remove} disabled={!!busy}>
              <Icon.trash /> Remove
            </button>
          )}
          <button className="btn primary" onClick={save} disabled={!!busy || !f.host.trim() || !changed}>
            <Icon.check /> {busy === 'save' ? 'Saving…' : 'Save'}
          </button>
        </div>

        {m?.ready && (
          <div className="mail-test" style={{ marginTop: 18, paddingTop: 16, borderTop: '1px solid var(--border)' }}>
            <div className="field">
              <label htmlFor="mail-to">Send a test email to</label>
              <input id="mail-to" className="input" type="email" value={to} onChange={(e) => setTo(e.target.value)} placeholder="you@example.com" />
            </div>
            <button className="btn" onClick={test} disabled={!!busy || !to.trim() || changed}>
              <Icon.send /> {busy === 'test' ? 'Sending…' : 'Send test email'}
            </button>
          </div>
        )}
        {m?.ready && changed && <div className="hint" style={{ marginTop: 6 }}>Save your changes first, then send a test.</div>}
      </div>
    </div>
  );
}
