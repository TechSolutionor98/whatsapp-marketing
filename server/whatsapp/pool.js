import fs from 'node:fs';
import path from 'node:path';
import QRCode from 'qrcode';
import pino from 'pino';
import makeWASocket, {
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
  DisconnectReason,
  Browsers,
} from 'baileys';

import { DATA_DIR } from '../config.js';
import { db, audit, oid, getSetting, nowIso, dayKey } from '../db/mongo.js';
import { emit } from '../events.js';
import { attachReceipts } from '../receipts.js';
import { aiAvailable, conversationReply } from '../ai.js';
import { getWaState } from './client.js';
import { jidToPhone, normalizePhone, randInt } from '../utils.js';

const POOL_DIR = path.join(DATA_DIR, 'wa_pool');
const logger = pino({ level: 'silent' });

// id -> runtime { id, label, sock, status, qr, me, lastError, starting, manualLogout, reconnectTimer }
const accounts = new Map();

function authDir(id) {
  return path.join(POOL_DIR, id);
}

export function poolState() {
  return [...accounts.values()].map((a) => ({
    id: a.id,
    label: a.label || '',
    role: a.role || 'warmup',
    auto_reply: !!a.autoReply,
    status: a.status,
    qr: a.qr || null,
    me: a.me || null,
    lastError: a.lastError || null,
  }));
}

// Warm-up / campaign-sender numbers only (conversation-only numbers are excluded).
export function connectedAccounts() {
  return [...accounts.values()].filter(
    (a) => a.status === 'connected' && a.sock && a.me?.phone && (a.role || 'warmup') !== 'conversation'
  );
}

function emitPool() {
  emit('pool:update', poolState());
}

export async function startPoolAccount(id, label = '', role = 'warmup', autoReply = false) {
  let a = accounts.get(id);
  if (a?.sock) return; // already live
  if (!a) {
    a = { id, label, role, autoReply, status: 'connecting', qr: null, me: null };
    accounts.set(id, a);
  }
  if (label) a.label = label;
  if (role) a.role = role;
  a.autoReply = !!autoReply;
  a.starting = true;
  a.manualLogout = false;
  a.status = 'connecting';
  a.qr = null;
  clearTimeout(a.reconnectTimer);
  emitPool();

  try {
    fs.mkdirSync(authDir(id), { recursive: true });
    const { state, saveCreds } = await useMultiFileAuthState(authDir(id));
    const { version } = await fetchLatestBaileysVersion();
    const isConv = (a.role || role) === 'conversation';
    const sock = makeWASocket({
      version,
      auth: state,
      logger,
      browser: Browsers.appropriate('Desktop'),
      printQRInTerminal: false,
      markOnlineOnConnect: false,
      syncFullHistory: isConv, // conversation-only numbers pull their chat history on link
    });
    a.sock = sock;
    sock.ev.on('creds.update', saveCreds);
    attachReceipts(sock); // delivery/read receipts for campaigns sent from this number
    sock.ev.on('messages.upsert', (ev) => ingestPool(id, ev)); // capture this number's own chats
    if (isConv) {
      sock.ev.on('messaging-history.set', (ev) => ingestPoolHistory(id, ev)); // import its existing chats
    }

    sock.ev.on('connection.update', async (u) => {
      const { connection, lastDisconnect, qr } = u;
      if (qr) {
        a.qr = await QRCode.toDataURL(qr, { margin: 1, width: 280 });
        a.status = 'qr';
        emitPool();
      }
      if (connection === 'open') {
        a.me = { phone: jidToPhone(sock.user?.id), name: sock.user?.name || '' };
        a.status = 'connected';
        a.qr = null;
        a.lastError = null;
        try {
          await db.warmupAccounts().updateOne(
            { _id: oid(id) },
            { $set: { phone: a.me.phone, name: a.me.name } }
          );
        } catch {}
        audit('warmup', `Warm-up number linked: ${a.me.name || a.me.phone}`, { level: 'success' });
        emitPool();
      }
      if (connection === 'close') {
        const code =
          lastDisconnect?.error?.output?.statusCode ||
          lastDisconnect?.error?.output?.payload?.statusCode;
        const loggedOut = code === DisconnectReason.loggedOut || a.manualLogout;
        a.sock = null;
        a.starting = false;
        if (loggedOut) {
          try {
            fs.rmSync(authDir(id), { recursive: true, force: true });
          } catch {}
          a.status = 'disconnected';
          a.me = null;
          emitPool();
        } else {
          a.status = 'connecting';
          emitPool();
          a.reconnectTimer = setTimeout(() => startPoolAccount(id, a.label), 3000);
        }
      }
    });
  } catch (e) {
    a.starting = false;
    a.sock = null;
    a.status = 'disconnected';
    a.lastError = e.message;
    emitPool();
    a.reconnectTimer = setTimeout(() => startPoolAccount(id, a.label), 5000);
  } finally {
    a.starting = false;
  }
}

export async function removePoolAccount(id) {
  const a = accounts.get(id);
  if (a) {
    a.manualLogout = true;
    clearTimeout(a.reconnectTimer);
    try {
      if (a.sock) await a.sock.logout();
    } catch {}
    a.sock = null;
  }
  try {
    fs.rmSync(authDir(id), { recursive: true, force: true });
  } catch {}
  accounts.delete(id);
  emitPool();
}

export function isAccountConnected(id) {
  const a = accounts.get(id);
  return !!(a && a.status === 'connected' && a.sock);
}

// Update a running account's display label (so poolState reflects it immediately).
export function setPoolLabel(id, label) {
  const a = accounts.get(id);
  if (a) a.label = label;
}

// Per-account AI auto-reply toggle.
export function setPoolAutoReply(id, enabled) {
  const a = accounts.get(id);
  if (a) a.autoReply = !!enabled;
}

export async function checkOnWhatsAppVia(fromId, phone) {
  const a = accounts.get(fromId);
  if (!a?.sock || a.status !== 'connected') return { exists: false, reason: 'not_connected' };
  try {
    const res = await a.sock.onWhatsApp(`${normalizePhone(phone)}@s.whatsapp.net`);
    const hit = Array.isArray(res) && res[0]?.exists;
    return { exists: !!hit, jid: hit ? res[0].jid : null };
  } catch (err) {
    return { exists: false, reason: err.message };
  }
}

export async function sendFromTo(fromId, toPhone, text) {
  const a = accounts.get(fromId);
  if (!a?.sock || a.status !== 'connected') throw new Error('Source number not connected');
  const jid = `${normalizePhone(toPhone)}@s.whatsapp.net`;
  await a.sock.sendPresenceUpdate('composing', jid).catch(() => {});
  const sent = await a.sock.sendMessage(jid, { text });
  return sent?.key?.id || null;
}

export async function sendMediaFromTo(fromId, toPhone, buffer, caption) {
  const a = accounts.get(fromId);
  if (!a?.sock || a.status !== 'connected') throw new Error('Source number not connected');
  const jid = `${normalizePhone(toPhone)}@s.whatsapp.net`;
  const sent = await a.sock.sendMessage(jid, { image: buffer, caption: caption || undefined });
  return sent?.key?.id || null;
}

// ---- Per-account inbound: capture chats for this pool number (not warm-up traffic) ----
function textOf(msg) {
  const m = msg.message;
  if (!m) return '';
  return (
    m.conversation ||
    m.extendedTextMessage?.text ||
    m.imageMessage?.caption ||
    m.videoMessage?.caption ||
    m.buttonsResponseMessage?.selectedDisplayText ||
    m.listResponseMessage?.title ||
    ''
  );
}
function pnOf(msg) {
  const k = msg.key || {};
  for (const j of [k.remoteJid, k.remoteJidAlt, k.senderPn, k.participantAlt]) {
    if (typeof j === 'string' && j.endsWith('@s.whatsapp.net')) return j;
  }
  return k.remoteJid || '';
}
// Our own numbers (pool + main) — chats between them are warm-up, not conversations.
function ourPhones() {
  const set = new Set();
  for (const a of accounts.values()) if (a.me?.phone) set.add(a.me.phone);
  try {
    const w = getWaState();
    if (w?.me?.phone) set.add(w.me.phone);
  } catch {}
  return set;
}

async function poolAutoReply(accountId, contact, phone) {
  try {
    const history = await db
      .messages()
      .find({ contact_id: String(contact._id) })
      .sort({ _id: 1 })
      .limit(14)
      .toArray();
    const reply = (await conversationReply(history.map((m) => ({ direction: m.direction, body: m.body })))).trim();
    if (!reply) throw new Error('empty reply');
    const minS = getSetting('autoReplyMinSec', 5);
    const maxS = getSetting('autoReplyMaxSec', 30);
    const waitMs = randInt(Math.max(0, minS), Math.max(minS, maxS)) * 1000;
    if (waitMs > 0) await new Promise((r) => setTimeout(r, waitMs));
    const waId = await sendFromTo(accountId, phone, reply);
    await db.messages().insertOne({
      contact_id: String(contact._id),
      campaign_id: null,
      account_id: accountId,
      direction: 'out',
      body: reply,
      status: 'sent',
      wa_message_id: waId,
      ai_auto: true,
      created_at: nowIso(),
      day_key: dayKey(),
    });
    await db.contacts().updateOne({ _id: contact._id }, { $set: { last_outbound_at: nowIso() } });
    emit('message:out', { contactId: String(contact._id) });
  } catch (err) {
    await db.contacts().updateOne({ _id: contact._id }, { $set: { handoff: 1, handoff_reason: 'reply' } });
    audit('handoff', `AI auto-reply failed for ${phone} — handed to a human (${err.message})`, { level: 'warn' });
  }
}

async function ingestPool(accountId, { messages, type }) {
  if (type !== 'notify') return;
  for (const msg of messages) {
    try {
      if (!msg.message) continue;
      const raw = msg.key.remoteJid || '';
      if (raw.endsWith('@g.us') || raw.endsWith('@newsletter') || raw === 'status@broadcast') continue; // 1:1 only
      const phone = jidToPhone(pnOf(msg));
      if (!phone || ourPhones().has(phone)) continue; // skip warm-up traffic between our own numbers
      const body = textOf(msg).trim();
      const id = msg.key.id;
      if (!id) continue;

      let contact = await db.contacts().findOne({ phone });
      if (!contact) {
        if (!body) continue;
        const doc = {
          name: msg.pushName || '',
          phone,
          tags: 'inbound',
          status: 'active',
          synced: 0,
          handoff: 0,
          handoff_reason: '',
          last_inbound_at: null,
          last_outbound_at: null,
          created_at: nowIso(),
        };
        const r = await db.contacts().insertOne(doc).catch(() => null);
        contact = r ? { _id: r.insertedId, ...doc } : await db.contacts().findOne({ phone });
      }
      if (!contact || contact.warmup === 1) continue;

      if (msg.key.fromMe) {
        if (!body) continue;
        const r = await db.messages().updateOne(
          { wa_message_id: id },
          { $setOnInsert: { contact_id: String(contact._id), campaign_id: null, account_id: accountId, direction: 'out', body, status: 'sent', wa_message_id: id, created_at: nowIso(), day_key: dayKey() } },
          { upsert: true }
        );
        if (r.upsertedCount) {
          await db.contacts().updateOne({ _id: contact._id }, { $set: { last_outbound_at: nowIso() } });
          emit('message:out', { contactId: String(contact._id) });
        }
        continue;
      }

      if (!body) continue;
      const r = await db.messages().updateOne(
        { wa_message_id: id },
        { $setOnInsert: { contact_id: String(contact._id), campaign_id: null, account_id: accountId, direction: 'in', body, status: 'read', wa_message_id: id, created_at: nowIso(), day_key: dayKey() } },
        { upsert: true }
      );
      if (!r.upsertedCount) continue; // already stored
      await db.contacts().updateOne({ _id: contact._id }, { $set: { last_inbound_at: nowIso() }, $inc: { unread: 1 } });

      const stop = getSetting('stopKeywords', []);
      const lc = body.toLowerCase();
      const acctAutoReply = !!accounts.get(accountId)?.autoReply; // this number's own AI toggle
      if (stop.some((w) => lc === w || lc.startsWith(w))) {
        await db.contacts().updateOne({ _id: contact._id }, { $set: { status: 'opted_out', handoff: 0 } });
        audit('reply', `${phone} opted out ("${body}")`, { level: 'warn', meta: { contactId: String(contact._id) } });
      } else if (acctAutoReply && aiAvailable()) {
        await db.targets().updateMany({ contact_id: String(contact._id), status: 'queued' }, { $set: { status: 'replied' } });
        await poolAutoReply(accountId, contact, phone);
      } else if (getSetting('handoffOnReply', true)) {
        await db.contacts().updateOne({ _id: contact._id }, { $set: { handoff: 1, handoff_reason: 'reply' } });
        await db.targets().updateMany({ contact_id: String(contact._id), status: 'queued' }, { $set: { status: 'replied' } });
        audit('handoff', `${msg.pushName || phone} replied — handed to a human`, { level: 'info', meta: { contactId: String(contact._id) } });
      }
      emit('message:in', { contactId: String(contact._id) });
      emit('stats:dirty', {});
    } catch (err) {
      audit('system', `Pool inbound error: ${err.message}`, { level: 'error' });
    }
  }
}

// Import a conversation number's existing chat history (1:1 only, excluding our own numbers).
async function ingestPoolHistory(accountId, { messages, contacts: waContacts }) {
  if (!messages?.length) return;
  const nameByJid = new Map();
  for (const c of waContacts || []) if (c?.id) nameByJid.set(c.id, c.name || c.notify || c.verifiedName || '');
  const mine = ourPhones();

  const byPhone = new Map();
  for (const msg of messages) {
    const raw = msg.key?.remoteJid || '';
    if (!raw || raw.endsWith('@g.us') || raw.endsWith('@newsletter') || raw === 'status@broadcast') continue;
    const phone = jidToPhone(pnOf(msg));
    if (!phone || mine.has(phone)) continue;
    if (!byPhone.has(phone)) byPhone.set(phone, []);
    byPhone.get(phone).push(msg);
  }

  let imported = 0;
  for (const [phone, msgs] of byPhone) {
    let contact = await db.contacts().findOne({ phone });
    if (!contact) {
      const nm = nameByJid.get(`${phone}@s.whatsapp.net`) || '';
      const doc = { name: nm, phone, tags: 'whatsapp', status: 'active', synced: 1, handoff: 0, handoff_reason: '', last_inbound_at: null, last_outbound_at: null, created_at: nowIso() };
      const r = await db.contacts().insertOne(doc).catch(() => null);
      contact = r ? { _id: r.insertedId, ...doc } : await db.contacts().findOne({ phone });
    }
    if (!contact || contact.warmup === 1) continue;

    const ops = [];
    for (const msg of msgs) {
      const id = msg.key?.id;
      if (!id) continue;
      const body = textOf(msg).trim();
      if (!body) continue;
      const tsNum = Number(msg.messageTimestamp) || 0;
      const ts = tsNum ? new Date(tsNum * 1000).toISOString() : nowIso();
      const dir = msg.key.fromMe ? 'out' : 'in';
      ops.push({
        updateOne: {
          filter: { wa_message_id: id },
          update: { $setOnInsert: { contact_id: String(contact._id), campaign_id: null, account_id: accountId, direction: dir, body, status: dir === 'out' ? 'sent' : 'read', wa_message_id: id, synced: 1, created_at: ts, day_key: ts.slice(0, 10) } },
          upsert: true,
        },
      });
    }
    if (ops.length) {
      const r = await db.messages().bulkWrite(ops, { ordered: false }).catch(() => null);
      if (r) imported += r.upsertedCount || 0;
    }
  }
  if (imported) {
    audit('connection', `Synced ${imported} messages for a conversation number`, { level: 'success' });
    emit('message:in', {});
    emit('stats:dirty', {});
  }
}

// Reconnect every saved account on boot (after Mongo is up).
export async function reconnectPoolAccounts() {
  try {
    const docs = await db.warmupAccounts().find().toArray();
    for (const d of docs) startPoolAccount(String(d._id), d.label || '', d.role || 'warmup', !!d.auto_reply);
  } catch {
    /* mongo not ready yet; caller retries */
  }
}
