import fs from 'node:fs';
import QRCode from 'qrcode';
import pino from 'pino';
import makeWASocket, {
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
  DisconnectReason,
  Browsers,
} from 'baileys';

import { WA_AUTH_DIR } from '../config.js';
import { db, audit, getSetting, isMongoUp, nowIso, dayKey } from '../db/mongo.js';
import { emit } from '../events.js';
import { aiAvailable, conversationReply } from '../ai.js';
import { attachReceipts } from '../receipts.js';
import { jidToPhone, normalizePhone, randInt } from '../utils.js';

const logger = pino({ level: 'silent' });

const state = {
  status: 'disconnected', // disconnected | connecting | qr | connected
  qr: null, // data URL
  me: null, // { phone, name }
  lastError: null,
};

let sock = null;
let starting = false;
let manualLogout = false;
let reconnectTimer = null;

export function getWaState() {
  return { ...state };
}

function setStatus(status, extra = {}) {
  state.status = status;
  Object.assign(state, extra);
  emit('wa:status', getWaState());
}

export async function connectWhatsApp() {
  if (starting || sock) return;
  starting = true;
  manualLogout = false;
  clearTimeout(reconnectTimer);
  setStatus('connecting', { qr: null, lastError: null });

  try {
    fs.mkdirSync(WA_AUTH_DIR, { recursive: true });
    const { state: authState, saveCreds } = await useMultiFileAuthState(WA_AUTH_DIR);
    const { version } = await fetchLatestBaileysVersion();

    sock = makeWASocket({
      version,
      auth: authState,
      logger,
      browser: Browsers.appropriate('Desktop'),
      printQRInTerminal: false,
      markOnlineOnConnect: false, // do not force "online" — looks more natural
      syncFullHistory: true, // pull the phone's chat history on (re)link so recent chats show
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', async (update) => {
      const { connection, lastDisconnect, qr } = update;

      if (qr) {
        state.qr = await QRCode.toDataURL(qr, { margin: 1, width: 300 });
        setStatus('qr');
        audit('connection', 'QR code generated — scan with WhatsApp to link', {
          level: 'info',
        });
      }

      if (connection === 'open') {
        state.me = {
          phone: jidToPhone(sock.user?.id),
          name: sock.user?.name || sock.user?.verifiedName || '',
        };
        setStatus('connected', { qr: null, lastError: null });
        audit('connection', `WhatsApp linked: ${state.me.name || state.me.phone}`, {
          level: 'success',
          meta: state.me,
        });
      }

      if (connection === 'close') {
        const code =
          lastDisconnect?.error?.output?.statusCode ||
          lastDisconnect?.error?.output?.payload?.statusCode;
        const loggedOut = code === DisconnectReason.loggedOut || manualLogout;
        sock = null;
        starting = false;

        if (loggedOut) {
          // Session is dead — wipe credentials so the next connect shows a fresh QR.
          try {
            fs.rmSync(WA_AUTH_DIR, { recursive: true, force: true });
          } catch {
            /* ignore */
          }
          state.me = null;
          setStatus('disconnected', { qr: null, lastError: 'Logged out' });
          audit('connection', 'WhatsApp session logged out', { level: 'warn' });
        } else {
          setStatus('connecting', { lastError: `Disconnected (code ${code ?? '?'})` });
          audit('connection', `Connection dropped (code ${code ?? '?'}) — reconnecting`, {
            level: 'warn',
          });
          reconnectTimer = setTimeout(() => connectWhatsApp(), 3000);
        }
      }
    });

    sock.ev.on('messages.upsert', handleIncoming);
    // WhatsApp history sync: recent chats (incl. groups) from the phone, after linking.
    sock.ev.on('messaging-history.set', async ({ messages, contacts, chats }) => {
      try {
        audit('connection', `History sync received: ${messages?.length || 0} messages, ${chats?.length || 0} chats`, { level: 'info' });
        await importHistory(messages || [], contacts || [], chats || []);
      } catch (err) {
        audit('system', `History sync error: ${err.message}`, { level: 'error' });
      }
    });
    attachReceipts(sock);
  } catch (err) {
    starting = false;
    sock = null;
    state.lastError = err.message;
    setStatus('disconnected', { lastError: err.message });
    audit('connection', `Connection failed: ${err.message}`, { level: 'error' });
    reconnectTimer = setTimeout(() => connectWhatsApp(), 5000);
  } finally {
    starting = false;
  }
}

export async function logoutWhatsApp() {
  manualLogout = true;
  clearTimeout(reconnectTimer);
  try {
    if (sock) await sock.logout();
  } catch {
    /* ignore */
  }
  try {
    fs.rmSync(WA_AUTH_DIR, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
  sock = null;
  state.me = null;
  setStatus('disconnected', { qr: null });
  audit('connection', 'WhatsApp unlinked by user', { level: 'info' });
}

export function isConnected() {
  return state.status === 'connected' && !!sock;
}

// Confirm a number is actually on WhatsApp before we spend a send on it.
export async function checkOnWhatsApp(phone) {
  if (!isConnected()) return { exists: false, reason: 'not_connected' };
  try {
    const res = await sock.onWhatsApp(`${normalizePhone(phone)}@s.whatsapp.net`);
    const hit = Array.isArray(res) && res[0]?.exists;
    return { exists: !!hit, jid: hit ? res[0].jid : null };
  } catch (err) {
    return { exists: false, reason: err.message };
  }
}

export async function sendTyping(phone, ms = 1200) {
  if (!isConnected()) return;
  const jid = `${normalizePhone(phone)}@s.whatsapp.net`;
  try {
    await sock.presenceSubscribe(jid);
    await sock.sendPresenceUpdate('composing', jid);
    await new Promise((r) => setTimeout(r, ms));
    await sock.sendPresenceUpdate('paused', jid);
  } catch {
    /* non-fatal */
  }
}

export async function sendText(phone, text) {
  if (!isConnected()) throw new Error('WhatsApp is not connected');
  const jid = `${normalizePhone(phone)}@s.whatsapp.net`;
  const sent = await sock.sendMessage(jid, { text });
  return sent?.key?.id || null;
}

// Send to a full jid (used for group chats, which aren't addressable by phone).
export async function sendToJid(jid, text) {
  if (!isConnected()) throw new Error('WhatsApp is not connected');
  const sent = await sock.sendMessage(jid, { text });
  return sent?.key?.id || null;
}

export async function sendImage(phone, buffer, caption) {
  if (!isConnected()) throw new Error('WhatsApp is not connected');
  const jid = `${normalizePhone(phone)}@s.whatsapp.net`;
  const sent = await sock.sendMessage(jid, { image: buffer, caption: caption || undefined });
  return sent?.key?.id || null;
}

// Generate and send an AI reply to a lead's incoming message.
async function autoReply(contact, phone, pushName) {
  try {
    const history = await db
      .messages()
      .find({ contact_id: String(contact._id) })
      .sort({ _id: 1 })
      .limit(14)
      .toArray();
    const reply = (await conversationReply(history.map((m) => ({ direction: m.direction, body: m.body })))).trim();
    if (!reply) throw new Error('empty reply');

    // Wait a human-like amount of time before answering (configurable).
    const minS = getSetting('autoReplyMinSec', 5);
    const maxS = getSetting('autoReplyMaxSec', 30);
    const waitMs = randInt(Math.max(0, minS), Math.max(minS, maxS)) * 1000;
    if (waitMs > 0) await new Promise((r) => setTimeout(r, waitMs));

    await sendTyping(phone, randInt(1200, 2600));
    const waId = await sendText(phone, reply);
    await db.messages().insertOne({
      contact_id: String(contact._id),
      campaign_id: null,
      direction: 'out',
      body: reply,
      status: 'sent',
      wa_message_id: waId,
      ai_auto: true,
      created_at: nowIso(),
      day_key: dayKey(),
    });
    await db.contacts().updateOne({ _id: contact._id }, { $set: { last_outbound_at: nowIso() } });
    audit('reply', `AI auto-replied to ${contact.name || phone}`, {
      meta: { contactId: String(contact._id) },
    });
    emit('message:out', { contactId: String(contact._id) });
  } catch (err) {
    // If AI fails, fall back to flagging a human so the lead isn't ignored.
    await db.contacts().updateOne(
      { _id: contact._id },
      { $set: { handoff: 1, handoff_reason: 'reply' } }
    );
    audit('handoff', `AI auto-reply failed for ${phone} — handed to a human (${err.message})`, {
      level: 'warn',
      meta: { contactId: String(contact._id) },
    });
  }
}

// Find or create a conversation. 1:1 chats are keyed by phone; group chats by their
// jid. Synced chats appear in Conversations but are kept out of Contacts/Leads and
// never swept into a campaign audience.
async function upsertChat({ jid, name = '', isGroup = false, synced = true }) {
  const key = isGroup ? { jid } : { phone: jidToPhone(jid) };
  const existing = await db.contacts().findOne(key);
  if (existing) {
    const set = {};
    if (!existing.name && name) set.name = name;
    if (!existing.jid) set.jid = jid;
    if (Object.keys(set).length) {
      await db.contacts().updateOne({ _id: existing._id }, { $set: set });
      Object.assign(existing, set);
    }
    return existing;
  }
  const doc = {
    name: name || '',
    phone: isGroup ? jid.split('@')[0] : jidToPhone(jid), // group id keeps the unique phone index happy
    jid,
    is_group: isGroup ? 1 : 0,
    tags: isGroup ? 'group' : synced ? 'whatsapp' : 'inbound',
    status: 'active',
    synced: synced ? 1 : 0,
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
    return await db.contacts().findOne(key); // race: created elsewhere
  }
}

// Insert one synced message (dedup by WhatsApp id). Returns true if newly inserted.
async function storeSyncedMessage(contact, msg, direction) {
  const id = msg.key?.id;
  const body = extractText(msg).trim();
  if (!id || !body) return false;
  const r = await db.messages().updateOne(
    { wa_message_id: id },
    {
      $setOnInsert: {
        contact_id: String(contact._id),
        campaign_id: null,
        direction,
        body,
        sender: contact.is_group && direction === 'in' ? msg.pushName || '' : '',
        status: direction === 'out' ? 'sent' : 'read',
        wa_message_id: id,
        synced: 1,
        created_at: nowIso(),
        day_key: dayKey(),
      },
    },
    { upsert: true }
  );
  return !!r.upsertedCount;
}

// Record a message the user sent from their phone (1:1 or group), deduped.
async function storeOutgoingEcho(jid, msg) {
  const isGroup = jid.endsWith('@g.us');
  const contact = await upsertChat({ jid, isGroup });
  if (!contact) return;
  if (await storeSyncedMessage(contact, msg, 'out')) {
    await db.contacts().updateOne({ _id: contact._id }, { $set: { last_outbound_at: nowIso() } });
    emit('message:out', { contactId: String(contact._id) });
  }
}

// Record an incoming group message (no lead automation — groups aren't leads).
async function storeGroupIncoming(jid, msg) {
  const contact = await upsertChat({ jid, isGroup: true });
  if (!contact) return;
  if (await storeSyncedMessage(contact, msg, 'in')) {
    await db.contacts().updateOne({ _id: contact._id }, { $set: { last_inbound_at: nowIso() }, $inc: { unread: 1 } });
    emit('message:in', { contactId: String(contact._id) });
    emit('stats:dirty', {});
  }
}

// Import a batch of WhatsApp history (from messaging-history.set) — 1:1 chats AND groups.
async function importHistory(messages, waContacts, waChats) {
  if (!isMongoUp() || !messages?.length) return;
  const nameByJid = new Map();
  for (const c of waContacts || []) {
    if (c?.id) nameByJid.set(c.id, c.name || c.notify || c.verifiedName || '');
  }
  for (const ch of waChats || []) {
    const nm = ch?.name || ch?.subject || '';
    if (ch?.id && nm) nameByJid.set(ch.id, nm);
  }

  const byJid = new Map();
  for (const msg of messages) {
    const rawJid = msg.key?.remoteJid || '';
    if (!rawJid || rawJid.endsWith('@newsletter') || rawJid === 'status@broadcast') continue; // keep groups; skip channels/status
    const jid = rawJid.endsWith('@g.us') ? rawJid : pnJid(msg); // resolve @lid → phone jid
    if (!byJid.has(jid)) byJid.set(jid, []);
    byJid.get(jid).push(msg);
  }

  let imported = 0;
  for (const [jid, msgs] of byJid) {
    const isGroup = jid.endsWith('@g.us');
    if (!isGroup && !jidToPhone(jid)) continue;
    const contact = await upsertChat({ jid, name: nameByJid.get(jid) || '', isGroup });
    if (!contact) continue;

    const ops = [];
    let lastIn = null;
    let lastOut = null;
    for (const msg of msgs) {
      const id = msg.key?.id;
      if (!id) continue;
      const body = extractText(msg).trim();
      if (!body) continue; // skip media-only / system entries
      const tsNum = Number(msg.messageTimestamp) || 0;
      const ts = tsNum ? new Date(tsNum * 1000).toISOString() : nowIso();
      const dir = msg.key.fromMe ? 'out' : 'in';
      const sender = isGroup && !msg.key.fromMe ? msg.pushName || '' : '';
      if (dir === 'in') lastIn = !lastIn || ts > lastIn ? ts : lastIn;
      else lastOut = !lastOut || ts > lastOut ? ts : lastOut;
      ops.push({
        updateOne: {
          filter: { wa_message_id: id },
          update: {
            $setOnInsert: {
              contact_id: String(contact._id),
              campaign_id: null,
              direction: dir,
              body,
              sender,
              status: dir === 'out' ? 'sent' : 'read',
              wa_message_id: id,
              synced: 1,
              created_at: ts,
              day_key: ts.slice(0, 10),
            },
          },
          upsert: true,
        },
      });
    }
    if (ops.length) {
      const r = await db.messages().bulkWrite(ops, { ordered: false }).catch(() => null);
      if (r) imported += r.upsertedCount || 0;
    }
    const set = {};
    if (lastIn && (!contact.last_inbound_at || lastIn > contact.last_inbound_at)) set.last_inbound_at = lastIn;
    if (lastOut && (!contact.last_outbound_at || lastOut > contact.last_outbound_at)) set.last_outbound_at = lastOut;
    if (Object.keys(set).length) await db.contacts().updateOne({ _id: contact._id }, { $set: set });
  }

  if (imported) {
    audit('connection', `Synced ${imported} messages from WhatsApp history`, { level: 'success' });
    emit('message:in', {});
    emit('stats:dirty', {});
  }
}

// WhatsApp now addresses some chats by an opaque @lid id instead of the phone number.
// Prefer the real phone-number jid when the message provides it as an alternative, so a
// reply links to the same contact we messaged (instead of creating a duplicate thread).
function pnJid(msg) {
  const k = msg.key || {};
  for (const j of [k.remoteJid, k.remoteJidAlt, k.senderPn, k.participantAlt]) {
    if (typeof j === 'string' && j.endsWith('@s.whatsapp.net')) return j;
  }
  return k.remoteJid || '';
}

// ---- Inbound handling: store, flag for human handoff, honour opt-outs ----
function extractText(msg) {
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

async function handleIncoming({ messages, type }) {
  if (type !== 'notify' || !isMongoUp()) return;
  for (const msg of messages) {
    try {
      if (!msg.message) continue;
      const jid = msg.key.remoteJid || '';
      if (jid.endsWith('@newsletter') || jid === 'status@broadcast') continue; // skip channels/status

      const isGroup = jid.endsWith('@g.us');

      // Sent from the phone itself (not via this app) — record it and move on.
      if (msg.key.fromMe) {
        await storeOutgoingEcho(isGroup ? jid : pnJid(msg), msg);
        continue;
      }

      // Group messages: store them for the thread, but no lead automation.
      if (isGroup) {
        await storeGroupIncoming(jid, msg);
        continue;
      }

      const phone = jidToPhone(pnJid(msg)); // resolve @lid → real phone when possible
      if (!phone) continue;
      const body = extractText(msg).trim();
      const pushName = msg.pushName || '';

      // Upsert the contact.
      let contact = await db.contacts().findOne({ phone });
      if (!contact) {
        const doc = {
          name: pushName,
          phone,
          tags: 'inbound',
          status: 'active',
          handoff: 0,
          handoff_reason: '',
          last_inbound_at: null,
          last_outbound_at: null,
          created_at: nowIso(),
        };
        const r = await db.contacts().insertOne(doc);
        contact = { _id: r.insertedId, ...doc };
      } else if (!contact.name && pushName) {
        await db.contacts().updateOne({ _id: contact._id }, { $set: { name: pushName } });
      }

      await db.messages().insertOne({
        contact_id: String(contact._id),
        campaign_id: null,
        direction: 'in',
        body,
        status: 'read',
        wa_message_id: msg.key.id,
        created_at: nowIso(),
        day_key: dayKey(),
      });
      await db.contacts().updateOne({ _id: contact._id }, { $set: { last_inbound_at: nowIso() }, $inc: { unread: 1 } });

      // Opt-out detection.
      const stopWords = getSetting('stopKeywords', []);
      const lc = body.toLowerCase();
      const isOptOut = stopWords.some((w) => lc === w || lc.startsWith(w));
      if (isOptOut) {
        await db.contacts().updateOne(
          { _id: contact._id },
          { $set: { status: 'opted_out', handoff: 0 } }
        );
        audit('reply', `${phone} opted out ("${body}")`, {
          level: 'warn',
          meta: { contactId: String(contact._id) },
        });
      } else if (getSetting('autoReplyEnabled', false) && aiAvailable() && contact.warmup !== 1) {
        // Pause campaign automation for this lead, then let AI answer the reply.
        await db.targets().updateMany(
          { contact_id: String(contact._id), status: 'queued' },
          { $set: { status: 'replied' } }
        );
        await autoReply(contact, phone, pushName);
      } else if (getSetting('handoffOnReply', true) && contact.warmup !== 1) {
        // Instant human handoff: stop automation for this lead (warm-up replies are fine).
        await db.contacts().updateOne(
          { _id: contact._id },
          { $set: { handoff: 1, handoff_reason: 'reply' } }
        );
        await db.targets().updateMany(
          { contact_id: String(contact._id), status: 'queued' },
          { $set: { status: 'replied' } }
        );
        audit('handoff', `${pushName || phone} replied — handed to a human`, {
          level: 'info',
          meta: { contactId: String(contact._id), preview: body.slice(0, 80) },
        });
      }

      emit('message:in', { contactId: String(contact._id), phone, body });
      emit('stats:dirty', {});
    } catch (err) {
      audit('system', `Inbound handling error: ${err.message}`, { level: 'error' });
    }
  }
}
