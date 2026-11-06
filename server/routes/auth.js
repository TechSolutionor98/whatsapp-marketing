import { Router } from 'express';
import { ObjectId } from 'mongodb';
import { users, isMongoUp, mongoState, audit } from '../db/mongo.js';
import {
  hashPassword,
  verifyPassword,
  signToken,
  setAuthCookie,
  clearAuthCookie,
  requireAuth,
  requireAdmin,
} from '../auth.js';

export const auth = Router();

const emailRe = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const publicUser = (u) => ({
  id: String(u._id),
  email: u.email,
  name: u.name,
  role: u.role,
  createdAt: u.createdAt,
  lastLoginAt: u.lastLoginAt || null,
});

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

// Create an account. Admin/owner only — there is no public signup.
// The superadmin (owner) is seeded on startup from SUPERADMIN_* env vars.
auth.post('/register', requireAdmin, async (req, res) => {
  if (!isMongoUp()) return res.status(503).json({ error: 'Database unavailable — start MongoDB' });
  const { name = '', email = '', password = '' } = req.body || {};
  if (!emailRe.test(email)) return res.status(400).json({ error: 'Enter a valid email' });
  if (password.length < 6)
    return res.status(400).json({ error: 'Password must be at least 6 characters' });

  try {
    const role = req.body.role === 'admin' ? 'admin' : 'member';
    const doc = {
      name: name.trim() || email.split('@')[0],
      email: email.toLowerCase().trim(),
      passwordHash: await hashPassword(password),
      role,
      createdAt: new Date().toISOString(),
      lastLoginAt: null,
    };
    const r = await users().insertOne(doc);
    doc._id = r.insertedId;
    audit('system', `Account created by ${req.user.email}: ${doc.email} (${role})`, {
      level: 'success',
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
    await users().updateOne({ _id: u._id }, { $set: { lastLoginAt: new Date().toISOString() } });
    setAuthCookie(res, signToken(u));
    audit('system', `Signed in: ${u.email}`);
    res.json({ user: publicUser(u) });
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
    res.json({ user: publicUser(u) });
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
    await users().updateOne(
      { _id: u._id },
      { $set: { passwordHash: await hashPassword(newPassword) } }
    );
    audit('system', `Password changed: ${u.email}`);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ---- User management (admin/owner) ----
auth.get('/users', requireAdmin, async (_req, res) => {
  const list = await users().find({}, { sort: { createdAt: 1 } }).toArray();
  res.json(list.map(publicUser));
});

auth.delete('/users/:id', requireAdmin, async (req, res) => {
  try {
    const target = await users().findOne({ _id: new ObjectId(req.params.id) });
    if (!target) return res.status(404).json({ error: 'Not found' });
    if (String(target._id) === req.user.uid)
      return res.status(400).json({ error: "You can't delete your own account" });
    if (target.role === 'owner')
      return res.status(400).json({ error: 'The owner account cannot be removed' });
    await users().deleteOne({ _id: target._id });
    audit('system', `Account removed: ${target.email}`, { level: 'warn' });
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});
