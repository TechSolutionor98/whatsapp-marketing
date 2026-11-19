import { Router } from 'express';
import { ObjectId } from 'mongodb';
import { users, isMongoUp, mongoState, audit, workspaceOf, listWorkspaces } from '../db/mongo.js';
import { DEFAULT_WS } from '../tenant.js';
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
} from '../auth.js';
import { pagesOf, cleanPages, forgetUser } from '../access.js';

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
    res.json({ mongoConnected: true, hasUsers: count > 0 });
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
