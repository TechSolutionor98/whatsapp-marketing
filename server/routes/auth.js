import { Router } from 'express';
import { ObjectId } from 'mongodb';
import {
  users, isMongoUp, mongoState, audit, workspaceOf, listWorkspaces, getPlatform,
  createWorkspace, updateWorkspace, deleteWorkspaceData,
} from '../db/mongo.js';
import { DEFAULT_WS } from '../tenant.js';
import { getLimits, canAddPerson, getWsDefaults } from '../limits.js';
import { emit } from '../events.js';
import {
  hashPassword,
  verifyPassword,
  signToken,
  setAuthCookie,
  clearAuthCookie,
  requireAuth,
  requireAdmin,
  blockedReason,
  workspaceFor,
  signupMode,
} from '../auth.js';
import { pagesOf, cleanPages, forgetUser } from '../access.js';
import { mailReady } from '../mail.js';
import { sendCode, useCode, pendingCode, CodeError, CODE_MINUTES } from '../email-codes.js';

export const auth = Router();

const emailRe = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
export const publicUser = (u) => ({
  id: String(u._id),
  email: u.email,
  name: u.name,
  role: u.role,
  pages: pagesOf(u), // pages this user may open (the super admin: all)
  allPages: u.role === 'owner' || !Array.isArray(u.pages),
  suspended: !!u.suspended,
  ws: u.role === 'owner' ? null : u.ws || DEFAULT_WS, // the workspace this person belongs to
  wsName: u.role === 'owner' ? null : workspaceOf(u.ws || DEFAULT_WS)?.name || null,
  createdAt: u.createdAt,
  lastLoginAt: u.lastLoginAt || null,
});

// What the app shows after sign-in: the person, the workspace they're working in, and for
// the super admin every workspace (to switch between them).
function session(req, u) {
  const ws = workspaceFor(req, u);
  const w = workspaceOf(ws);
  return {
    user: publicUser(u),
    workspace: { id: ws, name: w?.name || 'Workspace', suspended: !!w?.suspended, main: ws === DEFAULT_WS },
    limits: getLimits(), // the super admin's rules — pages show them next to the fields they limit
    ...(u.role === 'owner' ? { workspaces: listWorkspaces() } : {}),
  };
}

// Public: tells the frontend whether to show setup, login, or a DB error.
auth.get('/status', async (_req, res) => {
  if (!isMongoUp()) {
    return res.json({ mongoConnected: false, hasUsers: false, error: mongoState.error });
  }
  try {
    const count = await users().countDocuments();
    // mail: whether "Forgot password?" can email a code; verify: sign-ups confirm their email.
    res.json({ mongoConnected: true, hasUsers: count > 0, signup: signupMode(), mail: mailReady(), verify: verifyOn() });
  } catch (e) {
    res.json({ mongoConnected: false, hasUsers: false, error: e.message });
  }
});

// Create an account — there is no public signup. The super admin (owner, seeded on startup
// from SUPERADMIN_* env vars) can add admins and members and choose their pages; an admin
// can only add members.
auth.post('/register', requireAdmin, async (req, res) => {
  if (!isMongoUp()) return res.status(503).json({ error: 'Database unavailable — start MongoDB' });
  const { name = '', email = '', password = '' } = req.body || {};
  if (!emailRe.test(email)) return res.status(400).json({ error: 'Enter a valid email' });
  if (password.length < 6)
    return res.status(400).json({ error: 'Password must be at least 6 characters' });

  try {
    const byOwner = req.user.role === 'owner';
    if (!byOwner && req.body.role === 'admin') return res.status(403).json({ error: 'Only the super admin can add admins' });
    const role = req.body.role === 'admin' ? 'admin' : 'member';
    // The super admin picks the workspace; an admin adds people to their own.
    const ws = byOwner ? String(req.body.ws || req.ws || DEFAULT_WS) : req.user.ws || DEFAULT_WS;
    if (!workspaceOf(ws)) return res.status(400).json({ error: 'Pick a workspace' });
    const full = await canAddPerson(ws);
    if (full) return res.status(400).json({ error: full });
    const doc = {
      name: name.trim() || email.split('@')[0],
      email: email.toLowerCase().trim(),
      passwordHash: await hashPassword(password),
      role,
      ws,
      createdAt: new Date().toISOString(),
      lastLoginAt: null,
    };
    const pages = byOwner ? cleanPages(req.body.pages) : null;
    if (pages) doc.pages = pages;
    const r = await users().insertOne(doc);
    doc._id = r.insertedId;
    audit(byOwner ? 'admin' : 'system', `Account created by ${req.user.email}: ${doc.email} (${role})`, {
      level: 'success',
      ws,
    });
    res.json({ user: publicUser(doc) });
  } catch (e) {
    if (e.code === 11000 || String(e.message).includes('duplicate'))
      return res.status(409).json({ error: 'An account with that email already exists' });
    res.status(500).json({ error: e.message });
  }
});

// ---- Public sign-up: a new business gets its own workspace ----
// The person who signs up becomes that workspace's admin (every page + its Team page). The
// workspace starts with the super admin's default settings, and the platform rules apply to
// it like to every other workspace. 'approval' mode keeps it closed until the super admin
// approves it on the Super Admin page.
const SIGNUP_WINDOW = 60 * 60 * 1000;
const signupTries = new Map(); // client address -> attempt times in the last hour
let signupsDone = []; // successful sign-ups in the last hour (all addresses)
const clientOf = (req) => String(req.get('x-forwarded-for') || req.ip || '').split(',')[0].trim() || 'unknown';
function signupLimited(req) {
  const now = Date.now();
  const ip = clientOf(req);
  const tries = (signupTries.get(ip) || []).filter((t) => now - t < SIGNUP_WINDOW);
  tries.push(now);
  signupTries.set(ip, tries);
  if (signupTries.size > 5000) signupTries.clear(); // never grows without bound
  signupsDone = signupsDone.filter((t) => now - t < SIGNUP_WINDOW);
  return tries.length > 10 || signupsDone.length >= 50;
}

// New sign-ups confirm their email with a code, when email is set up and the super admin
// hasn't switched that off.
export const verifyOn = () => mailReady() && getPlatform('verifyEmail', true) !== false;

function signupClosed(res) {
  const mode = signupMode();
  if (mode === 'off') return res.status(403).json({ error: 'New sign-ups are closed right now.' });
  if (getPlatform('teamLocked', false)) return res.status(403).json({ error: 'Sign-up is paused right now. Please try again later.' });
  return null;
}
// The business name and email are still free (checked again when the code is entered).
async function signupTaken(business, email) {
  if (listWorkspaces().some((w) => w.name.toLowerCase() === business.toLowerCase()))
    return 'A business with that name is already on the platform. Ask its admin to add you to their team, or use a different name.';
  if (await users().findOne({ email })) return 'An account with that email already exists — sign in instead.';
  return null;
}
const codeFail = (res, e) => {
  if (e instanceof CodeError) {
    if (e.wait) res.set('Retry-After', String(e.wait));
    return res.status(e.status).json({ error: e.message, code: e.code, ...(e.wait ? { wait: e.wait } : {}) });
  }
  if (e?.mail) return res.status(502).json({ error: `We couldn't send the email right now. ${e.message}`, code: 'mail_failed' });
  res.status(500).json({ error: e?.message || 'Something went wrong' });
};

// The workspace and its admin, once everything is checked (and the email confirmed, if asked).
async function createSignup(req, res, { business, name, email, passwordHash, verified }) {
  const mode = signupMode();
  const w = await createWorkspace(business, getWsDefaults()); // the super admin's defaults
  await updateWorkspace(w.id, { signup_email: email, ...(mode === 'approval' ? { suspended: true, pending: true } : {}) });
  const doc = {
    name,
    email,
    passwordHash,
    role: 'admin',
    ws: w.id,
    signup: true,
    ...(verified ? { emailVerified: true, emailVerifiedAt: new Date().toISOString() } : {}),
    createdAt: new Date().toISOString(),
    lastLoginAt: mode === 'open' ? new Date().toISOString() : null,
  };
  try {
    doc._id = (await users().insertOne(doc)).insertedId;
  } catch (e) {
    await deleteWorkspaceData(w.id).catch(() => {}); // the same email signed up a moment ago
    if (e.code === 11000) return res.status(409).json({ error: 'An account with that email already exists — sign in instead.' });
    throw e;
  }
  signupsDone.push(Date.now());
  audit('admin', `New sign-up: "${business}" by ${name} (${email})${verified ? ', email confirmed' : ''}${mode === 'approval' ? ' — waiting for your approval' : ''}`, { level: 'success', ws: w.id });
  emit('admin:update', {}, { ws: null });

  if (mode === 'approval') {
    return res.json({ pending: true, message: `Thanks, ${name}! ${business} is waiting for approval. You can sign in as soon as it's approved.` });
  }
  setAuthCookie(res, signToken(doc));
  res.json({ ...session(req, doc), created: true });
}

auth.post('/signup', async (req, res) => {
  if (!isMongoUp()) return res.status(503).json({ error: 'Database unavailable — try again shortly' });
  if (signupClosed(res)) return;
  const b = req.body || {};
  if (b.website) return res.status(400).json({ error: 'Something went wrong. Please try again.' }); // hidden field only bots fill in
  if (signupLimited(req)) return res.status(429).json({ error: 'Too many sign-ups from here. Please try again in an hour.' });

  const business = String(b.business || '').trim().replace(/\s+/g, ' ').slice(0, 80);
  const name = String(b.name || '').trim().slice(0, 80);
  const email = String(b.email || '').toLowerCase().trim();
  const password = String(b.password || '');
  if (business.length < 2) return res.status(400).json({ error: 'Enter your business name' });
  if (!name) return res.status(400).json({ error: 'Enter your name' });
  if (!emailRe.test(email)) return res.status(400).json({ error: 'Enter a valid email' });
  if (password.length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters' });
  if (password.length > 200) return res.status(400).json({ error: 'That password is too long' });

  try {
    const taken = await signupTaken(business, email);
    if (taken) return res.status(409).json({ error: taken });
    const passwordHash = await hashPassword(password);
    if (verifyOn()) {
      // Nothing is created yet: the details wait (24 h) with the code we email them.
      await sendCode('signup', email, { data: { business, name, passwordHash }, mail: { name, business } });
      return res.json({ verify: true, email, minutes: CODE_MINUTES, message: `We sent a 6-digit code to ${email}. Enter it to finish.` });
    }
    await createSignup(req, res, { business, name, email, passwordHash, verified: false });
  } catch (e) {
    codeFail(res, e);
  }
});

// The code from the email → the account is created (as a plain sign-up would have been).
auth.post('/signup/verify', async (req, res) => {
  if (!isMongoUp()) return res.status(503).json({ error: 'Database unavailable — try again shortly' });
  if (signupClosed(res)) return;
  if (tooManyTries(req)) return res.status(429).json({ error: 'Too many tries from here. Please wait 15 minutes.' });
  const email = String(req.body?.email || '').toLowerCase().trim();
  if (!emailRe.test(email)) return res.status(400).json({ error: 'Enter a valid email' });
  try {
    const d = await useCode('signup', email, req.body?.code);
    const { business, name, passwordHash } = d.data || {};
    if (!business || !passwordHash) return res.status(400).json({ error: 'This sign-up has run out. Please sign up again.' });
    const taken = await signupTaken(business, email);
    if (taken) return res.status(409).json({ error: taken });
    await createSignup(req, res, { business, name, email, passwordHash, verified: true });
  } catch (e) {
    codeFail(res, e);
  }
});

// "Send a new code" on the sign-up's code screen.
auth.post('/signup/resend', async (req, res) => {
  if (!isMongoUp()) return res.status(503).json({ error: 'Database unavailable — try again shortly' });
  if (signupClosed(res)) return;
  const email = String(req.body?.email || '').toLowerCase().trim();
  try {
    const d = emailRe.test(email) ? await pendingCode('signup', email) : null;
    if (!d?.data) return res.status(400).json({ error: 'This sign-up has run out. Please sign up again.', code: 'no_code' });
    await sendCode('signup', email, { data: d.data, mail: { name: d.data.name, business: d.data.business } });
    res.json({ ok: true, minutes: CODE_MINUTES, message: `We sent a new code to ${email}.` });
  } catch (e) {
    codeFail(res, e);
  }
});

// ---- Forgot password: a code by email, then a new password ----
const TRY_WINDOW = 15 * 60 * 1000;
const tryTimes = new Map(); // client address -> code / forgot attempts in the last 15 min
function tooManyTries(req, max = 30) {
  const now = Date.now();
  const ip = clientOf(req);
  const t = (tryTimes.get(ip) || []).filter((x) => now - x < TRY_WINDOW);
  t.push(now);
  tryTimes.set(ip, t);
  if (tryTimes.size > 5000) tryTimes.clear();
  return t.length > max;
}

auth.post('/forgot', async (req, res) => {
  if (!isMongoUp()) return res.status(503).json({ error: 'Database unavailable — try again shortly' });
  if (!mailReady()) return res.status(503).json({ error: "Password reset by email isn't set up yet. Ask your admin to set a new password for you.", code: 'mail_off' });
  if (tooManyTries(req, 10)) return res.status(429).json({ error: 'Too many requests from here. Please wait 15 minutes.' });
  const email = String(req.body?.email || '').toLowerCase().trim();
  if (!emailRe.test(email)) return res.status(400).json({ error: 'Enter a valid email' });
  // The same answer whether or not an account uses this email (nobody can check who has one).
  const answer = { ok: true, minutes: CODE_MINUTES, message: `If an account uses ${email}, we sent it a 6-digit code. Check your inbox (and spam).` };
  try {
    const u = await users().findOne({ email });
    if (!u) return res.json(answer);
    await sendCode('reset', email, { mail: { name: u.name } });
    audit('system', `Password reset code emailed to ${email}`, { ws: u.role === 'owner' ? null : u.ws || DEFAULT_WS });
    res.json(answer);
  } catch (e) {
    // "Wait before a new code" would tell a stranger that this email has an account: answer
    // the same as always (the code sent moments ago still works).
    if (e instanceof CodeError && e.code === 'wait') return res.json(answer);
    codeFail(res, e);
  }
});

auth.post('/reset', async (req, res) => {
  if (!isMongoUp()) return res.status(503).json({ error: 'Database unavailable — try again shortly' });
  if (tooManyTries(req)) return res.status(429).json({ error: 'Too many tries from here. Please wait 15 minutes.' });
  const email = String(req.body?.email || '').toLowerCase().trim();
  const password = String(req.body?.password || '');
  if (!emailRe.test(email)) return res.status(400).json({ error: 'Enter a valid email' });
  if (password.length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters' });
  if (password.length > 200) return res.status(400).json({ error: 'That password is too long' });
  try {
    await useCode('reset', email, req.body?.code);
    const u = await users().findOne({ email });
    if (!u) return res.status(400).json({ error: 'This code has run out. Ask for a new one.', code: 'no_code' });
    // New password → every device is signed out; the person proved they own the email.
    const tokenVersion = (u.tokenVersion || 0) + 1;
    const now = new Date().toISOString();
    await users().updateOne(
      { _id: u._id },
      { $set: { passwordHash: await hashPassword(password), tokenVersion, passwordResetAt: now, ...(u.emailVerified ? {} : { emailVerified: true, emailVerifiedAt: now }) } }
    );
    forgetUser(u._id);
    audit('system', `Password reset by email: ${u.email} (signed out everywhere)`, { level: 'warn', ws: u.role === 'owner' ? null : u.ws || DEFAULT_WS });
    const fresh = { ...u, tokenVersion };
    const blocked = blockedReason(fresh);
    if (blocked) return res.json({ ok: true, signedIn: false, message: `Your password is changed. ${blocked}` });
    await users().updateOne({ _id: u._id }, { $set: { lastLoginAt: now } });
    setAuthCookie(res, signToken(fresh));
    res.json({ ...session(req, fresh), reset: true });
  } catch (e) {
    codeFail(res, e);
  }
});

auth.post('/login', async (req, res) => {
  if (!isMongoUp()) return res.status(503).json({ error: 'Database unavailable — start MongoDB' });
  const { email = '', password = '' } = req.body || {};
  try {
    const u = await users().findOne({ email: email.toLowerCase().trim() });
    if (!u || !(await verifyPassword(password, u.passwordHash))) {
      return res.status(401).json({ error: 'Invalid email or password' });
    }
    const blocked = blockedReason(u);
    if (blocked) return res.status(403).json({ error: blocked });
    await users().updateOne({ _id: u._id }, { $set: { lastLoginAt: new Date().toISOString() } });
    setAuthCookie(res, signToken(u));
    audit('system', `Signed in: ${u.email}`, { ws: u.role === 'owner' ? null : u.ws || DEFAULT_WS });
    res.json(session(req, u));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

auth.post('/logout', (req, res) => {
  clearAuthCookie(res);
  res.json({ ok: true });
});

auth.get('/me', requireAuth, async (req, res) => {
  if (!isMongoUp()) return res.status(503).json({ error: 'Database unavailable' });
  try {
    const u = await users().findOne({ _id: new ObjectId(req.user.uid) });
    if (!u) {
      clearAuthCookie(res);
      return res.status(401).json({ error: 'Account no longer exists' });
    }
    res.json(session(req, u));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

auth.post('/change-password', requireAuth, async (req, res) => {
  if (!isMongoUp()) return res.status(503).json({ error: 'Database unavailable' });
  const { currentPassword = '', newPassword = '' } = req.body || {};
  if (newPassword.length < 6)
    return res.status(400).json({ error: 'New password must be at least 6 characters' });
  try {
    const u = await users().findOne({ _id: new ObjectId(req.user.uid) });
    if (!u || !(await verifyPassword(currentPassword, u.passwordHash))) {
      return res.status(400).json({ error: 'Current password is incorrect' });
    }
    // New password → every other device is signed out; this one gets a fresh session.
    const tokenVersion = (u.tokenVersion || 0) + 1;
    await users().updateOne(
      { _id: u._id },
      { $set: { passwordHash: await hashPassword(newPassword), tokenVersion } }
    );
    forgetUser(u._id);
    setAuthCookie(res, signToken({ ...u, tokenVersion }));
    audit('system', `Password changed: ${u.email}`);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ---- User management (admin/owner; the full controls are on the Super Admin page) ----
// An admin sees their own workspace's team; the super admin sees everyone.
auth.get('/users', requireAdmin, async (req, res) => {
  const filter = req.user.role === 'owner' ? {} : { ws: req.user.ws || DEFAULT_WS };
  const list = await users().find(filter, { sort: { createdAt: 1 } }).toArray();
  res.json(list.map(publicUser));
});

auth.delete('/users/:id', requireAdmin, async (req, res) => {
  try {
    const target = await users().findOne({ _id: new ObjectId(req.params.id) });
    if (!target) return res.status(404).json({ error: 'Not found' });
    if (String(target._id) === req.user.uid)
      return res.status(400).json({ error: "You can't delete your own account" });
    if (target.role === 'owner')
      return res.status(400).json({ error: 'The super admin account cannot be removed' });
    if (req.user.role !== 'owner' && target.role !== 'member')
      return res.status(403).json({ error: 'Only the super admin can remove an admin' });
    if (req.user.role !== 'owner' && (target.ws || DEFAULT_WS) !== (req.user.ws || DEFAULT_WS))
      return res.status(404).json({ error: 'Not found' }); // another workspace's account
    await users().deleteOne({ _id: target._id });
    forgetUser(target._id);
    audit(req.user.role === 'owner' ? 'admin' : 'system', `Account removed by ${req.user.email}: ${target.email}`, { level: 'warn', ws: target.ws || DEFAULT_WS });
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});
