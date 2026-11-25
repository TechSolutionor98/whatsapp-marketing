// Super Admin: controls the whole platform — every workspace (business), every person in it,
// and what each workspace's automation is allowed to do. Every route here is for the super
// admin (role 'owner') only — index.js mounts it behind requireOwner.
import { Router } from 'express';
import { ObjectId } from 'mongodb';
import {
  db, col, users, getSetting, setSetting, getPlatform, setPlatform, dayKey,
  listWorkspaces, workspaceOf, createWorkspace, updateWorkspace, deleteWorkspaceData,
} from '../db/mongo.js';
import { audit as auditLog } from '../db/mongo.js';
import { hashPassword, SIGNUP_MODES, signupMode } from '../auth.js';
import { cleanPages, forgetUser } from '../access.js';
import { publicUser } from './auth.js';
import { setPaused } from '../worker/sender.js';
import { poolState, setPoolAutoReply, removePoolAccount } from '../whatsapp/pool.js';
import { listNumbers, accountGroup } from '../numbers.js';
import { keySource, aiProviderName } from '../ai.js';
import { emit } from '../events.js';
import { DEFAULT_WS, runInWs } from '../tenant.js';
import { getLimits, cleanLimits, enforceEverywhere, getWsDefaults, saveWsDefaults, defaultsOf, canAddPerson, clampSettings, DEFAULT_KEYS, LIMIT_DEFAULTS } from '../limits.js';
import { apiNumber, sendingSettings, saveSendingSettings, sendingBounds, cancelQueued, rekickLanes, usageToday } from '../developer.js';

export const admin = Router();

const emailRe = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const by = (req) => req.user.email;
// Super admin actions are logged as 'admin' in the workspace they affect (its own Audit Logs
// shows them too); ws null = the whole platform.
const audit = (ws, message, level = 'info') => auditLog('admin', message, { level, ws });

// ---- Workspaces ----

// One workspace's switches and numbers (read inside that workspace).
function wsDetail(id) {
  return runInWs(id, async () => {
    const numbers = await listNumbers();
    return {
      sendingPaused: !!getSetting('sendingPaused', false),
      warmupActive: !!getSetting('warmupActive', false),
      warmupNumbers: await db.warmupAccounts().countDocuments({ role: { $nin: ['conversation', 'api'] } }),
      numbers: numbers.map((n) => ({ id: n.id, label: n.label, name: n.name || '', phone: n.phone, connected: n.connected, auto_reply: n.auto_reply, default: n.default, main: n.id === 'main' })),
      contacts: await db.contacts().countDocuments({ synced: { $ne: 1 }, warmup: { $ne: 1 } }),
      chats: await db.contacts().countDocuments({ synced: 1 }),
      campaignsRunning: await db.campaigns().countDocuments({ status: 'running' }),
      sentToday: await db.messages().countDocuments({ direction: 'out', day_key: dayKey() }),
      ai: { provider: aiProviderName(), key: keySource() }, // whose AI key it uses (never the key)
      api: await apiDetail(),
    };
  });
}

// A workspace's Developer API, for the super admin (read inside that workspace).
async function apiDetail() {
  const n = await apiNumber();
  return {
    off: !!getSetting('apiOff', false),
    keys: await db.apiKeys().countDocuments({ revoked_at: null }),
    number: n ? { phone: n.phone, connected: n.connected, status: n.status } : null,
    sending: (({ per_batch, gap_seconds, max_queue }) => ({ per_batch, gap_seconds, max_queue }))(sendingSettings()),
    bounds: sendingBounds(),
    queued: await db.messages().countDocuments({ source: 'api', status: 'queued' }),
    sentToday: await usageToday(),
  };
}

// The super admin controls one workspace's Developer API: on/off, its sending settings, its
// queue and its API number.
admin.put('/workspaces/:id/developer', async (req, res) => {
  const w = wsOr404(req, res);
  if (!w) return;
  const b = req.body || {};
  try {
    const out = await runInWs(w.id, async () => {
      const notes = [];
      if ('apiOff' in b) {
        await setSetting('apiOff', !!b.apiOff);
        audit(w.id, `Developer API ${b.apiOff ? 'switched OFF' : 'switched on'} for this workspace by ${by(req)}${b.apiOff ? ' — API requests are refused and the queue waits' : ''}`, b.apiOff ? 'warn' : 'info');
        rekickLanes(w.id);
      }
      if (b.sending && typeof b.sending === 'object') {
        const r = await saveSendingSettings(b.sending, `${by(req)} (super admin)`);
        if (r.notes) notes.push(...r.notes);
      }
      if (b.cancelQueue) {
        const n = await cancelQueued(null, `${by(req)} (super admin)`);
        notes.push(`${n} queued message${n === 1 ? '' : 's'} cancelled`);
      }
      if (b.unlinkApiNumber) {
        const n = await apiNumber();
        if (n) {
          await removePoolAccount(n.id);
          await db.warmupAccounts().deleteOne({ _id: new ObjectId(n.id) });
          const dropped = n.phone ? await cancelQueued(null, `${by(req)} (super admin)`, { phone: n.phone }) : 0;
          audit(w.id, `API number${n.phone ? ` +${n.phone}` : ''} unlinked by ${by(req)} (super admin)${dropped ? ` — ${dropped} queued message${dropped === 1 ? '' : 's'} cancelled` : ''}`, 'warn');
        }
      }
      emit('pool:update', poolState());
      return { api: await apiDetail(), notes };
    });
    emit('admin:update', {}, { ws: null });
    res.json(out);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

const wsOr404 = (req, res) => {
  const w = workspaceOf(req.params.id);
  if (!w) res.status(404).json({ error: 'Workspace not found' });
  return w;
};

// Everything the Super Admin page shows in one call.
admin.get('/state', async (req, res) => {
  const all = await users().find({}, { sort: { createdAt: 1 } }).toArray();
  const workspaces = [];
  for (const w of listWorkspaces()) {
    const d = await wsDetail(w.id);
    workspaces.push({ ...w, main: w.id === DEFAULT_WS, team: all.filter((u) => u.role !== 'owner' && (u.ws || DEFAULT_WS) === w.id).length, ...d });
  }
  res.json({
    workspaces,
    users: all.map(publicUser),
    platform: {
      sendingPaused: !!getPlatform('sendingPaused', false),
      teamLocked: !!getPlatform('teamLocked', false),
      signup: signupMode(),
    },
    current: req.ws,
  });
});

// New workspace for a business (optionally with its first admin, who then adds their team).
admin.post('/workspaces', async (req, res) => {
  const name = String(req.body?.name || '').trim();
  if (!name) return res.status(400).json({ error: 'Give the workspace a name (e.g. the business name)' });
  if (listWorkspaces().some((w) => w.name.toLowerCase() === name.toLowerCase())) return res.status(409).json({ error: 'A workspace with that name already exists' });
  const a = req.body?.admin || null;
  if (a && (a.email || a.password)) {
    if (!emailRe.test(String(a.email || ''))) return res.status(400).json({ error: "Enter the admin's email" });
    if (String(a.password || '').length < 6) return res.status(400).json({ error: "The admin's password must be at least 6 characters" });
    if (await users().findOne({ email: String(a.email).toLowerCase().trim() })) return res.status(409).json({ error: 'An account with that email already exists' });
  }
  const w = await createWorkspace(name, getWsDefaults()); // starts with the super admin's defaults
  let adminUser = null;
  if (a && a.email) {
    const doc = {
      name: String(a.name || '').trim() || String(a.email).split('@')[0],
      email: String(a.email).toLowerCase().trim(),
      passwordHash: await hashPassword(String(a.password)),
      role: 'admin',
      ws: w.id,
      createdAt: new Date().toISOString(),
      lastLoginAt: null,
    };
    const r = await users().insertOne(doc);
    doc._id = r.insertedId;
    adminUser = publicUser(doc);
  }
  audit(w.id, `Workspace "${w.name}" created by ${by(req)}${adminUser ? ` with admin ${adminUser.email}` : ''}`);
  emit('admin:update', {}, { ws: null });
  res.json({ workspace: w, admin: adminUser });
});

admin.put('/workspaces/:id', async (req, res) => {
  const w = wsOr404(req, res);
  if (!w) return;
  const name = String(req.body?.name || '').trim();
  if (!name) return res.status(400).json({ error: 'Name required' });
  if (listWorkspaces().some((x) => x.id !== w.id && x.name.toLowerCase() === name.toLowerCase())) return res.status(409).json({ error: 'A workspace with that name already exists' });
  const fresh = await updateWorkspace(w.id, { name });
  audit(w.id, `Workspace renamed by ${by(req)}: "${w.name}" → "${name}"`);
  res.json({ workspace: fresh });
});

// Suspend: nobody in it can sign in (open sessions end at once), and it sends nothing
// automatically — no campaigns, no warm-up, no AI replies. Chats keep arriving.
admin.post('/workspaces/:id/suspend', async (req, res) => {
  const w = wsOr404(req, res);
  if (!w) return;
  const suspended = !!req.body?.suspended;
  // Re-activating a workspace that signed up and waits for approval approves it.
  await updateWorkspace(w.id, suspended ? { suspended } : { suspended, pending: false });
  forgetUser();
  const what = suspended ? 'suspended' : w.pending ? 'approved' : 're-activated';
  audit(w.id, `Workspace "${w.name}" ${what} by ${by(req)}`, suspended ? 'warn' : 'info');
  emit('admin:update', {}, { ws: null });
  res.json({ ok: true, suspended });
});

// Turn AI auto-reply on/off for every number of the current workspace.
async function setAutoReplyAll(enabled) {
  await setSetting('autoReplyEnabled', enabled); // the main number's switch (default workspace)
  const docs = await db.warmupAccounts().find({ role: 'conversation' }).toArray();
  for (const d of docs) {
    await db.warmupAccounts().updateOne({ _id: d._id }, { $set: { auto_reply: enabled } });
    setPoolAutoReply(String(d._id), enabled);
  }
  emit('pool:update', poolState());
}

// A workspace's switches: campaign sending, warm-up, AI auto-reply on every number.
admin.put('/workspaces/:id/system', async (req, res) => {
  const w = wsOr404(req, res);
  if (!w) return;
  const b = req.body || {};
  const err = await runInWs(w.id, async () => {
    if ('sendingPaused' in b) {
      setPaused(!!b.sendingPaused);
      audit(w.id, `Campaign sending ${b.sendingPaused ? 'paused' : 'resumed'} by ${by(req)}`, b.sendingPaused ? 'warn' : 'info');
    }
    if ('warmupActive' in b) {
      if (b.warmupActive) {
        const n = await db.warmupAccounts().countDocuments({ role: { $nin: ['conversation', 'api'] } });
        if (n < 2) return 'Link at least 2 numbers on the Warmup page first';
      }
      await setSetting('warmupActive', !!b.warmupActive);
      audit(w.id, `Warm-up ${b.warmupActive ? 'started' : 'stopped'} by ${by(req)}`);
    }
    if ('autoReply' in b) {
      await setAutoReplyAll(!!b.autoReply);
      audit(w.id, `AI auto-reply turned ${b.autoReply ? 'ON' : 'OFF'} on every number by ${by(req)}`);
    }
    emit('stats:dirty', {});
    return null;
  });
  if (err) return res.status(400).json({ error: err });
  res.json({ ok: true });
});

// One number's AI auto-reply (every link of that phone).
admin.post('/workspaces/:id/numbers/:nid/autoreply', async (req, res) => {
  const w = wsOr404(req, res);
  if (!w) return;
  const enabled = !!req.body?.enabled;
  await runInWs(w.id, async () => {
    for (const id of accountGroup(req.params.nid).ids) {
      if (id === 'main') {
        if (w.id === DEFAULT_WS) await setSetting('autoReplyEnabled', enabled);
      } else if (ObjectId.isValid(id)) {
        await db.warmupAccounts().updateOne({ _id: new ObjectId(id) }, { $set: { auto_reply: enabled } });
        setPoolAutoReply(id, enabled);
      }
    }
    emit('pool:update', poolState());
  });
  res.json({ ok: true, enabled });
});

// Emergency stop for one workspace: nothing goes out automatically until switched back on.
admin.post('/workspaces/:id/emergency-stop', async (req, res) => {
  const w = wsOr404(req, res);
  if (!w) return;
  await runInWs(w.id, () => stopEverything());
  audit(w.id, `EMERGENCY STOP by ${by(req)}: campaign sending paused, warm-up stopped, AI auto-reply off on every number`, 'warn');
  res.json({ ok: true });
});

async function stopEverything() {
  setPaused(true);
  await setSetting('warmupActive', false);
  await setAutoReplyAll(false);
  emit('stats:dirty', {});
}

// Delete a workspace and everything in it: its numbers are unlinked, and its contacts,
// chats, campaigns, templates, catalogs, settings, logs and people are removed. The name
// must be typed to confirm. The original workspace can't be deleted.
admin.delete('/workspaces/:id', async (req, res) => {
  const w = wsOr404(req, res);
  if (!w) return;
  if (w.id === DEFAULT_WS) return res.status(400).json({ error: "The original workspace can't be deleted" });
  if (String(req.body?.confirm || '').trim() !== w.name) return res.status(400).json({ error: `Type the workspace name ("${w.name}") to confirm` });
  await runInWs(w.id, async () => {
    for (const d of await db.warmupAccounts().find().toArray()) await removePoolAccount(String(d._id)).catch(() => {});
  });
  const removed = await deleteWorkspaceData(w.id);
  forgetUser();
  audit(null, `Workspace "${w.name}" deleted by ${by(req)} (${removed.users} people, ${removed.contacts} contacts, ${removed.messages} messages, ${removed.warmup_accounts} numbers)`, 'warn');
  emit('admin:update', {}, { ws: null });
  res.json({ ok: true, removed });
});

// ---- People ----

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
const wsName = (id) => workspaceOf(id || DEFAULT_WS)?.name || 'workspace';

// Change a person's name, role (admin/member), pages and workspace.
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
  let moved = false;
  if (b.ws && b.ws !== (u.ws || DEFAULT_WS)) {
    if (!workspaceOf(b.ws)) return res.status(400).json({ error: 'Workspace not found' });
    const full = await canAddPerson(String(b.ws));
    if (full) return res.status(400).json({ error: full });
    set.ws = String(b.ws);
    moved = true;
  }
  const upd = {};
  if (Object.keys(set).length) upd.$set = set;
  if (Object.keys(unset).length) upd.$unset = unset;
  if (moved) upd.$inc = { tokenVersion: 1 }; // moved to another business → sign in again there
  if (Object.keys(upd).length) await users().updateOne({ _id: u._id }, upd);
  forgetUser(u._id);
  const fresh = await users().findOne({ _id: u._id });
  const pages = Array.isArray(fresh.pages) ? fresh.pages.join(', ') || 'no pages' : 'all pages';
  audit(fresh.ws || DEFAULT_WS, `Access changed by ${by(req)}: ${u.email} → ${fresh.role}, ${pages}${moved ? `, moved from ${wsName(u.ws)} to ${wsName(fresh.ws)}` : ''}`);
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
  audit(u.ws || DEFAULT_WS, `${suspended ? 'Suspended' : 'Re-activated'} by ${by(req)}: ${u.email}`, suspended ? 'warn' : 'info');
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
  audit(u.ws || DEFAULT_WS, `Password reset by ${by(req)}: ${u.email}`, 'warn');
  res.json({ ok: true });
});

// Sign someone out on every device.
admin.post('/users/:id/signout', async (req, res) => {
  const u = await target(req, res);
  if (!u) return;
  await users().updateOne({ _id: u._id }, { $inc: { tokenVersion: 1 } });
  forgetUser(u._id);
  audit(u.ws || DEFAULT_WS, `Signed out everywhere by ${by(req)}: ${u.email}`);
  res.json({ ok: true });
});

// ---- Platform ----

// Platform switches: campaign sending in every workspace, everyone's sign-in.
admin.put('/system', async (req, res) => {
  const b = req.body || {};
  if ('sendingPaused' in b) {
    await setPlatform('sendingPaused', !!b.sendingPaused);
    audit(null, `Campaign sending ${b.sendingPaused ? 'paused in every workspace' : 'allowed again in every workspace'} by ${by(req)}`, b.sendingPaused ? 'warn' : 'info');
  }
  if ('signup' in b) {
    if (!SIGNUP_MODES.includes(b.signup)) return res.status(400).json({ error: 'Pick open, approval or off' });
    await setPlatform('signup', b.signup);
    const said = { open: 'open — new businesses start at once', approval: 'open with your approval', off: 'closed' }[b.signup];
    audit(null, `Public sign-up set to ${said} by ${by(req)}`);
  }
  if ('teamLocked' in b) {
    await setPlatform('teamLocked', !!b.teamLocked);
    forgetUser();
    audit(null, b.teamLocked ? `Sign-in paused for everyone by ${by(req)} — only the super admin can use the app` : `Sign-in re-opened for everyone by ${by(req)}`, b.teamLocked ? 'warn' : 'info');
  }
  res.json({ ok: true });
});

// Emergency stop for the whole platform: every workspace stops sending automatically.
admin.post('/emergency-stop', async (req, res) => {
  for (const w of listWorkspaces()) await runInWs(w.id, () => stopEverything());
  audit(null, `EMERGENCY STOP (all workspaces) by ${by(req)}: campaign sending paused, warm-up stopped, AI auto-reply off on every number`, 'warn');
  res.json({ ok: true });
});

// What the super admin (and the platform) did lately, across every workspace.
admin.get('/activity', async (req, res) => {
  const limit = Math.min(Math.max(Number(req.query.limit) || 15, 1), 100);
  const list = await col('audit_logs').find({ type: 'admin' }).sort({ _id: -1 }).limit(limit).toArray();
  res.json(list.map(({ _id, ws, ...a }) => ({ id: String(_id), ...a, ws: ws || null, wsName: ws ? workspaceOf(ws)?.name || '(deleted workspace)' : 'All workspaces' })));
});

// ---- Rules for every workspace + settings new workspaces start with ----

admin.get('/rules', (_req, res) => {
  res.json({ limits: getLimits(), limitDefaults: LIMIT_DEFAULTS, defaults: getWsDefaults(), defaultKeys: DEFAULT_KEYS });
});

// Save the rules, then bring every workspace's settings and campaigns inside them.
admin.put('/limits', async (req, res) => {
  let next;
  try {
    next = cleanLimits(req.body || {});
  } catch (e) {
    return res.status(400).json({ error: e.message });
  }
  await setPlatform('limits', next);
  const fixed = await enforceEverywhere(next);
  // keep the new-workspace defaults inside the rules too
  await saveWsDefaults(getWsDefaults());
  const parts = [
    next.minDelaySec ? `≥${next.minDelaySec}s between messages` : 'no minimum gap',
    next.maxPerNumberDay ? `≤${next.maxPerNumberDay}/day per number` : 'no daily maximum',
    next.windowStart || next.windowEnd ? `hours ${next.windowStart || 'any'}–${next.windowEnd || 'any'}` : 'any hours',
    next.maxNumbers ? `≤${next.maxNumbers} numbers` : null,
    next.maxTeam ? `≤${next.maxTeam} people` : null,
    next.allowAi ? null : 'AI off',
    next.allowApi ? null : 'Developer API off',
    next.apiMaxPerBatch ? `API ≤${next.apiMaxPerBatch} at a time` : null,
    next.apiMinGapSec ? `API ≥${next.apiMinGapSec}s between batches` : null,
    next.apiMaxQueue ? `API queue ≤${next.apiMaxQueue}` : null,
  ].filter(Boolean);
  audit(null, `Rules for every workspace changed by ${by(req)}: ${parts.join(', ')}${fixed.settings || fixed.campaigns ? ` — adjusted ${fixed.settings} workspace setting${fixed.settings === 1 ? '' : 's'} and ${fixed.campaigns} campaign value${fixed.campaigns === 1 ? '' : 's'}` : ''}`);
  emit('admin:update', {}, { ws: null });
  res.json({ limits: next, fixed });
});

// The settings every NEW workspace starts with.
admin.put('/defaults', async (req, res) => {
  const { defaults, notes } = await saveWsDefaults(req.body || {});
  audit(null, `Settings for new workspaces changed by ${by(req)}`);
  res.json({ defaults, notes });
});

// Give every EXISTING workspace these settings too (overwrites theirs for these fields).
admin.post('/defaults/apply', async (req, res) => {
  const d = getWsDefaults();
  const only = Array.isArray(req.body?.keys) && req.body.keys.length ? req.body.keys.filter((k) => DEFAULT_KEYS.includes(k)) : DEFAULT_KEYS;
  let n = 0;
  for (const w of listWorkspaces()) {
    await runInWs(w.id, async () => {
      const { settings } = clampSettings(Object.fromEntries(only.filter((k) => k in d).map((k) => [k, d[k]])));
      for (const [k, v] of Object.entries(settings)) await setSetting(k, v);
    });
    n++;
  }
  audit(null, `Default settings applied to all ${n} workspaces by ${by(req)}`, 'warn');
  res.json({ ok: true, workspaces: n });
});

// One workspace's current settings (to start the defaults from them).
admin.get('/workspaces/:id/settings', async (req, res) => {
  const w = wsOr404(req, res);
  if (!w) return;
  res.json(await runInWs(w.id, () => defaultsOf()));
});
