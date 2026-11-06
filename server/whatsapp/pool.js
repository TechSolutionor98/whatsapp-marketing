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
import { db, audit, oid } from '../db/mongo.js';
import { emit } from '../events.js';
import { attachReceipts } from '../receipts.js';
import { jidToPhone, normalizePhone } from '../utils.js';

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
    status: a.status,
    qr: a.qr || null,
    me: a.me || null,
    lastError: a.lastError || null,
  }));
}

export function connectedAccounts() {
  return [...accounts.values()].filter((a) => a.status === 'connected' && a.sock && a.me?.phone);
}

function emitPool() {
  emit('pool:update', poolState());
}

export async function startPoolAccount(id, label = '') {
  let a = accounts.get(id);
  if (a?.sock) return; // already live
  if (!a) {
    a = { id, label, status: 'connecting', qr: null, me: null };
    accounts.set(id, a);
  }
  if (label) a.label = label;
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
    const sock = makeWASocket({
      version,
      auth: state,
      logger,
      browser: Browsers.appropriate('Desktop'),
      printQRInTerminal: false,
      markOnlineOnConnect: false,
      syncFullHistory: false,
    });
    a.sock = sock;
    sock.ev.on('creds.update', saveCreds);
    attachReceipts(sock); // delivery/read receipts for campaigns sent from this number

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

// Reconnect every saved account on boot (after Mongo is up).
export async function reconnectPoolAccounts() {
  try {
    const docs = await db.warmupAccounts().find().toArray();
    for (const d of docs) startPoolAccount(String(d._id), d.label || '');
  } catch {
    /* mongo not ready yet; caller retries */
  }
}
