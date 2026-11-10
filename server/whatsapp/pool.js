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

// DIAGNOSTIC (build: diag-2): surface Baileys' internal history-sync / error logs into
// our audit log (the logger was 'silent', so a failing history-blob download was invisible).
// We forward history/sync/decrypt chatter and warnings+errors, capped to limit noise.
import { Writable } from 'node:stream';
let _dbgCount = 0;
const baileysLogSink = new Writable({
  write(chunk, _enc, cb) {
    try {
      const line = JSON.parse(String(chunk));
      const lvl = Number(line.level) || 0; // 30 info, 40 warn, 50 error
      const msg = String(line.msg || '');
      // History sync works now; keep only warnings/errors so audit stays readable.
      if (lvl >= 40 && _dbgCount < 500) {
        _dbgCount++;
        const err = line.err?.message || line.error?.message || line.err || '';
        audit('debug', `WA[${lvl}] ${msg}${err ? ' — ' + err : ''}`.slice(0, 350), {
          level: lvl >= 50 ? 'error' : lvl >= 40 ? 'warn' : 'info',
        });
      }
    } catch {}
    cb();
  },
});
const logger = pino({ level: 'debug' }, baileysLogSink);

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
    syncing: !!a.syncing,
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

export async function startPoolAccount(id, label = '', role, autoReply) {
  let a = accounts.get(id);
  if (a?.sock) return; // already live
  if (!a) {
    a = { id, label, role: role || 'warmup', autoReply: !!autoReply, status: 'connecting', qr: null, me: null };
    accounts.set(id, a);
  }
  if (label) a.label = label;
  if (role) a.role = role; // only override when a role is explicitly passed
  if (autoReply !== undefined) a.autoReply = !!autoReply;
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
      // Conversation numbers need their real chat history (WhatsApp only pushes it on a
      // FRESH link/scan). `false` delivered nothing, so request the full sync for those;
      // warm-up numbers don't need history, so keep them light.
      syncFullHistory: isConv,
      shouldSyncHistoryMessage: () => true,
      // Answer recipients' retry requests so our messages decrypt (avoids "Waiting for this message").
      getMessage: async (key) => {
        try {
          const m = await db.messages().findOne({ wa_message_id: key?.id });
          if (m?.body) return { conversation: m.body };
        } catch {}
        return undefined;
      },
    });
    a.sock = sock;
    sock.ev.on('creds.update', saveCreds);
    attachReceipts(sock); // delivery/read receipts for campaigns sent from this number
    sock.ev.on('messages.upsert', (ev) => ingestPool(id, ev)); // capture this number's own chats
    if (isConv) {
      sock.ev.on('messaging-history.set', (ev) => {
        const acc = accounts.get(id);
        if (acc) {
          // Still syncing until WhatsApp marks this the last batch.
          acc.syncing = !(ev.isLatest || (ev.progress != null && ev.progress >= 100));
          clearTimeout(acc.syncTimer);
          // Fallback: if the final batch never arrives, stop the loader after a quiet gap.
          acc.syncTimer = setTimeout(() => { const a2 = accounts.get(id); if (a2) { a2.syncing = false; emitPool(); } }, 10000);
          emitPool();
        }
        audit('connection', `History received (type=${ev.syncType ?? '?'}, latest=${ev.isLatest}, progress=${ev.progress ?? '?'}): ${ev.messages?.length || 0} messages, ${ev.chats?.length || 0} chats, ${ev.contacts?.length || 0} contacts`, { level: 'info' });
        ingestPoolHistory(id, ev);
      });
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
        if ((a.role || 'warmup') === 'conversation') {
          a.syncing = true; // expect history to start arriving
          // Fallback: don't show the loader forever if WhatsApp sends no history.
          clearTimeout(a.syncTimer);
          a.syncTimer = setTimeout(() => { const x = accounts.get(id); if (x) { x.syncing = false; emitPool(); } }, 12000);
          audit('connection', `Conversation number linked: ${a.me.name || a.me.phone} — syncing history… [diag-2 build, syncFullHistory=${isConv}]`, { level: 'success' });
        } else {
          audit('warmup', `Warm-up number linked: ${a.me.name || a.me.phone}`, { level: 'success' });
        }
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
          // Preserve role + auto-reply on reconnect (otherwise a conversation number
          // silently reverts to a warm-up number and vanishes from Conversations).
          a.reconnectTimer = setTimeout(() => startPoolAccount(id, a.label, a.role, a.autoReply), 3000);
        }
      }
    });
  } catch (e) {
    a.starting = false;
    a.sock = null;
    a.status = 'disconnected';
    a.lastError = e.message;
    emitPool();
    a.reconnectTimer = setTimeout(() => startPoolAccount(id, a.label, a.role, a.autoReply), 5000);
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

// The role of a pool account ('warmup' | 'conversation'), or null if unknown.
export function accountRole(id) {
  return accounts.get(id)?.role || null;
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

// Find/create a contact for a pool chat (1:1 by phone, group by jid).
async function upsertPoolChat({ phone, jid, isGroup = false, name = '' }) {
  const key = isGroup ? { jid } : { phone };
  const existing = await db.contacts().findOne(key);
  if (existing) {
    const set = {};
    if (!existing.name && name) set.name = name;
    if (isGroup && !existing.jid) set.jid = jid;
    if (Object.keys(set).length) {
      await db.contacts().updateOne({ _id: existing._id }, { $set: set });
      Object.assign(existing, set);
    }
    return existing;
  }
  const doc = {
    name: name || '',
    phone: isGroup ? jid.split('@')[0] : phone,
    jid: jid || null,
    is_group: isGroup ? 1 : 0,
    tags: isGroup ? 'group' : 'whatsapp',
    status: 'active',
    synced: isGroup ? 1 : 0,
    handoff: 0,
    handoff_reason: '',
    last_inbound_at: null,
    last_outbound_at: null,
    created_at: nowIso(),
  };
  try {
    const r = await db.contacts().insertOne(doc);
    return { _id: r.insertedId, ...doc };
  } catch {
    return await db.contacts().findOne(key);
  }
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
  // Warm-up numbers are isolated — they only message each other and never show in Conversations.
  if ((accounts.get(accountId)?.role || 'warmup') !== 'conversation') return;
  for (const msg of messages) {
    try {
      if (!msg.message) continue;
      const raw = msg.key.remoteJid || '';
      if (raw.endsWith('@newsletter') || raw === 'status@broadcast') continue;
      const isGroup = raw.endsWith('@g.us');
      const id = msg.key.id;
      if (!id) continue;
      const body = textOf(msg).trim();

      // Group message: store for the thread (conversation numbers only), no lead automation.
      if (isGroup) {
        if ((accounts.get(accountId)?.role || 'warmup') !== 'conversation') continue;
        if (!body && !msg.key.fromMe) continue;
        const gc = await upsertPoolChat({ jid: raw, isGroup: true });
        if (!gc || !body) continue;
        const r = await db.messages().updateOne(
          { wa_message_id: id },
          { $setOnInsert: { contact_id: String(gc._id), campaign_id: null, account_id: accountId, direction: msg.key.fromMe ? 'out' : 'in', body, sender: msg.key.fromMe ? '' : msg.pushName || '', status: msg.key.fromMe ? 'sent' : 'read', wa_message_id: id, synced: 1, created_at: nowIso(), day_key: dayKey() } },
          { upsert: true }
        );
        if (r.upsertedCount) {
          await db.contacts().updateOne({ _id: gc._id }, { $set: msg.key.fromMe ? { last_outbound_at: nowIso() } : { last_inbound_at: nowIso() }, ...(msg.key.fromMe ? {} : { $inc: { unread: 1 } }) });
          emit(msg.key.fromMe ? 'message:out' : 'message:in', { contactId: String(gc._id) });
        }
        continue;
      }

      const phone = jidToPhone(pnOf(msg));
      if (!phone) continue;
      // Warm-up numbers: skip chatter between our own numbers. Conversation numbers: keep everything.
      const isConvAcct = (accounts.get(accountId)?.role || 'warmup') === 'conversation';
      if (!isConvAcct && ourPhones().has(phone)) continue;

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

// Import a conversation number's existing chat history (1:1 + groups, excluding our own numbers).
async function ingestPoolHistory(accountId, { messages, contacts: waContacts, chats }) {
  if (!messages?.length) return;

  // Build a name map and a lid→phone map keyed by EVERY jid form we can see, so a chat
  // that arrives @lid-addressed still resolves to a real name/number. (WhatsApp often
  // delivers history 1:1 chats by @lid instead of the real @s.whatsapp.net number.)
  const nameByJid = new Map();
  const lidToPn = new Map(); // '<lid>@lid' -> '<phone>@s.whatsapp.net'
  const addPair = (...jids) => {
    const list = jids.filter((x) => typeof x === 'string');
    const lid = list.find((x) => x.endsWith('@lid'));
    const pn = list.find((x) => x.endsWith('@s.whatsapp.net'));
    if (lid && pn) lidToPn.set(lid, pn);
  };
  for (const c of waContacts || []) {
    if (!c) continue;
    const nm = c.name || c.notify || c.verifiedName || '';
    for (const j of [c.id, c.lid, c.jid, c.pnJid]) if (j && nm) nameByJid.set(j, nm);
    addPair(c.id, c.lid, c.jid, c.pnJid);
  }
  for (const ch of chats || []) {
    const nm = ch?.name || ch?.subject || ch?.displayName || '';
    for (const j of [ch?.id, ch?.lidJid, ch?.pnJid]) if (j && nm) nameByJid.set(j, nm);
    addPair(ch?.id, ch?.lidJid, ch?.pnJid);
  }

  // Resolve a 1:1 chat's real phone jid: explicit pn on the key → lid map → raw.
  const resolvePnJid = (raw, msg) => {
    const keyed = pnOf(msg);
    if (keyed && keyed.endsWith('@s.whatsapp.net')) return keyed;
    if (raw.endsWith('@lid') && lidToPn.has(raw)) return lidToPn.get(raw);
    return raw;
  };

  // Group messages by their chat jid (1:1 jid or group jid). Conversation numbers keep
  // every chat, including ones with your own other numbers.
  const byChat = new Map(); // chatJid -> { msgs, origJid }
  for (const msg of messages) {
    const raw = msg.key?.remoteJid || '';
    if (!raw || raw.endsWith('@newsletter') || raw === 'status@broadcast') continue;
    const isGroup = raw.endsWith('@g.us');
    let chatJid = raw;
    if (!isGroup) {
      const phone = jidToPhone(resolvePnJid(raw, msg));
      if (!phone) continue;
      chatJid = `${phone}@s.whatsapp.net`;
    }
    if (!byChat.has(chatJid)) byChat.set(chatJid, { msgs: [], origJid: raw });
    byChat.get(chatJid).msgs.push(msg);
    // Use the sender's push name as a fallback display name when we have nothing better.
    if (!isGroup && !nameByJid.get(chatJid) && !nameByJid.get(raw) && msg.pushName && !msg.key?.fromMe) {
      nameByJid.set(chatJid, msg.pushName);
    }
  }

  let imported = 0;
  for (const [chatJid, { msgs, origJid }] of byChat) {
    const isGroup = chatJid.endsWith('@g.us');
    const phone = isGroup ? null : jidToPhone(chatJid);
    const name = nameByJid.get(chatJid) || nameByJid.get(origJid) || '';
    // Keep the original jid (may be @lid) on 1:1 contacts so replies can target it later.
    const contact = await upsertPoolChat({ phone, jid: isGroup ? chatJid : origJid, isGroup, name });
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
      const sender = isGroup && !msg.key.fromMe ? msg.pushName || '' : '';
      ops.push({
        updateOne: {
          filter: { wa_message_id: id },
          update: { $setOnInsert: { contact_id: String(contact._id), campaign_id: null, account_id: accountId, direction: dir, body, sender, status: dir === 'out' ? 'sent' : 'read', wa_message_id: id, synced: 1, created_at: ts, day_key: ts.slice(0, 10) } },
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
