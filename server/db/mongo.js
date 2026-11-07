import { MongoClient, ObjectId } from 'mongodb';
import { MONGODB_URI, MONGODB_DB, DEFAULTS } from '../config.js';
import { nowInTz } from '../utils.js';
import { hashPassword } from '../auth.js';

export const mongoState = {
  connected: false,
  error: null,
  uri: MONGODB_URI.replace(/\/\/([^@]+)@/, '//***@'), // hide credentials
};

let client = null;
let dbRef = null;
let retryTimer = null;

// Settings are cached in memory (seeded with defaults) so reads stay synchronous.
let settingsCache = { ...DEFAULTS };

// ---- Connection ----
export async function connectMongo() {
  try {
    client = new MongoClient(MONGODB_URI, { serverSelectionTimeoutMS: 4000 });
    await client.connect();
    dbRef = client.db(MONGODB_DB);
    await dbRef.command({ ping: 1 });

    await ensureIndexes();
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
  await col('contacts').createIndex({ phone: 1 }, { unique: true });
  // Speeds the paginated Contacts list (warm-up contacts excluded, newest first) + its count.
  await col('contacts').createIndex({ warmup: 1, _id: -1 });
  await col('contacts').createIndex({ warmup: 1, status: 1, _id: -1 });
  await col('campaign_targets').createIndex(
    { campaign_id: 1, contact_id: 1 },
    { unique: true }
  );
  await col('campaign_targets').createIndex({ campaign_id: 1, status: 1 });
  await col('messages').createIndex({ contact_id: 1, created_at: 1 });
  await col('messages').createIndex({ direction: 1, day_key: 1 });
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

// ---- Collection access ----
export function col(name) {
  if (!dbRef) throw new Error('Database unavailable — is MongoDB running?');
  return dbRef.collection(name);
}

export const db = {
  contacts: () => col('contacts'),
  templates: () => col('templates'),
  campaigns: () => col('campaigns'),
  targets: () => col('campaign_targets'),
  messages: () => col('messages'),
  auditLogs: () => col('audit_logs'),
  users: () => col('users'),
  warmupAccounts: () => col('warmup_accounts'),
  warmupLog: () => col('warmup_log'),
};

// Kept for routes/auth.js which imports `users`.
export function users() {
  return col('users');
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

// YYYY-MM-DD in the configured (or given) timezone — used for daily counters.
export function dayKey(tz) {
  return nowInTz(tz || settingsCache.timezone || 'Asia/Karachi').date;
}

// ---- Settings (cached) ----
async function loadSettings() {
  const doc = await col('settings').findOne({ _id: 'global' });
  if (!doc) {
    await col('settings').insertOne({ _id: 'global', ...DEFAULTS });
    settingsCache = { ...DEFAULTS };
  } else {
    const { _id, ...vals } = doc;
    settingsCache = { ...DEFAULTS, ...vals };
  }
}

export function getSetting(key, fallback = null) {
  return key in settingsCache ? settingsCache[key] : fallback;
}
export function getAllSettings() {
  return { ...settingsCache };
}
export async function setSetting(key, value) {
  settingsCache[key] = value;
  if (isMongoUp()) {
    await col('settings').updateOne(
      { _id: 'global' },
      { $set: { [key]: value } },
      { upsert: true }
    );
  }
}

// ---- Audit (fire-and-forget) ----
export function audit(type, message, { level = 'info', meta = null } = {}) {
  if (!isMongoUp()) {
    console.log(`[audit:${level}] ${type}: ${message}`);
    return;
  }
  col('audit_logs')
    .insertOne({
      level,
      type,
      message,
      meta,
      created_at: nowIso(),
      day_key: dayKey(),
    })
    .catch(() => {});
}
