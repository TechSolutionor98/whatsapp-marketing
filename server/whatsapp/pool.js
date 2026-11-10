import fs from 'node:fs';
import path from 'node:path';
import QRCode from 'qrcode';
import pino from 'pino';
import makeWASocket, {
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
  DisconnectReason,
  Browsers,
  downloadHistory,
  processHistoryMessage,
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
      // Only real errors, so the Audit Logs page stays readable.
      if (lvl >= 50 && _dbgCount < 200) {
        _dbgCount++;
        // Baileys logs errors under both `err` and `error` (e.g. 'error in handling message').
        const err = line.err?.message || line.error?.message || '';
        audit('debug', `WA[${lvl}] ${msg}${err ? ' — ' + err : ''}`.slice(0, 350), {
          level: lvl >= 50 ? 'error' : lvl >= 40 ? 'warn' : 'info',
        });
      }
    } catch {}
    cb();
  },
});
// pino only serializes Error objects under `err` by default — anything under `error` was
// written as {} and its message lost. Serialize both.
const logger = pino(
  { level: 'debug', serializers: { err: pino.stdSerializers.err, error: pino.stdSerializers.err } },
  baileysLogSink
);

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
      // Called with each history notification (Baileys chats.js). Baileys' own history
      // processing drops WhatsApp's @lid -> phone-number table, so read it ourselves.
      shouldSyncHistoryMessage: (notif) => {
        if (isConv) onHistoryNotification(id, notif);
        return true;
      },
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
          // Stay "syncing" until WhatsApp marks the FINAL batch (isLatest). progress hits
          // 100 on every batch, so it can't tell us the sync is actually finished.
          acc.syncing = !ev.isLatest;
          clearTimeout(acc.syncTimer);
          // Fallback: if the final batch never arrives, stop the loader after a quiet gap.
          acc.syncTimer = setTimeout(() => { const a2 = accounts.get(id); if (a2) { a2.syncing = false; emitPool(); } }, 20000);
          emitPool();
        }
        audit('connection', `History received (type=${ev.syncType ?? '?'}, latest=${ev.isLatest}, progress=${ev.progress ?? '?'}): ${ev.messages?.length || 0} messages, ${ev.chats?.length || 0} chats, ${ev.contacts?.length || 0} contacts`, { level: 'info' });
        // Names/lid pairs in this batch first (PUSH_NAME batches have contacts but no
        // messages), then the messages — serialized with the other identity work.
        queueIdentity(async () => {
          await applyContactBatch(ev.contacts);
          await ingestPoolHistory(id, ev);
        });
        // Baileys finished a batch — now (not in parallel with it) read that batch's number table.
        markBaileysBatchDone(id);
      });
      // Saved names from the phone's address book + their @lid <-> number pairs arrive via
      // the app-state contact sync (Baileys chat-utils contactAction → contacts.upsert).
      sock.ev.on('contacts.upsert', (list) => {
        queueIdentity(async () => {
          const n = await applyContactBatch(list);
          if (n) audit('connection', `Updated ${n} chat name${n === 1 ? '' : 's'} from your WhatsApp contacts`, { level: 'info' });
        });
      });
      // Push names from incoming messages (Baileys chats.js → contacts.update).
      sock.ev.on('contacts.update', (list) => queueIdentity(() => applyContactBatch(list)));
      // Group names (subjects) when they're created/changed.
      sock.ev.on('groups.upsert', (list) => applyGroupSubjects(id, list));
      sock.ev.on('groups.update', (list) => applyGroupSubjects(id, list));
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
          audit('connection', `Conversation number linked: ${a.me.name || a.me.phone} — syncing history…`, { level: 'success' });
          // Group names: fetch once the initial sync settles, then again after history has
          // created the group chats (queries during the very first seconds can time out).
          clearTimeout(a.groupTimer1);
          clearTimeout(a.groupTimer2);
          a.groupTimer1 = setTimeout(() => syncGroupNames(id), 6000);
          a.groupTimer2 = setTimeout(() => syncGroupNames(id), 45000);
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

// Send to an exact jid (a group, an @lid contact, or a number jid) from one pool account.
export async function sendJidFrom(fromId, jid, text) {
  const a = accounts.get(fromId);
  if (!a?.sock || a.status !== 'connected') throw new Error('Source number not connected');
  await a.sock.sendPresenceUpdate('composing', jid).catch(() => {});
  const sent = await a.sock.sendMessage(jid, { text });
  return sent?.key?.id || null;
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
const isLid = (j) => typeof j === 'string' && j.endsWith('@lid');
const isPn = (j) => typeof j === 'string' && j.endsWith('@s.whatsapp.net');

// The real-number jid of a 1:1 chat, if the message carries one. Baileys puts it in
// key.senderPn / participantPn (decode-wa-message.js) — but those describe the SENDER,
// so on our own (fromMe) messages they're OUR number and must not identify the chat.
function pnOf(msg) {
  const k = msg.key || {};
  const cands = k.fromMe ? [k.remoteJid, k.remoteJidAlt] : [k.remoteJid, k.remoteJidAlt, k.senderPn, k.participantPn, k.participantAlt];
  for (const j of cands) if (isPn(j)) return j;
  return k.remoteJid || '';
}

// Where to send for a stored contact: group jid, the @lid when WhatsApp never told us the
// real number, otherwise the number.
export function chatJidOf(contact) {
  if (contact?.is_group) return contact.jid || `${contact.phone}@g.us`;
  if (contact?.lid_only && isLid(contact.jid)) return contact.jid;
  return `${normalizePhone(contact?.phone)}@s.whatsapp.net`;
}

// lid -> { pn, name, notify } from the persistent map.
async function lidLookup(lids) {
  const out = new Map();
  const list = [...new Set((lids || []).filter(isLid))];
  if (!list.length) return out;
  try {
    for (const d of await db.lidMap().find({ _id: { $in: list } }).toArray()) out.set(d._id, d);
  } catch {}
  return out;
}

// Serialize identity work (contact batches + history ingest) so a lid mapping that arrives
// mid-sync is never raced by the chat it resolves.
let identityChain = Promise.resolve();
function queueIdentity(fn) {
  identityChain = identityChain.then(fn).catch((e) => audit('system', `Contact sync error: ${e.message}`, { level: 'error' }));
  return identityChain;
}

// Reconcile WhatsApp contact info into lid_map + our contacts. Real sources (Baileys 6.7):
//  - contacts.upsert from app-state contactAction → { id, name: fullName, lid, jid }  (saved names)
//  - contacts.update from incoming messages       → { id, notify, verifiedName }   (push names)
//  - messaging-history.set contacts (PUSH_NAME)   → { id, notify }
//  - live message keys                             → senderLid + senderPn pairs
async function applyContactBatch(list) {
  const entries = [];
  for (const c of list || []) {
    if (!c?.id || typeof c.id !== 'string') continue;
    if (c.id.endsWith('@g.us') || c.id.endsWith('@newsletter') || c.id.endsWith('@broadcast')) continue;
    const jids = [c.id, c.lid, c.jid, c.phoneNumber].filter((x) => typeof x === 'string');
    const lid = jids.find(isLid) || null;
    const pn = jids.find(isPn) || null;
    const saved = String(c.name || '').trim();
    const push = String(c.notify || c.verifiedName || '').trim();
    if (!(lid && pn) && !saved && !push) continue; // nothing useful (e.g. a picture change)
    entries.push({ lid, pn, saved, push });
  }
  if (!entries.length) return 0;

  // 1) Remember lid -> number/name so later history + live messages resolve straight away.
  const mapOps = [];
  for (const e of entries) {
    if (!e.lid) continue;
    const set = { updated_at: nowIso() };
    if (e.pn) set.pn = e.pn;
    if (e.saved) set.name = e.saved;
    if (e.push) set.notify = e.push;
    mapOps.push({ updateOne: { filter: { _id: e.lid }, update: { $set: set }, upsert: true } });
  }
  if (mapOps.length) {
    // 60 learned pairs once came back as only 3 saved — the error was swallowed. Retry, and
    // report what actually failed (duplicate-key races on upsert are harmless).
    let lastErr = null;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        await db.lidMap().bulkWrite(mapOps, { ordered: false });
        lastErr = null;
        break;
      } catch (e) {
        const real = (e?.writeErrors || []).filter((w) => w.code !== 11000);
        lastErr = e?.writeErrors && !real.length ? null : e;
        if (!lastErr) break;
        await new Promise((r) => setTimeout(r, 1500));
      }
    }
    if (lastErr) audit('connection', `Couldn't save ${mapOps.length} phone-number mappings: ${lastErr.message}`, { level: 'warn' });
  }

  // 2) Fix the contacts we already store (one lookup query, then only the matches).
  const lids = entries.filter((e) => e.lid).map((e) => e.lid);
  const nums = [...lids.map(jidToPhone), ...entries.filter((e) => e.pn).map((e) => jidToPhone(e.pn))];
  let existing = [];
  try {
    existing = await db.contacts().find({ is_group: { $ne: 1 }, $or: [{ phone: { $in: nums } }, { lid: { $in: lids } }] }).toArray();
  } catch {}
  if (!existing.length) return 0;
  const byPhone = new Map(existing.map((x) => [x.phone, x]));
  const byLid = new Map(existing.filter((x) => x.lid).map((x) => [x.lid, x]));
  let fixed = 0;
  for (const e of entries) {
    try {
      if (await reconcileContact(e, byPhone, byLid)) fixed++;
    } catch {}
  }
  if (fixed) emit('message:in', {});
  return fixed;
}

async function reconcileContact(e, byPhone, byLid) {
  const lidNum = e.lid ? jidToPhone(e.lid) : null;
  const pnNum = e.pn ? jidToPhone(e.pn) : null;
  let lidC = e.lid ? byLid.get(e.lid) || byPhone.get(lidNum) || null : null;
  const pnC = pnNum ? byPhone.get(pnNum) || null : null;
  if (lidC && pnC && String(lidC._id) === String(pnC._id)) lidC = null;

  // Same person stored twice (once by @lid, once by real number) → merge into the number.
  if (lidC && pnC) {
    await db.messages().updateMany({ contact_id: String(lidC._id) }, { $set: { contact_id: String(pnC._id) } });
    const set = { lid: e.lid };
    const nm = e.saved || pnC.name || lidC.name || e.push;
    if (nm && nm !== pnC.name) set.name = nm;
    if (lidC.pinned) set.pinned = 1;
    const upd = { $set: set, $unset: { lid_only: '' } };
    if (lidC.unread) upd.$inc = { unread: lidC.unread };
    await db.contacts().updateOne({ _id: pnC._id }, upd);
    await db.contacts().deleteOne({ _id: lidC._id });
    Object.assign(pnC, set);
    byPhone.delete(lidC.phone);
    byLid.set(e.lid, pnC);
    return true;
  }

  const target = lidC || pnC;
  if (!target) return false;
  const set = {};
  let resolved = false;
  if (lidC && pnNum) {
    set.phone = pnNum; // we finally know the real number
    set.jid = e.pn;
    set.lid = e.lid;
    resolved = true;
  } else if (lidC && !lidC.lid_only) {
    set.lid = e.lid; // older rows stored the lid as if it were a phone number
    set.jid = e.lid;
    set.lid_only = 1;
  } else if (pnC && e.lid && !pnC.lid) {
    set.lid = e.lid;
  }
  if (e.saved && target.name !== e.saved) set.name = e.saved; // address-book name wins
  else if (!e.saved && e.push && !target.name) set.name = e.push;
  if (!Object.keys(set).length) return false;
  const upd = { $set: set };
  if (resolved) upd.$unset = { lid_only: '' };
  await db.contacts().updateOne({ _id: target._id }, upd);
  if (resolved) {
    byPhone.delete(lidC.phone);
    byPhone.set(pnNum, target);
  }
  Object.assign(target, set);
  return true;
}

// WhatsApp's own @lid -> number table from a raw HistorySync (WAProto: HistorySync field 15
// `phoneNumberToLidMappings` {pnJid, lidJid}, plus each Conversation's `pnJid`/`lidJid`).
// This is how WhatsApp Web shows a number for a lid chat; Baileys' processHistoryMessage
// never reads these fields, so its messaging-history.set event doesn't include them.
function mappingsFromHistory(data) {
  const pairs = new Map(); // lid -> pn
  for (const m of data?.phoneNumberToLidMappings || []) {
    if (isLid(m?.lidJid) && isPn(m?.pnJid)) pairs.set(m.lidJid, m.pnJid);
  }
  for (const c of data?.conversations || []) {
    const lid = [c?.id, c?.lidJid].find(isLid);
    const pn = [c?.id, c?.pnJid].find(isPn);
    if (lid && pn) pairs.set(lid, pn);
  }
  return [...pairs].map(([lid, pn]) => ({ id: lid, jid: pn }));
}

// History batches: Baileys downloads each blob and emits messaging-history.set. We read the
// same blob for its number table only AFTER Baileys is done with it, one at a time — a parallel
// download raced Baileys' own (Baileys then errored and never delivered that history). If
// Baileys hasn't delivered a batch after a while (its download failed, or the initial-sync
// buffer is waiting on the phone), we import that batch ourselves from the raw blob.
const HIST_FALLBACK_MS = 60000;
function onHistoryNotification(id, notif) {
  if (!notif?.directPath || !notif?.mediaKey) return; // Baileys' "will we sync?" probe has no media
  const a = accounts.get(id);
  if (!a) return;
  a.histSeen ||= new Set();
  if (a.histSeen.has(notif.directPath)) return;
  a.histSeen.add(notif.directPath);
  const job = { notif, retries: 0 };
  (a.histJobs ||= []).push(job);
  const arm = () => {
    job.timer = setTimeout(() => {
      const acc = accounts.get(id);
      // Baileys still delivering batches recently → it's progressing; give it more time.
      if (acc?.lastHistAt && Date.now() - acc.lastHistAt < 20000 && job.retries++ < 3) return arm();
      runHistJob(id, job, true);
    }, HIST_FALLBACK_MS);
  };
  arm();
}

function markBaileysBatchDone(id) {
  const a = accounts.get(id);
  if (!a) return;
  a.lastHistAt = Date.now();
  // Strict arrival order (a batch our fallback already imported still counts as this one).
  const job = a.histJobs?.find((j) => !j.baileysDone);
  if (!job) return;
  job.baileysDone = true;
  if (!job.started) runHistJob(id, job, false);
}

let histChain = Promise.resolve();
function runHistJob(id, job, fullImport) {
  if (job.started) return;
  job.started = true;
  clearTimeout(job.timer);
  histChain = histChain.then(async () => {
    if (!accounts.get(id)) return; // number was removed meanwhile
    const t0 = Date.now();
    let raw;
    try {
      raw = await downloadHistory(job.notif, {});
    } catch (e) {
      audit('connection', `Couldn't download a history batch${fullImport ? ' (WhatsApp never delivered it)' : ''}: ${e.message}`, { level: 'warn' });
      return;
    }
    const pairs = mappingsFromHistory(raw);
    const a = accounts.get(id);
    if (a && pairs.length) {
      a.learnedPairs ||= new Map(); // in-memory backup in case the lid_map write fails
      for (const p of pairs) a.learnedPairs.set(p.id, p.jid);
    }
    const secs = Math.round((Date.now() - t0) / 1000);
    await queueIdentity(async () => {
      const fixed = pairs.length ? await applyContactBatch(pairs) : 0;
      if (pairs.length) {
        audit('connection', `Learned ${pairs.length} phone number${pairs.length === 1 ? '' : 's'} from WhatsApp history (type=${raw.syncType}, ${fixed} chat${fixed === 1 ? '' : 's'} updated, ${secs}s)`, { level: 'info' });
      }
      if (fullImport) {
        const data = processHistoryMessage(raw); // Baileys' own parser → same shape as the event
        audit('connection', `Imported a history batch directly (type=${raw.syncType}): ${data.messages.length} messages, ${data.chats.length} chats — WhatsApp hadn't delivered it`, { level: 'info' });
        await applyContactBatch(data.contacts);
        await ingestPoolHistory(id, data); // idempotent: messages dedupe by WhatsApp id
        const acc = accounts.get(id);
        if (acc?.syncing) {
          acc.syncing = false;
          emitPool();
        }
      }
    });
  });
}

// Group subjects (names) — history sync carries none, so fetch them like WhatsApp Web does.
async function syncGroupNames(id) {
  const a = accounts.get(id);
  if (!a?.sock || a.status !== 'connected') return;
  let groups;
  try {
    groups = await a.sock.groupFetchAllParticipating();
  } catch {
    return;
  }
  const subjects = new Map();
  for (const [jid, g] of Object.entries(groups || {})) if (g?.subject) subjects.set(jid, g.subject);
  a.groupSubjects = subjects;
  if (!subjects.size) return;
  const ops = [...subjects].map(([jid, subject]) => ({
    updateMany: { filter: { jid, is_group: 1, name: { $ne: subject } }, update: { $set: { name: subject } } },
  }));
  try {
    const r = await db.contacts().bulkWrite(ops, { ordered: false });
    if (r.modifiedCount) emit('message:in', {});
  } catch {}
}

function applyGroupSubjects(id, list) {
  const a = accounts.get(id);
  for (const g of list || []) {
    if (!g?.id || !g.subject) continue;
    if (a) (a.groupSubjects ||= new Map()).set(g.id, g.subject);
    db.contacts().updateMany({ jid: g.id, is_group: 1 }, { $set: { name: g.subject } }).then((r) => r.modifiedCount && emit('message:in', {})).catch(() => {});
  }
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

// Find/create a contact for a pool chat. Groups by jid. 1:1 by real number — or, when
// WhatsApp only gave us an @lid, by that lid (flagged lid_only so the UI never shows the
// lid as if it were a phone number).
async function upsertPoolChat({ phone, jid, isGroup = false, name = '', lid = null }) {
  const base = {
    tags: isGroup ? 'group' : 'whatsapp',
    status: 'active',
    synced: isGroup ? 1 : 0,
    handoff: 0,
    handoff_reason: '',
    last_inbound_at: null,
    last_outbound_at: null,
    created_at: nowIso(),
  };

  if (isGroup) {
    const existing = await db.contacts().findOne({ jid });
    if (existing) {
      if (name && existing.name !== name) {
        await db.contacts().updateOne({ _id: existing._id }, { $set: { name } });
        existing.name = name;
      }
      return existing;
    }
    const doc = { ...base, name: name || '', phone: jid.split('@')[0], jid, is_group: 1 };
    try {
      const r = await db.contacts().insertOne(doc);
      return { _id: r.insertedId, ...doc };
    } catch {
      return await db.contacts().findOne({ jid });
    }
  }

  const lidNum = lid ? jidToPhone(lid) : null;
  const resolved = !!phone && phone !== lidNum; // we know the real number
  let existing = null;
  if (resolved) existing = await db.contacts().findOne({ phone });
  if (!existing && lid) existing = await db.contacts().findOne({ lid });
  if (!existing && lidNum) existing = await db.contacts().findOne({ phone: lidNum }); // older rows

  if (existing) {
    const set = {};
    const upd = {};
    if (name && !existing.name) set.name = name;
    if (lid && !existing.lid) set.lid = lid;
    if (resolved && existing.phone !== phone) {
      set.phone = phone;
      set.jid = `${phone}@s.whatsapp.net`;
      upd.$unset = { lid_only: '' };
    } else if (!resolved && lid && !existing.lid_only && existing.phone === lidNum) {
      set.lid_only = 1;
      set.jid = lid;
    }
    if (Object.keys(set).length) {
      upd.$set = set;
      try {
        await db.contacts().updateOne({ _id: existing._id }, upd);
        Object.assign(existing, set);
      } catch {}
    }
    return existing;
  }

  const doc = resolved
    ? { ...base, name: name || '', phone, jid: `${phone}@s.whatsapp.net`, is_group: 0, ...(lid ? { lid } : {}) }
    : { ...base, name: name || '', phone: lidNum, jid: lid, lid, lid_only: 1, is_group: 0 };
  if (!doc.phone) return null;
  try {
    const r = await db.contacts().insertOne(doc);
    return { _id: r.insertedId, ...doc };
  } catch {
    return await db.contacts().findOne({ phone: doc.phone });
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
    const waId = await sendJidFrom(accountId, chatJidOf(contact), reply);
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
  const myPhone = accounts.get(accountId)?.me?.phone || null; // tag chats by the linked number
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
        const gc = await upsertPoolChat({ jid: raw, isGroup: true, name: accounts.get(accountId)?.groupSubjects?.get(raw) || '' });
        if (!gc || !body) continue;
        const r = await db.messages().updateOne(
          { wa_message_id: id },
          { $set: { account_phone: myPhone }, $setOnInsert: { contact_id: String(gc._id), campaign_id: null, account_id: accountId, direction: msg.key.fromMe ? 'out' : 'in', body, sender: msg.key.fromMe ? '' : msg.pushName || '', status: msg.key.fromMe ? 'sent' : 'read', wa_message_id: id, synced: 1, created_at: nowIso(), day_key: dayKey() } },
          { upsert: true }
        );
        if (r.upsertedCount) {
          await db.contacts().updateOne({ _id: gc._id }, { $set: msg.key.fromMe ? { last_outbound_at: nowIso() } : { last_inbound_at: nowIso() }, ...(msg.key.fromMe ? {} : { $inc: { unread: 1 } }) });
          emit(msg.key.fromMe ? 'message:out' : 'message:in', { contactId: String(gc._id) });
        }
        continue;
      }

      if (!body) continue; // nothing to show (every path below needs text)

      // Who is this chat with? Live stanzas carry the @lid AND the real number
      // (senderLid/senderPn); learn the pair so the chat shows the real contact.
      let pnJid = pnOf(msg);
      const lidJid = isLid(raw) ? raw : !msg.key.fromMe && isLid(msg.key.senderLid) ? msg.key.senderLid : null;
      if (!isPn(pnJid) && lidJid) {
        const info = (await lidLookup([lidJid])).get(lidJid);
        const learned = accounts.get(accountId)?.learnedPairs?.get(lidJid);
        if (isPn(info?.pn)) pnJid = info.pn;
        else if (isPn(learned)) pnJid = learned;
      }
      if (lidJid && isPn(pnJid) && !msg.key.fromMe) {
        // Remember the pair + merge any older @lid copy of this chat (don't block this message).
        queueIdentity(() => applyContactBatch([{ id: lidJid, jid: pnJid, notify: msg.pushName || '' }]));
      }
      const phone = isPn(pnJid) ? jidToPhone(pnJid) : null;
      if (!phone && !lidJid) continue;
      // Warm-up numbers: skip chatter between our own numbers. Conversation numbers: keep everything.
      const isConvAcct = (accounts.get(accountId)?.role || 'warmup') === 'conversation';
      if (!isConvAcct && phone && ourPhones().has(phone)) continue;

      const contact = await upsertPoolChat({ phone, lid: lidJid, name: msg.key.fromMe ? '' : msg.pushName || '' });
      if (!contact || contact.warmup === 1) continue;

      if (msg.key.fromMe) {
        if (!body) continue;
        const r = await db.messages().updateOne(
          { wa_message_id: id },
          { $set: { account_phone: myPhone }, $setOnInsert: { contact_id: String(contact._id), campaign_id: null, account_id: accountId, direction: 'out', body, status: 'sent', wa_message_id: id, created_at: nowIso(), day_key: dayKey() } },
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
        { $set: { account_phone: myPhone }, $setOnInsert: { contact_id: String(contact._id), campaign_id: null, account_id: accountId, direction: 'in', body, status: 'read', wa_message_id: id, created_at: nowIso(), day_key: dayKey() } },
        { upsert: true }
      );
      if (!r.upsertedCount) continue; // already stored
      await db.contacts().updateOne({ _id: contact._id }, { $set: { last_inbound_at: nowIso() }, $inc: { unread: 1 } });

      const stop = getSetting('stopKeywords', []);
      const lc = body.toLowerCase();
      const acctAutoReply = !!accounts.get(accountId)?.autoReply; // this number's own AI toggle
      if (stop.some((w) => lc === w || lc.startsWith(w))) {
        await db.contacts().updateOne({ _id: contact._id }, { $set: { status: 'opted_out', handoff: 0 } });
        audit('reply', `${contact.name || (phone ? '+' + phone : 'A contact')} opted out ("${body}")`, { level: 'warn', meta: { contactId: String(contact._id) } });
      } else if (acctAutoReply && aiAvailable()) {
        await db.targets().updateMany({ contact_id: String(contact._id), status: 'queued' }, { $set: { status: 'replied' } });
        await poolAutoReply(accountId, contact, phone);
      } else if (getSetting('handoffOnReply', true)) {
        await db.contacts().updateOne({ _id: contact._id }, { $set: { handoff: 1, handoff_reason: 'reply' } });
        await db.targets().updateMany({ contact_id: String(contact._id), status: 'queued' }, { $set: { status: 'replied' } });
        audit('handoff', `${contact.name || msg.pushName || (phone ? '+' + phone : 'A contact')} replied — handed to a human`, { level: 'info', meta: { contactId: String(contact._id) } });
      }
      emit('message:in', { contactId: String(contact._id) });
      emit('stats:dirty', {});
    } catch (err) {
      audit('system', `Pool inbound error: ${err.message}`, { level: 'error' });
    }
  }
}

// Import a conversation number's existing chat history (1:1 + groups, excluding our own numbers).
async function ingestPoolHistory(accountId, { messages, chats }) {
  if (!messages?.length) return;
  // Note: the batch's contacts were already applied (names + lid pairs) by the caller.

  // Real shape (diag-3): chats/contacts arrive as bare { id } — no names, and @lid chats
  // carry no phone number. So names/numbers come from lid_map (filled by the app-state
  // contact sync + live traffic) and group names from the group-metadata fetch.
  const lids = messages.map((m) => m.key?.remoteJid).filter(isLid);
  const lidInfo = await lidLookup(lids);
  // Pairs learned this session (backup in case the lid_map write didn't persist).
  const learned = accounts.get(accountId)?.learnedPairs;
  if (learned) for (const lid of lids) if (!isPn(lidInfo.get(lid)?.pn) && learned.has(lid)) lidInfo.set(lid, { ...(lidInfo.get(lid) || {}), pn: learned.get(lid) });
  const groupSubjects = accounts.get(accountId)?.groupSubjects || new Map();
  const chatName = new Map();
  for (const ch of chats || []) {
    const nm = ch?.name || ch?.subject || ch?.displayName || '';
    if (ch?.id && nm) chatName.set(ch.id, nm);
  }

  // Group messages by chat: groups by jid; 1:1 by real number when known, else by the @lid.
  const byChat = new Map(); // key -> { msgs, isGroup, phone, lid, name }
  for (const msg of messages) {
    const raw = msg.key?.remoteJid || '';
    if (!raw || raw.endsWith('@newsletter') || raw.endsWith('@broadcast')) continue;
    if (raw.endsWith('@g.us')) {
      if (!byChat.has(raw)) byChat.set(raw, { msgs: [], isGroup: true, name: groupSubjects.get(raw) || chatName.get(raw) || '' });
      byChat.get(raw).msgs.push(msg);
      continue;
    }
    const lid = isLid(raw) ? raw : null;
    let pnJid = pnOf(msg);
    if (!isPn(pnJid) && lid && isPn(lidInfo.get(lid)?.pn)) pnJid = lidInfo.get(lid).pn;
    const phone = isPn(pnJid) ? jidToPhone(pnJid) : null;
    if (!phone && !lid) continue;
    const key = phone ? `${phone}@s.whatsapp.net` : lid;
    if (!byChat.has(key)) {
      const info = lid ? lidInfo.get(lid) : null;
      byChat.set(key, { msgs: [], isGroup: false, phone, lid, name: info?.name || info?.notify || chatName.get(raw) || '' });
    }
    const e = byChat.get(key);
    e.msgs.push(msg);
    if (!e.lid && lid) e.lid = lid;
    if (!e.name && msg.pushName && !msg.key?.fromMe) e.name = msg.pushName;
  }

  // The linked number's own phone — tag every message with it so a chat stays attached
  // to its tab even if the number is removed and re-added later (which changes account_id).
  const myPhone = accounts.get(accountId)?.me?.phone || null;

  let imported = 0;
  for (const [chatJid, { msgs, isGroup, phone, lid, name }] of byChat) {
    const contact = isGroup
      ? await upsertPoolChat({ jid: chatJid, isGroup: true, name })
      : await upsertPoolChat({ phone, lid, name });
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
          update: {
            $set: { account_phone: myPhone },
            $setOnInsert: { contact_id: String(contact._id), campaign_id: null, account_id: accountId, direction: dir, body, sender, status: dir === 'out' ? 'sent' : 'read', wa_message_id: id, synced: 1, created_at: ts, day_key: ts.slice(0, 10) },
          },
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

// Internals exposed for the local test harness only (no runtime effect).
export const __test = { accounts, applyContactBatch, upsertPoolChat, ingestPoolHistory, ingestPool, applyGroupSubjects, mappingsFromHistory };
