// Team page: the people of the workspace you're working in, and what each one can open.
// The super admin manages everyone in the open workspace (members and admins). A workspace
// admin manages its members: add, change their access, reset a password, sign out, suspend,
// remove — and can only give pages they can open themselves. Members don't have this page.
import { Router } from 'express';
import { ObjectId } from 'mongodb';
import { users, audit, workspaceOf } from '../db/mongo.js';
import { hashPassword } from '../auth.js';
import { PAGES, pagesOf, cleanPages, forgetUser } from '../access.js';
import { publicUser } from './auth.js';
import { DEFAULT_WS } from '../tenant.js';

export const team = Router();

const emailRe = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const isOwner = (req) => req.user.role === 'owner';

// Only the super admin and admins open the Team page.
team.use((req, res, next) => {
  if (req.user.role === 'owner' || req.user.role === 'admin') return next();
  res.status(403).json({ error: "Only an admin can manage the team. Ask your admin.", noAccess: true });
});

// Pages this person may hand out: the super admin all of them, an admin their own.
const grantable = (req) => (isOwner(req) ? [...PAGES] : req.user.pages || []);

// The page list to save: what was ticked (only pages this person may hand out), plus pages
// the member already had that this person can't hand out (an admin can't take those away).
function pagesToSave(req, asked, current) {
  const can = new Set(grantable(req));
  const want = new Set((Array.isArray(asked) ? asked : []).map(String).filter((p) => can.has(p)));
  for (const p of current || []) if (!can.has(p)) want.add(p);
  return cleanPages(PAGES.filter((p) => want.has(p))); // every page ticked → null = "everything"
}

// May this person manage that account? Same workspace; an admin only members (not themself).
function manageable(req, u) {
  if (!u || u.role === 'owner') return false;
  if ((u.ws || DEFAULT_WS) !== req.ws) return false;
  if (isOwner(req)) return true;
  return u.role === 'member' && String(u._id) !== req.user.uid;
}

async function target(req, res) {
  if (!ObjectId.isValid(req.params.id)) {
    res.status(400).json({ error: 'Bad id' });
    return null;
  }
  const u = await users().findOne({ _id: new ObjectId(req.params.id) });
  if (!u || (u.ws || DEFAULT_WS) !== req.ws || u.role === 'owner') {
    res.status(404).json({ error: 'Not found' });
    return null;
  }
  if (!manageable(req, u)) {
    res.status(403).json({ error: 'Only the super admin can change an admin' });
    return null;
  }
  return u;
}
const log = (req, message, level = 'info') => audit(isOwner(req) ? 'admin' : 'system', message, { level });

// The team of the open workspace.
team.get('/', async (req, res) => {
  const list = await users().find({ ws: req.ws, role: { $ne: 'owner' } }, { sort: { createdAt: 1 } }).toArray();
  res.json({
    workspace: workspaceOf(req.ws)?.name || '',
    grantable: grantable(req),
    canAddAdmins: isOwner(req),
    people: list.map((u) => ({ ...publicUser(u), you: String(u._id) === req.user.uid, manageable: manageable(req, u) })),
  });
});

// Add someone to this workspace.
team.post('/', async (req, res) => {
  const b = req.body || {};
  const email = String(b.email || '').toLowerCase().trim();
  if (!emailRe.test(email)) return res.status(400).json({ error: 'Enter a valid email' });
  if (String(b.password || '').length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters' });
  if (b.role === 'admin' && !isOwner(req)) return res.status(403).json({ error: 'Only the super admin can add admins' });
  if (await users().findOne({ email })) return res.status(409).json({ error: 'An account with that email already exists' });
  const role = b.role === 'admin' ? 'admin' : 'member';
  const doc = {
    name: String(b.name || '').trim() || email.split('@')[0],
    email,
    passwordHash: await hashPassword(String(b.password)),
    role,
    ws: req.ws,
    createdAt: new Date().toISOString(),
    lastLoginAt: null,
  };
  const pages = pagesToSave(req, b.pages ?? grantable(req), []);
  if (pages) doc.pages = pages;
  const r = await users().insertOne(doc);
  doc._id = r.insertedId;
  log(req, `${req.user.email} added ${email} to the team (${role}: ${pages ? pages.join(', ') || 'no pages' : 'all pages'})`, 'success');
  res.json({ user: publicUser(doc) });
});

// Change someone's name, access (pages) and — super admin only — role.
team.put('/:id', async (req, res) => {
  const u = await target(req, res);
  if (!u) return;
  const b = req.body || {};
  const set = {};
  const unset = {};
  if (typeof b.name === 'string' && b.name.trim()) set.name = b.name.trim();
  if (isOwner(req) && (b.role === 'admin' || b.role === 'member')) set.role = b.role;
  if ('pages' in b) {
    const pages = pagesToSave(req, b.pages, pagesOf(u));
    if (pages) set.pages = pages;
    else unset.pages = '';
  }
  const upd = {};
  if (Object.keys(set).length) upd.$set = set;
  if (Object.keys(unset).length) upd.$unset = unset;
  if (Object.keys(upd).length) await users().updateOne({ _id: u._id }, upd);
  forgetUser(u._id);
  const fresh = await users().findOne({ _id: u._id });
  log(req, `${req.user.email} changed access for ${u.email}: ${fresh.role}, ${Array.isArray(fresh.pages) ? fresh.pages.join(', ') || 'no pages' : 'all pages'}`);
  res.json({ user: publicUser(fresh) });
});

// New password (they're signed out everywhere).
team.post('/:id/password', async (req, res) => {
  const u = await target(req, res);
  if (!u) return;
  const password = String(req.body?.password || '');
  if (password.length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters' });
  await users().updateOne({ _id: u._id }, { $set: { passwordHash: await hashPassword(password) }, $inc: { tokenVersion: 1 } });
  forgetUser(u._id);
  log(req, `${req.user.email} set a new password for ${u.email}`, 'warn');
  res.json({ ok: true });
});

// Sign out on every device.
team.post('/:id/signout', async (req, res) => {
  const u = await target(req, res);
  if (!u) return;
  await users().updateOne({ _id: u._id }, { $inc: { tokenVersion: 1 } });
  forgetUser(u._id);
  log(req, `${req.user.email} signed ${u.email} out everywhere`);
  res.json({ ok: true });
});

// Suspend (signed out at once, can't sign in) or re-activate.
team.post('/:id/suspend', async (req, res) => {
  const u = await target(req, res);
  if (!u) return;
  const suspended = !!req.body?.suspended;
  await users().updateOne({ _id: u._id }, suspended ? { $set: { suspended: true }, $inc: { tokenVersion: 1 } } : { $unset: { suspended: '' } });
  forgetUser(u._id);
  log(req, `${req.user.email} ${suspended ? 'suspended' : 're-activated'} ${u.email}`, suspended ? 'warn' : 'info');
  res.json({ ok: true, suspended });
});

// Remove from the team (deletes the account).
team.delete('/:id', async (req, res) => {
  const u = await target(req, res);
  if (!u) return;
  await users().deleteOne({ _id: u._id });
  forgetUser(u._id);
  log(req, `${req.user.email} removed ${u.email} from the team`, 'warn');
  res.json({ ok: true });
});
