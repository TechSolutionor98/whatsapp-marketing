// Email: the codes that confirm a new account's email and reset a forgotten password.
// Always on: every sign-up confirms its email, and "Forgot password?" always emails a code.
// The mail account (SMTP: Hostinger, Gmail, Zoho…) is set in the server's .env only
// (SMTP_HOST, SMTP_PORT, SMTP_SECURE, SMTP_USER, SMTP_PASS, MAIL_FROM, MAIL_FROM_NAME).

export const APP_NAME = process.env.APP_NAME || 'Tech Watsapi';
const emailRe = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const SECURITY = ['ssl', 'starttls', 'plain']; // port 465 / 587 / a local relay without encryption

// The mail account from .env, or null.
export function mailConfig() {
  const e = process.env;
  if (!e.SMTP_HOST) return null;
  const port = Number(e.SMTP_PORT) || 587;
  return {
    host: e.SMTP_HOST,
    port,
    security: SECURITY.includes(e.SMTP_SECURE) ? e.SMTP_SECURE : port === 465 ? 'ssl' : 'starttls',
    user: e.SMTP_USER || '',
    pass: e.SMTP_PASS || '',
    fromEmail: e.MAIL_FROM || e.SMTP_USER || '',
    fromName: e.MAIL_FROM_NAME || APP_NAME,
  };
}
export const mailReady = () => {
  const c = mailConfig();
  return !!(c?.host && emailRe.test(c.fromEmail || ''));
};

let transport = null; // { key, t }
async function transportFor(c) {
  const key = JSON.stringify([c.host, c.port, c.security, c.user, c.pass]);
  if (transport?.key === key) return transport.t;
  let nodemailer;
  try {
    nodemailer = (await import('nodemailer')).default;
  } catch {
    throw new Error('The email library is missing on the server. Run "npm install" there, then restart.');
  }
  const t = nodemailer.createTransport({
    host: c.host,
    port: c.port,
    secure: c.security === 'ssl',
    requireTLS: c.security === 'starttls',
    ignoreTLS: c.security === 'plain',
    auth: c.user ? { user: c.user, pass: c.pass || '' } : undefined,
    connectionTimeout: 15000,
    greetingTimeout: 10000,
    socketTimeout: 20000,
  });
  transport = { key, t };
  return t;
}

// Readable reason from an SMTP error (the server's own words are often the most useful).
function mailError(e) {
  const m = String(e?.response || e?.message || e || '');
  if (e?.code === 'EAUTH' || /535|534|auth/i.test(m)) return `The mail server refused the username or password. ${/gmail|google/i.test(m) ? 'For Gmail, use an App Password (Google account → Security → App passwords), not your normal password.' : ''}`.trim();
  if (['ECONNECTION', 'ETIMEDOUT', 'ESOCKET', 'EDNS'].includes(e?.code) || /ENOTFOUND|ECONNREFUSED|timeout/i.test(m)) return `Couldn't reach the mail server (${m.slice(0, 120)}). Check the server name, port and security.`;
  return `The mail server said: ${m.slice(0, 200)}`;
}

const mailFail = (message) => Object.assign(new Error(message), { mail: true }); // an email that couldn't go out

export async function sendMail({ to, subject, text, html }) {
  const c = mailConfig();
  if (!c || !mailReady()) throw mailFail('Email is not set up on the server yet.');
  let t;
  try {
    t = await transportFor(c);
  } catch (e) {
    throw mailFail(e.message);
  }
  try {
    await t.sendMail({ from: { name: c.fromName || APP_NAME, address: c.fromEmail }, to, subject, text, html });
  } catch (e) {
    console.error('  [mail] send failed:', e?.code || '', String(e?.response || e?.message || e).slice(0, 200));
    throw mailFail(mailError(e));
  }
}

// On start-up: log in to the mail server once, so a wrong .env shows in the server log
// (pm2 logs) straight away. Sends nothing.
export async function checkMail() {
  const c = mailConfig();
  if (!c || !mailReady()) {
    console.warn('  [mail] NOT SET UP: sign-ups and "Forgot password?" can\'t send their codes. Add SMTP_HOST, SMTP_PORT, SMTP_SECURE, SMTP_USER, SMTP_PASS and MAIL_FROM to .env, then restart.');
    return false;
  }
  try {
    await (await transportFor(c)).verify();
    console.log(`  [mail] ready: codes are sent from ${c.fromEmail} via ${c.host}:${c.port}`);
    return true;
  } catch (e) {
    console.error(`  [mail] PROBLEM with ${c.host}:${c.port}: ${e?.message?.includes('npm install') ? e.message : mailError(e)}`);
    return false;
  }
}

// ---- The emails ----
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]);

function layout(title, body, foot = '') {
  return `<!doctype html><html><body style="margin:0;padding:0;background:#f3f6f4">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f3f6f4;padding:32px 12px"><tr><td align="center">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:480px;background:#ffffff;border-radius:14px;border:1px solid #e3e9e5;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#17251d">
<tr><td style="padding:26px 28px 6px;font-size:18px;font-weight:700;color:#128c4a">${esc(APP_NAME)}</td></tr>
<tr><td style="padding:6px 28px 4px;font-size:22px;font-weight:700">${esc(title)}</td></tr>
<tr><td style="padding:10px 28px 24px;font-size:15px;line-height:1.55;color:#33463b">${body}</td></tr>
${foot ? `<tr><td style="padding:16px 28px 24px;border-top:1px solid #edf1ee;font-size:12.5px;line-height:1.5;color:#6b7d72">${foot}</td></tr>` : ''}
</table></td></tr></table></body></html>`;
}
const codeBox = (code) =>
  `<div style="margin:18px 0;padding:16px;background:#eefaf3;border:1px solid #cdeedb;border-radius:12px;text-align:center;font-size:32px;letter-spacing:10px;font-weight:700;font-family:SFMono-Regular,Menlo,Consolas,monospace;color:#0d6b38">${esc(code)}</div>`;

export function codeEmail(kind, { code, minutes, name, business, email }) {
  if (kind === 'signup') {
    return {
      subject: `${code} is your ${APP_NAME} code`,
      text: `Hi ${name},\n\nYour code to confirm your email and finish creating the ${business} account on ${APP_NAME}:\n\n${code}\n\nIt works for ${minutes} minutes.\n\nIf you didn't sign up, ignore this email.`,
      html: layout(
        'Confirm your email',
        `<p style="margin:0">Hi ${esc(name)}, enter this code to finish creating the <strong>${esc(business)}</strong> account:</p>${codeBox(code)}<p style="margin:0">It works for ${minutes} minutes.</p>`,
        `If you didn't sign up for ${esc(APP_NAME)}, ignore this email. No account is created without this code.`
      ),
    };
  }
  return {
    subject: `${code} is your ${APP_NAME} password reset code`,
    text: `Your code to choose a new password for ${email} on ${APP_NAME}:\n\n${code}\n\nIt works for ${minutes} minutes.\n\nIf you didn't ask for this, ignore this email. Your password stays the same.`,
    html: layout(
      'Reset your password',
      `<p style="margin:0">Enter this code to choose a new password for <strong>${esc(email)}</strong>:</p>${codeBox(code)}<p style="margin:0">It works for ${minutes} minutes.</p>`,
      "If you didn't ask for this, ignore this email. Your password stays the same."
    ),
  };
}
