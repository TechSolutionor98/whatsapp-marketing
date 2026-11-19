import { MongoClient, ObjectId } from 'mongodb';
import { MONGODB_URI, MONGODB_DB, DEFAULTS, PLATFORM_DEFAULTS } from '../config.js';
import { nowInTz } from '../utils.js';
import { hashPassword } from '../auth.js';
import { DEFAULT_WS, currentWs, STRICT_WS } from '../tenant.js';

export const mongoState = {
  connected: false,
  error: null,
  uri: MONGODB_URI.replace(/\/\/([^@]+)@/, '//***@'), // hide credentials
};

let client = null;
let dbRef = null;
let retryTimer = null;

// Settings are cached in memory so reads stay synchronous: one set per workspace (seeded with
// DEFAULTS), plus the platform switches only the super admin changes.
const settingsByWs = new Map(); // workspace id -> settings
let platformCache = { ...PLATFORM_DEFAULTS };

// ---- Connection ----
export async function connectMongo() {
  try {
    client = new MongoClient(MONGODB_URI, { serverSelectionTimeoutMS: 4000 });
    await client.connect();
    dbRef = client.db(MONGODB_DB);
    await dbRef.command({ ping: 1 });

    await migrateToWorkspaces();
    await ensureIndexes();
    await loadWorkspaces();
    await loadSettings();
    await ensureSuperadmin();

    mongoState.connected = true;
    mongoState.error = null;
    clearTimeout(retryTimer);
    audit('system', 'Connected to MongoDB', { level: 'success' });
    console.log('  MongoDB connected →', mongoState.uri);
  } catch (err) {
    mongoState.connected = false;
    mongoState.error = err.message;
    dbRef = null;
    try {
      await client?.close();
    } catch {}
    client = null;
    clearTimeout(retryTimer);
    retryTimer = setTimeout(connectMongo, 8000);
    console.log('  MongoDB not reachable (will retry):', err.message);
  }
}

async function ensureIndexes() {
  await col('users').createIndex({ email: 1 }, { unique: true });
  await col('users').createIndex({ ws: 1 });
  // A phone number is unique per workspace (two businesses can both have the same customer).
  // Replaces the first version's app-wide unique phone index — the new one is built first, so
  // a contact saved meanwhile can never slip in a duplicate.
  await col('contacts').createIndex({ ws: 1, phone: 1 }, { unique: true });
  await col('contacts').dropIndex('phone_1').catch(() => {});
  await col('contacts').createIndex({ ws: 1, _id: -1 });
  await col('messages').createIndex({ ws: 1, direction: 1, day_key: 1 });
  await col('campaign_targets').createIndex({ ws: 1, status: 1 });
  await col('campaigns').createIndex({ ws: 1, status: 1 });
  await col('audit_logs').createIndex({ ws: 1, _id: -1 });
  await col('audit_logs').createIndex({ type: 1, _id: -1 });
  await col('warmup_log').createIndex({ ws: 1, day_key: 1 });
  // Speeds the paginated Contacts list (warm-up contacts excluded, newest first) + its count.
  await col('contacts').createIndex({ warmup: 1, _id: -1 });
  await col('contacts').createIndex({ warmup: 1, status: 1, _id: -1 });
  await col('contacts').createIndex({ list_ids: 1 }); // membership lookups for lists + campaigns
  await col('lists').createIndex({ name: 1 });
  await col('campaign_targets').createIndex(
    { campaign_id: 1, contact_id: 1 },
    { unique: true }
  );
  await col('campaign_targets').createIndex({ campaign_id: 1, status: 1 });
  await col('messages').createIndex({ contact_id: 1, created_at: 1 });
  await col('messages').createIndex({ direction: 1, day_key: 1 });
  // Dedup key for history sync + outgoing echoes (many nulls on legacy rows → sparse).
  await col('messages').createIndex({ wa_message_id: 1 }, { sparse: true });
  // Conversation tabs match chats by the linked number's phone.
  await col('messages').createIndex({ account_phone: 1, created_at: 1 }, { sparse: true });
  // WhatsApp @lid identities: contacts keep their lid, and lid_map remembers lid -> real number/name.
  await col('contacts').createIndex({ lid: 1 }, { sparse: true });
  await col('contacts').createIndex({ jid: 1 }, { sparse: true });
  // Product catalog (AI replies look products up by name/brand/category/sku).
  // Products are unique per catalog (several catalogs can share ids). Drop the first
  // version's global unique index if it exists.
  await col('products').dropIndex('ext_id_1').catch(() => {});
  await col('products').createIndex({ catalog_id: 1, ext_id: 1 }, { unique: true });
  // Word search over name/sku/brand/category + tags/Arabic name (keywords). The first version had
  // no keywords — replace that index when its fields differ (only one text index is allowed).
  const productWeights = { brand: 5, category: 4, description: 1, keywords: 2, keywords_ar: 2, name: 10, sku: 8 };
  const oldSearch = (await col('products').indexes().catch(() => [])).find((i) => i.name === 'product_search');
  const sameWeights = (w = {}) => JSON.stringify(Object.keys(w).sort().map((k) => [k, w[k]])) === JSON.stringify(Object.entries(productWeights));
  if (oldSearch && !sameWeights(oldSearch.weights)) await col('products').dropIndex('product_search').catch(() => {});
  await col('products').createIndex(
    { name: 'text', brand: 'text', category: 'text', sku: 'text', keywords: 'text', keywords_ar: 'text', description: 'text' },
    { name: 'product_search', weights: productWeights, default_language: 'none' }
  );
  await col('audit_logs').createIndex({ created_at: -1 });
  await col('warmup_log').createIndex({ day_key: 1 });
  await col('warmup_log').createIndex({ created_at: -1 });
}

// Seed/ensure the superadmin (owner) account from SUPERADMIN_* env vars.
// Runs on every connect but only creates the account if it doesn't exist yet,
// so an admin can change the password later without it being reset.
async function ensureSuperadmin() {
  const email = process.env.SUPERADMIN_EMAIL;
  const password = process.env.SUPERADMIN_PASSWORD;
  if (!email || !password) return;
  const addr = email.toLowerCase().trim();
  const existing = await col('users').findOne({ email: addr });
  if (existing) return;
  await col('users').insertOne({
    name: process.env.SUPERADMIN_NAME || addr.split('@')[0],
    email: addr,
    passwordHash: await hashPassword(password),
    role: 'owner',
    createdAt: new Date().toISOString(),
    lastLoginAt: null,
  });
  console.log('  Superadmin account created:', addr);
}

export function isMongoUp() {
  return mongoState.connected;
}

// ---- Workspaces ----
// Collections whose documents belong to one workspace (field `ws`).
export const TENANT_COLLECTIONS = [
  'contacts', 'lists', 'templates', 'campaigns', 'campaign_targets', 'messages',
  'audit_logs', 'warmup_accounts', 'warmup_log', 'catalogs', 'products',
];

// One-time move to workspaces: everything that existed before belongs to the default
// workspace (the business that was using the app), and so does every existing account.
async function migrateToWorkspaces() {
  if (!(await col('workspaces').findOne({ _id: DEFAULT_WS }))) {
    await col('workspaces').insertOne({
      _id: DEFAULT_WS,
      name: process.env.DEFAULT_WORKSPACE_NAME || 'Tech Solutionor',
      suspended: false,
      created_at: nowIso(),
    });
  }
  const plat = await col('settings').findOne({ _id: 'platform' });
  if (plat?.wsMigrated) return;
  for (const name of TENANT_COLLECTIONS) {
    const r = await col(name).updateMany({ ws: { $exists: false } }, { $set: { ws: DEFAULT_WS } });
    if (r.modifiedCount) console.log(`  Workspaces: ${r.modifiedCount} ${name} moved to the default workspace`);
  }
  await col('users').updateMany({ role: { $ne: 'owner' }, ws: { $exists: false } }, { $set: { ws: DEFAULT_WS } });
  // "Team sign-in paused" was a single-business switch; it is a platform switch now.
  const old = await col('settings').findOne({ _id: 'global' }, { projection: { teamLocked: 1 } });
  await col('settings').updateOne(
    { _id: 'platform' },
    { $set: { wsMigrated: nowIso(), ...(old?.teamLocked ? { teamLocked: true } : {}) } },
    { upsert: true }
  );
}

const wsCache = new Map(); // id -> { id, name, suspended, created_at }
async function loadWorkspaces() {
  const list = await col('workspaces').find({}).sort({ created_at: 1 }).toArray();
  wsCache.clear();
  for (const w of list) wsCache.set(String(w._id), wsPub(w));
}
const wsPub = (w) => ({ id: String(w._id), name: w.name || 'Workspace', suspended: !!w.suspended, created_at: w.created_at || null });

export function listWorkspaces() {
  return [...wsCache.values()];
}
export function workspaceOf(id) {
  return (id && wsCache.get(String(id))) || null;
}
export function isWsSuspended(id) {
  return !!wsCache.get(String(id || ''))?.suspended;
}

// A new workspace starts with DEFAULTS plus the super admin's "new workspace" settings.
export async function createWorkspace(name, startSettings = {}) {
  const id = String(new ObjectId());
  const doc = { _id: id, name: String(name || '').trim() || 'New workspace', suspended: false, created_at: nowIso() };
  const settings = { ...DEFAULTS, ...startSettings };
  await col('workspaces').insertOne(doc);
  await col('settings').updateOne({ _id: settingsDocId(id) }, { $setOnInsert: settings }, { upsert: true });
  settingsByWs.set(id, { ...settings });
  wsCache.set(id, wsPub(doc));
  return wsPub(doc);
}

export async function updateWorkspace(id, set) {
  await col('workspaces').updateOne({ _id: String(id) }, { $set: set });
  const doc = await col('workspaces').findOne({ _id: String(id) });
  if (doc) wsCache.set(String(id), wsPub(doc));
  return doc ? wsPub(doc) : null;
}

// Delete a workspace and everything in it (its numbers must be unlinked first by the caller).
export async function deleteWorkspaceData(id) {
  const ws = String(id);
  if (ws === DEFAULT_WS) throw new Error("The original workspace can't be deleted");
  const removed = {};
  for (const name of TENANT_COLLECTIONS) removed[name] = (await col(name).deleteMany({ ws })).deletedCount;
  removed.users = (await col('users').deleteMany({ ws, role: { $ne: 'owner' } })).deletedCount;
  await col('settings').deleteOne({ _id: settingsDocId(ws) });
  await col('workspaces').deleteOne({ _id: ws });
  settingsByWs.delete(ws);
  wsCache.delete(ws);
  return removed;
}

// ---- Collection access ----
export function col(name) {
  if (!dbRef) throw new Error('Database unavailable — is MongoDB running?');
  return dbRef.collection(name);
}

// The workspace a query runs for. Outside any workspace it falls back to the default one
// (and says so in the server log); tests make that an error instead.
const warned = new Set();
function wsForQuery(what) {
  const ws = currentWs();
  if (ws) return ws;
  if (STRICT_WS) throw new Error(`No workspace for ${what}`);
  const where = (new Error().stack || '').split('\n')[4]?.trim() || '?'; // the caller of db.<collection>()
  if (!warned.has(where)) {
    warned.add(where);
    console.warn(`  [workspace] ${what} used outside a workspace — default workspace assumed (${where})`);
  }
  return DEFAULT_WS;
}

// A collection seen through one workspace: every filter gets `ws`, every new document gets
// `ws`, every aggregation starts with a match on it. Upserts keep it too (equality fields of
// the filter are copied into the inserted document).
function scoped(name) {
  const c = col(name);
  const ws = wsForQuery(name);
  const f = (filter) => ({ ...(filter || {}), ws });
  const op = (o) => {
    const [kind, body] = Object.entries(o)[0];
    if (kind === 'insertOne') return { insertOne: { ...body, document: Object.assign(body.document, { ws }) } };
    return { [kind]: { ...body, filter: f(body.filter) } };
  };
  return {
    ws,
    raw: c,
    find: (filter, opts) => c.find(f(filter), opts),
    findOne: (filter, opts) => c.findOne(f(filter), opts),
    countDocuments: (filter, opts) => c.countDocuments(f(filter), opts),
    updateOne: (filter, upd, opts) => c.updateOne(f(filter), upd, opts),
    updateMany: (filter, upd, opts) => c.updateMany(f(filter), upd, opts),
    deleteOne: (filter, opts) => c.deleteOne(f(filter), opts),
    deleteMany: (filter, opts) => c.deleteMany(f(filter), opts),
    findOneAndUpdate: (filter, upd, opts) => c.findOneAndUpdate(f(filter), upd, opts),
    insertOne: (doc, opts) => c.insertOne(Object.assign(doc, { ws }), opts),
    insertMany: (docs, opts) => c.insertMany(docs.map((d) => Object.assign(d, { ws })), opts),
    aggregate: (pipeline, opts) => c.aggregate([{ $match: { ws } }, ...(pipeline || [])], opts),
    bulkWrite: (ops, opts) => c.bulkWrite(ops.map(op), opts),
  };
}

export const db = {
  contacts: () => scoped('contacts'),
  lists: () => scoped('lists'),
  templates: () => scoped('templates'),
  campaigns: () => scoped('campaigns'),
  targets: () => scoped('campaign_targets'),
  messages: () => scoped('messages'),
  auditLogs: () => scoped('audit_logs'),
  users: () => col('users'), // accounts are platform-wide (each has a `ws`; the super admin has none)
  warmupAccounts: () => scoped('warmup_accounts'),
  warmupLog: () => scoped('warmup_log'),
  // WhatsApp's own @lid -> number facts, shared by every number on the platform:
  // { _id: '<lid>@lid', pn: '<phone>@s.whatsapp.net', names, notify }
  lidMap: () => col('lid_map'),
  products: () => scoped('products'), // catalog products for AI replies (catalog.js)
  catalogs: () => scoped('catalogs'), // product catalogs: API-synced or manual
};

// Kept for routes/auth.js which imports `users`.
export function users() {
  return col('users');
}

// ---- "Needs a person" (handoff) ----
// It belongs to ONE chat — this person on ONE of your numbers — so a handoff on one number
// doesn't show on the others (real case: a message to one number flagged the same person in
// every number's tab). contact.handoffs = { [your number]: reason }; contact.handoff stays 1
// while any number needs a person (dashboard count, campaigns skip them).
export async function setHandoff(contactId, phone, reason) {
  const $set = { handoff: 1, handoff_reason: reason };
  if (phone) $set[`handoffs.${phone}`] = reason;
  await db.contacts().updateOne({ _id: oid(contactId) }, { $set });
}
export async function clearHandoff(contactId, phone) {
  const _id = oid(contactId);
  const c = await db.contacts().findOne({ _id }, { projection: { handoffs: 1 } });
  if (!c) return;
  const map = { ...(c.handoffs || {}) };
  if (phone && Object.keys(map).length) delete map[phone]; // only this number's chat (none here → nothing changes)
  else for (const k of Object.keys(map)) delete map[k]; // an older flag with no number, or no tab given → clear it
  const left = Object.values(map);
  await db.contacts().updateOne({ _id }, { $set: { handoffs: map, handoff: left.length ? 1 : 0, handoff_reason: left.length ? left[left.length - 1] : '' } });
}
// The handoff reason for this person in ONE number's tab ('' = none). Flags from before this
// change (no number recorded) still show everywhere until resolved.
export function handoffFor(contact, phone) {
  const map = contact?.handoffs;
  if (map && Object.keys(map).length) return (phone && map[phone]) || '';
  return contact?.handoff === 1 ? contact.handoff_reason || 'reply' : '';
}

// ---- Helpers ----
export function oid(id) {
  try {
    return new ObjectId(String(id));
  } catch {
    return null;
  }
}

// Map a Mongo doc to an API doc: _id -> id (string).
export function pub(doc) {
  if (!doc) return doc;
  const { _id, ...rest } = doc;
  return { id: String(_id), ...rest };
}
export function pubList(docs) {
  return docs.map(pub);
}

export function nowIso() {
  return new Date().toISOString();
}

// YYYY-MM-DD in the workspace's (or the given) timezone — used for daily counters.
export function dayKey(tz) {
  return nowInTz(tz || cacheFor(currentWs() || DEFAULT_WS).timezone || 'Asia/Karachi').date;
}

// ---- Settings (cached, per workspace) ----
// The default workspace keeps the original document ('global'); others are 'ws:<id>'.
// 'platform' holds the super admin's platform-wide switches.
const settingsDocId = (ws) => (ws === DEFAULT_WS ? 'global' : `ws:${ws}`);

async function loadSettings() {
  const docs = await col('settings').find({}).toArray();
  settingsByWs.clear();
  for (const d of docs) {
    const { _id, ...vals } = d;
    if (_id === 'platform') platformCache = { ...PLATFORM_DEFAULTS, ...vals };
    else if (_id === 'global') settingsByWs.set(DEFAULT_WS, { ...DEFAULTS, ...vals });
    else if (String(_id).startsWith('ws:')) settingsByWs.set(String(_id).slice(3), { ...DEFAULTS, ...vals });
  }
  if (!settingsByWs.has(DEFAULT_WS)) {
    await col('settings').updateOne({ _id: 'global' }, { $setOnInsert: { ...DEFAULTS } }, { upsert: true });
    settingsByWs.set(DEFAULT_WS, { ...DEFAULTS });
  }
}

function cacheFor(ws) {
  let c = settingsByWs.get(ws);
  if (!c) {
    c = { ...DEFAULTS };
    settingsByWs.set(ws, c);
  }
  return c;
}
const settingsWs = () => currentWs() || (STRICT_WS ? wsForQuery('settings') : DEFAULT_WS);

export function getSetting(key, fallback = null) {
  const c = cacheFor(settingsWs());
  return key in c ? c[key] : fallback;
}
export function getAllSettings() {
  return { ...cacheFor(settingsWs()) };
}
export async function setSetting(key, value) {
  const ws = settingsWs();
  cacheFor(ws)[key] = value;
  if (isMongoUp()) {
    await col('settings').updateOne({ _id: settingsDocId(ws) }, { $set: { [key]: value } }, { upsert: true });
  }
}

// Platform switches (super admin only): pause all sending, pause everyone's sign-in.
export function getPlatform(key, fallback = null) {
  return key in platformCache ? platformCache[key] : fallback;
}
export async function setPlatform(key, value) {
  platformCache[key] = value;
  if (isMongoUp()) await col('settings').updateOne({ _id: 'platform' }, { $set: { [key]: value } }, { upsert: true });
}

// ---- Audit (fire-and-forget) ----
// Logged in the current workspace; `ws: null` (or no workspace) = platform level, shown only
// to the super admin.
export function audit(type, message, { level = 'info', meta = null, ws } = {}) {
  if (!isMongoUp()) {
    console.log(`[audit:${level}] ${type}: ${message}`);
    return;
  }
  const w = ws !== undefined ? ws : currentWs();
  col('audit_logs')
    .insertOne({
      ws: w || null,
      level,
      type,
      message,
      meta,
      created_at: nowIso(),
      day_key: dayKey(),
    })
    .catch(() => {});
}
