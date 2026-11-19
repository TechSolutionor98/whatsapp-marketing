// Super Admin: full control over people and the whole system. Every route here is for the
// super admin (role 'owner') only — index.js mounts it behind requireOwner.
import { Router } from 'express';
import { ObjectId } from 'mongodb';
import { db, users, audit, getSetting, setSetting } from '../db/mongo.js';
import { hashPassword } from '../auth.js';
import { cleanPages, forgetUser } from '../access.js';
import { publicUser } from './auth.js';
import { setPaused, isPaused } from '../worker/sender.js';
import { setPoolAutoReply } from '../whatsapp/pool.js';
import { emit } from '../events.js';

export const admin = Router();

const by = (req) => req.user.email;

// A user the super admin may change: exists, and isn't the super admin account itself.
async function target(req, res) {
  if (!ObjectId.isValid(req.params.id)) {
    res.status(400).json({ error: 'Bad id' });
    return null;
  }
  const u = await users().findOne({ _id: new ObjectId(req.params.id) });
  if (!u) {
    res.status(404).json({ error: 'User not found' });
    return null;
  }
  if (u.role === 'owner') {
    res.status(400).json({ error: "The super admin account can't be changed here" });
    return null;
  }
  return u;
}

// Everything the Super Admin page shows in one call.
admin.get('/state', async (_req, res) => {
  const list = await users().find({}, { sort: { createdAt: 1 } }).toArray();
  const warmupNumbers = await db.warmupAccounts().countDocuments({ role: { $ne: 'conversation' } });
  res.json({
    users: list.map(publicUser),
    system: {
      sendingPaused: isPaused(),
      warmupActive: !!getSetting('warmupActive', false),
      teamLocked: !!getSetting('teamLocked', false),
      warmupNumbers,
    },
  });
});

// Change a user's name, role (admin/member) and pages.
admin.put('/users/:id', async (req, res) => {
  const u = await target(req, res);
  if (!u) return;
  const set = {};
  const unset = {};
  const b = req.body || {};
  if (typeof b.name === 'string' && b.name.trim()) set.name = b.name.trim();
  if (b.role === 'admin' || b.role === 'member') set.role = b.role;
  if ('pages' in b) {
    const pages = cleanPages(b.pages);
    if (pages) set.pages = pages;
    else unset.pages = '';
  }
  const upd = {};
  if (Object.keys(set).length) upd.$set = set;
  if (Object.keys(unset).length) upd.$unset = unset;
  if (Object.keys(upd).length) await users().updateOne({ _id: u._id }, upd);
  forgetUser(u._id);
  const fresh = await users().findOne({ _id: u._id });
  audit('system', `Access changed by ${by(req)}: ${u.email} → ${fresh.role}, ${Array.isArray(fresh.pages) ? fresh.pages.join(', ') || 'no pages' : 'all pages'}`);
  res.json({ user: publicUser(fresh) });
});

// Suspend (signs them out at once and blocks sign-in) or re-activate.
admin.post('/users/:id/suspend', async (req, res) => {
  const u = await target(req, res);
  if (!u) return;
  const suspended = !!req.body?.suspended;
  await users().updateOne(
    { _id: u._id },
    suspended ? { $set: { suspended: true }, $inc: { tokenVersion: 1 } } : { $unset: { suspended: '' } }
  );
  forgetUser(u._id);
  audit('system', `${suspended ? 'Suspended' : 'Re-activated'} by ${by(req)}: ${u.email}`, { level: suspended ? 'warn' : 'info' });
  res.json({ ok: true, suspended });
});

// Set a new password for someone (they're signed out everywhere).
admin.post('/users/:id/password', async (req, res) => {
  const u = await target(req, res);
  if (!u) return;
  const password = String(req.body?.password || '');
  if (password.length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters' });
  await users().updateOne({ _id: u._id }, { $set: { passwordHash: await hashPassword(password) }, $inc: { tokenVersion: 1 } });
  forgetUser(u._id);
  audit('system', `Password reset by ${by(req)}: ${u.email}`, { level: 'warn' });
  res.json({ ok: true });
});

// Sign someone out on every device.
admin.post('/users/:id/signout', async (req, res) => {
  const u = await target(req, res);
  if (!u) return;
  await users().updateOne({ _id: u._id }, { $inc: { tokenVersion: 1 } });
  forgetUser(u._id);
  audit('system', `Signed out everywhere by ${by(req)}: ${u.email}`);
  res.json({ ok: true });
});

// Turn AI auto-reply on/off for every number at once.
async function setAutoReplyAll(enabled) {
  await setSetting('autoReplyEnabled', enabled);
  const docs = await db.warmupAccounts().find({ role: 'conversation' }).toArray();
  for (const d of docs) {
    await db.warmupAccounts().updateOne({ _id: d._id }, { $set: { auto_reply: enabled } });
    setPoolAutoReply(String(d._id), enabled);
  }
  emit('pool:update', {});
}

// System switches: campaign sending, warm-up, team sign-in, AI auto-reply on all numbers.
admin.put('/system', async (req, res) => {
  const b = req.body || {};
  if ('sendingPaused' in b) {
    setPaused(!!b.sendingPaused);
    audit('system', `Campaign sending ${b.sendingPaused ? 'paused' : 'resumed'} by ${by(req)}`, { level: b.sendingPaused ? 'warn' : 'info' });
  }
  if ('warmupActive' in b) {
    if (b.warmupActive) {
      const n = await db.warmupAccounts().countDocuments({ role: { $ne: 'conversation' } });
      if (n < 2) return res.status(400).json({ error: 'Link at least 2 numbers on the Warmup page first' });
    }
    await setSetting('warmupActive', !!b.warmupActive);
    audit('warmup', `Warm-up ${b.warmupActive ? 'started' : 'stopped'} by ${by(req)}`);
  }
  if ('teamLocked' in b) {
    await setSetting('teamLocked', !!b.teamLocked);
    forgetUser();
    audit('system', b.teamLocked ? `Team sign-in paused by ${by(req)} — only the super admin can use the app` : `Team sign-in re-opened by ${by(req)}`, { level: b.teamLocked ? 'warn' : 'info' });
  }
  if ('autoReply' in b) {
    await setAutoReplyAll(!!b.autoReply);
    audit('system', `AI auto-reply turned ${b.autoReply ? 'ON' : 'OFF'} on every number by ${by(req)}`);
  }
  emit('stats:dirty', {});
  res.json({ ok: true });
});

// Emergency stop: nothing goes out automatically until switched back on.
admin.post('/emergency-stop', async (req, res) => {
  setPaused(true);
  await setSetting('warmupActive', false);
  await setAutoReplyAll(false);
  audit('system', `EMERGENCY STOP by ${by(req)}: campaign sending paused, warm-up stopped, AI auto-reply off on every number`, { level: 'warn' });
  emit('stats:dirty', {});
  res.json({ ok: true });
});
