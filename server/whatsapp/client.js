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
    // WhatsApp history sync: recent chats from the phone, delivered after linking.
    sock.ev.on('messaging-history.set', async ({ messages, contacts }) => {
      try {
        await importHistory(messages || [], contacts || []);
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

// Find or create a contact by phone. Contacts created from WhatsApp history or
// outgoing echoes are flagged `synced: 1` so they appear in Conversations but are
// kept out of the Contacts/Leads list and never swept into a campaign audience.
async function upsertContactByPhone(phone, { name = '', synced = false } = {}) {
  const existing = await db.contacts().findOne({ phone });
  if (existing) {
    if (!existing.name && name) {
      await db.contacts().updateOne({ _id: existing._id }, { $set: { name } });
      existing.name = name;
    }
    return existing;
  }
  const doc = {
    name: name || '',
    phone,
    tags: synced ? 'whatsapp' : 'inbound',
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
    return await db.contacts().findOne({ phone }); // race: created elsewhere
  }
}

// Record a message the user sent from their phone (not via this app) so the
// conversation thread stays complete. Deduped by WhatsApp message id.
async function storeOutgoingEcho(phone, msg) {
  const id = msg.key?.id;
  const body = extractText(msg).trim();
  if (!id || !body) return;
  const contact = await upsertContactByPhone(phone, { synced: true });
  if (!contact) return;
  const r = await db.messages().updateOne(
    { wa_message_id: id },
    {
      $setOnInsert: {
        contact_id: String(contact._id),
        campaign_id: null,
        direction: 'out',
        body,
        status: 'sent',
        wa_message_id: id,
        created_at: nowIso(),
        day_key: dayKey(),
      },
    },
    { upsert: true }
  );
  if (r.upsertedCount) {
    await db.contacts().updateOne({ _id: contact._id }, { $set: { last_outbound_at: nowIso() } });
    emit('message:out', { contactId: String(contact._id) });
  }
}

// Import a batch of WhatsApp history messages (from messaging-history.set).
async function importHistory(messages, waContacts) {
  if (!isMongoUp() || !messages?.length) return;
  const nameByJid = new Map();
  for (const c of waContacts || []) {
    if (c?.id) nameByJid.set(c.id, c.name || c.notify || c.verifiedName || '');
  }

  const byPhone = new Map();
  for (const msg of messages) {
    const jid = msg.key?.remoteJid || '';
    if (!jid || jid.endsWith('@g.us') || jid.endsWith('@newsletter') || jid === 'status@broadcast') continue;
    const phone = jidToPhone(jid);
    if (!phone) continue;
    if (!byPhone.has(phone)) byPhone.set(phone, []);
    byPhone.get(phone).push(msg);
  }

  let imported = 0;
  for (const [phone, msgs] of byPhone) {
    const name = nameByJid.get(`${phone}@s.whatsapp.net`) || '';
    const contact = await upsertContactByPhone(phone, { name, synced: true });
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
    audit('connection', `Synced ${imported} messages from WhatsApp history`, { level: 'info' });
    emit('message:in', {});
    emit('stats:dirty', {});
  }
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
      if (jid.endsWith('@g.us') || jid.endsWith('@newsletter') || jid === 'status@broadcast') continue; // skip groups/channels/status

      const phone = jidToPhone(jid);
      if (!phone) continue;

      // Sent from the phone itself (not via this app) — record it and move on.
      if (msg.key.fromMe) {
        await storeOutgoingEcho(phone, msg);
        continue;
      }

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
      await db.contacts().updateOne({ _id: contact._id }, { $set: { last_inbound_at: nowIso() } });

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
