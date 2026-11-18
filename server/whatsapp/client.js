import fs from 'node:fs';
import QRCode from 'qrcode';
import pino from 'pino';
import makeWASocket, {
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
  DisconnectReason,
  Browsers,
} from 'baileys';
import { getWaVersion } from './version.js';
import { registerMainNumber, attachConversationHandlers, onConversationOpen, historyHook, ingestMain } from './pool.js';

import { WA_AUTH_DIR } from '../config.js';
import { db, audit, getSetting, setSetting } from '../db/mongo.js';
import { emit } from '../events.js';
import { attachReceipts } from '../receipts.js';
import { jidToPhone, normalizePhone } from '../utils.js';

const logger = pino({ level: 'silent' });

const state = {
  status: 'disconnected', // disconnected | connecting | qr | connected
  qr: null, // data URL
  me: null, // { phone, name }
  lastError: null,
  syncing: false, // pulling chat history after linking
};

let sock = null;
let starting = false;
let manualLogout = false;
let reconnectTimer = null;
let historySyncTimer = null;

export function getWaState() {
  return { ...state };
}

function setStatus(status, extra = {}) {
  state.status = status;
  Object.assign(state, extra);
  emit('wa:status', getWaState());
}

// The main number's entry in the shared conversation pipeline (pool.js). Live getters, so
// the pipeline always sees the current socket / number; it keeps its own per-session caches
// (history batches, learned numbers, group names) on this object.
const mainCtx = {
  id: 'main',
  role: 'conversation',
  get sock() {
    return sock;
  },
  get status() {
    return state.status;
  },
  get me() {
    return state.me;
  },
  get autoReply() {
    return !!getSetting('autoReplyEnabled', false); // the main number's AI toggle
  },
  setSyncing(on) {
    if (state.syncing !== on) setStatus(state.status, { syncing: on });
  },
};

export async function connectWhatsApp() {
  if (starting || sock) return;
  starting = true;
  manualLogout = false;
  clearTimeout(reconnectTimer);
  setStatus('connecting', { qr: null, lastError: null });

  try {
    fs.mkdirSync(WA_AUTH_DIR, { recursive: true });
    const { state: authState, saveCreds } = await useMultiFileAuthState(WA_AUTH_DIR);
    const version = await getWaVersion(); // cached — no HTTP fetch before every QR

    sock = makeWASocket({
      version,
      auth: authState,
      logger,
      // Same settings as linked conversation numbers (pool.js): pinned 'Ubuntu' identity —
      // with history sync on, WhatsApp closes Mac OS/Windows-named clients with 428 before the QR.
      browser: Browsers.ubuntu('Desktop'),
      printQRInTerminal: false,
      markOnlineOnConnect: false, // do not force "online" — looks more natural
      // Full history like linked numbers (false delivered nothing for linked numbers), and
      // read WhatsApp's number table + inline recent-chats batch from each notification.
      syncFullHistory: true,
      shouldSyncHistoryMessage: historyHook('main'),
      // Answer recipients' retry requests so our messages decrypt (avoids "Waiting for this message").
      getMessage: async (key) => {
        try {
          const m = await db.messages().findOne({ wa_message_id: key?.id });
          if (m?.body) return { conversation: m.body };
        } catch {}
        return undefined;
      },
    });

    sock.ev.on('creds.update', saveCreds);
    // Run the main number through the same pipeline as linked numbers (history import,
    // real numbers/names for @lid chats, group names + permissions, media, reactions).
    registerMainNumber(mainCtx);
    attachConversationHandlers('main', sock);

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
        setSetting('mainPhone', state.me.phone); // remember which number the Main tab belongs to
        onConversationOpen('main');
      }

      if (connection === 'close') {
        const code =
          lastDisconnect?.error?.output?.statusCode ||
          lastDisconnect?.error?.output?.payload?.statusCode;
        const loggedOut = code === DisconnectReason.loggedOut || manualLogout;
        sock = null;
        starting = false;
        clearTimeout(historySyncTimer);
        state.syncing = false;

        if (loggedOut) {
          // Session is dead — wipe credentials so the next connect shows a fresh QR.
          try {
            fs.rmSync(WA_AUTH_DIR, { recursive: true, force: true });
          } catch {
            /* ignore */
          }
          state.me = null;
          setSetting('mainPhone', null);
          setStatus('disconnected', { qr: null, lastError: 'Logged out' });
          audit('connection', 'WhatsApp session logged out', { level: 'warn' });
        } else {
          setStatus('connecting', { lastError: `Disconnected (code ${code ?? '?'})` });
          audit('connection', `Connection dropped (code ${code ?? '?'}) — reconnecting`, {
            level: 'warn',
          });
          // 515 = restart required right after a QR scan → reconnect immediately.
          reconnectTimer = setTimeout(() => connectWhatsApp(), code === DisconnectReason.restartRequired ? 250 : 3000);
        }
      }
    });

    sock.ev.on('messages.upsert', (ev) => ingestMain(ev)); // same live pipeline as linked numbers
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
  setSetting('mainPhone', null); // the Main tab no longer belongs to any number
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

