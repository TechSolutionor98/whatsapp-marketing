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
  normalizeMessageContent,
  downloadMediaMessage,
  BufferJSON,
  jidNormalizedUser,
  isJidStatusBroadcast,
  proto,
} from 'baileys';
import { ObjectId } from 'mongodb';
import { inflate } from 'node:zlib';
import { promisify } from 'node:util';

const inflateAsync = promisify(inflate);

import { DATA_DIR } from '../config.js';
import { db, col, audit, oid, getSetting, setSetting, nowIso, dayKey, setHandoff, isWsSuspended } from '../db/mongo.js';
import { DEFAULT_WS, currentWs, runInWs, inWs } from '../tenant.js';
import { emit } from '../events.js';
import { attachReceipts, setRejectedHandler } from '../receipts.js';
import { aiAvailable, conversationReply } from '../ai.js';
import { productContext, catalogIdsForAccount } from '../catalog.js';
import { getWaState } from './client.js';
import { getWaVersion } from './version.js';
import { sendCloudText, sendCloudImage } from './cloud-api.js';
import { jidToPhone, normalizePhone, randInt } from '../utils.js';

const POOL_DIR = path.join(DATA_DIR, 'wa_pool');

// Baileys' errors → the Audit Logs page, tagged with the number and the chat they belong to
// ("WA[50] +971… failed to decrypt message — No matching sessions found (from 123@lid)").
// Rate-limited per hour: the old lifetime cap of 200 went silent for good after one bad
// burst (it filled up in 16 minutes and nothing after that was ever visible).
import { Writable } from 'node:stream';
const WA_LOG_PER_HOUR = 80;
let waLogWindow = 0;
let waLogCount = 0;
let waLogDropped = 0;
const baileysLogSink = new Writable({
  write(chunk, _enc, cb) {
    try {
      const line = JSON.parse(String(chunk));
      const lvl = Number(line.level) || 0; // 50 error, 60 fatal
      if (lvl >= 50) {
        const now = Date.now();
        if (now - waLogWindow > 3600e3) {
          if (waLogDropped) audit('debug', `WA: ${waLogDropped} more WhatsApp errors in the last hour weren't listed`, { level: 'warn' });
          waLogWindow = now;
          waLogCount = 0;
          waLogDropped = 0;
        }
        if (waLogCount < WA_LOG_PER_HOUR) {
          waLogCount++;
          // Baileys logs errors under both `err` and `error` (e.g. 'error in handling message').
          const err = line.err?.message || line.error?.message || '';
          const who = line.acct ? ` ${acctLabel(line.acct)}` : '';
          const chat = line.key?.remoteJid ? ` (${line.key.fromMe ? 'to' : 'from'} ${line.key.participant || line.key.remoteJid})` : '';
          audit('debug', `WA[${lvl}]${who} ${line.msg || ''}${err ? ' — ' + err : ''}${chat}`.slice(0, 350), { level: 'error' });
        } else waLogDropped++;
      }
    } catch {}
    cb();
  },
});
// pino only serializes Error objects under `err` by default — anything under `error` was
// written as {} and its message lost. Serialize both. Level 'error': only errors are listed,
// and Baileys' debug chatter (every frame) cost CPU to format and was thrown away here.
const logger = pino(
  { level: 'error', serializers: { err: pino.stdSerializers.err, error: pino.stdSerializers.err } },
  baileysLogSink
);
// A logger for one number's socket — its lines carry the account id (main uses this too),
// shown as the number it's linked to when the line is written.
export function waLogger(id) {
  return logger.child({ acct: id });
}
function acctLabel(id) {
  const a = id === 'main' ? mainCtx : accounts.get(id);
  return a?.me?.phone ? `+${a.me.phone}` : a?.label || (id === 'main' ? 'main number' : id);
}

// A phone that couldn't decrypt one of our messages asks the sender for it again (the
// recipient sees "Waiting for this message" until it arrives). Baileys 7 answers from its own
// cache of recent sends first; this is the fallback from the database — the whole stored
// media message for photos/documents (resending only its caption lost the file), else the text.
export async function storedMessageFor(key) {
  try {
    const m = await db.messages().findOne({ wa_message_id: key?.id }, { projection: { body: 1, media_raw: 1 } });
    if (m?.media_raw) {
      const w = JSON.parse(m.media_raw, BufferJSON.reviver);
      if (w?.message && Object.keys(w.message).length) return w.message;
    }
    if (m?.body) return { conversation: m.body };
  } catch {}
  return undefined;
}

// id -> runtime { id, ws, label, sock, status, qr, me, lastError, starting, manualLogout, reconnectTimer }
// Every number belongs to one workspace (ws) — its chats, contacts and AI replies stay there.
const accounts = new Map();

// The MAIN number runs through the same pipeline as linked conversation numbers (history,
// @lid numbers, names, groups, media, reactions, permissions) — client.js registers its
// connection here. Pipeline functions below take 'main' as an account id too. It belongs to
// the default workspace.
let mainCtx = null;
export function registerMainNumber(ctx) {
  mainCtx = ctx;
}
// A number by id — only if it belongs to the workspace this code runs in (a request in one
// workspace can never read, send from, rename or unlink another workspace's number).
function ctxOf(id) {
  const a = id === 'main' ? mainCtx : accounts.get(id);
  if (!a) return a;
  const ws = currentWs();
  if (ws && (a.ws || DEFAULT_WS) !== ws) return undefined;
  return a;
}
// Subscribe to a number's socket events inside its workspace.
function onWs(sock, ws, event, fn) {
  sock.ev.on(event, inWs(ws || DEFAULT_WS, fn));
}
// The linked phone of an account id ('main' or a pool id) — used to tag stored messages.
export function phoneOfAccount(id) {
  return ctxOf(id)?.me?.phone || null;
}
// "Syncing chats…" indicator for a number; auto-clears after a quiet gap.
function setSyncing(id, on, quietMs) {
  const a = ctxOf(id);
  if (!a) return;
  clearTimeout(a.syncTimer);
  if (id === 'main') a.setSyncing?.(on);
  else a.syncing = on;
  if (on && quietMs) a.syncTimer = setTimeout(() => setSyncing(id, false), quietMs);
  if (!on) resetSyncIfDone(a, false);
  if (id !== 'main') emitPool();
}

// History-sync progress per number — the loading line under each Conversations tab. Two
// phases: WhatsApp sending the history (its own progress, 0–100, on each batch), then this
// server saving the batches (one at a time, across all numbers — a big phone can take
// minutes after WhatsApp is done). Both used to be silent.
function syncInfo(a) {
  return (a.sync ||= { progress: null, pending: 0, saved: 0 });
}
function noteSyncProgress(id, progress) {
  const a = ctxOf(id);
  const p = Number(progress);
  if (!a || progress == null || !Number.isFinite(p)) return;
  syncInfo(a).progress = Math.max(0, Math.min(100, Math.round(p)));
  emitSyncSoon();
}
// A history batch entered (+1) / left (-1) the save queue; `saved` = messages it held.
function syncPending(id, delta, saved = 0) {
  const a = ctxOf(id);
  if (!a) return;
  const s = syncInfo(a);
  s.pending = Math.max(0, s.pending + delta);
  s.saved += saved;
  resetSyncIfDone(a, id === 'main' ? !!getWaState()?.syncing : !!a.syncing);
  emitSyncSoon();
}
function resetSyncIfDone(a, fetching) {
  if (a?.sync && !fetching && !a.sync.pending) a.sync = { progress: null, pending: 0, saved: 0 };
}
// What the tab shows: null when idle.
function syncView(a, fetching) {
  const s = a?.sync || {};
  const pending = s.pending || 0;
  if (!fetching && !pending) return null;
  return { fetching: !!fetching, progress: fetching ? s.progress ?? null : null, pending, saved: s.saved || 0 };
}
export function syncStateOf(id) {
  if (id === 'main') return mainCtx ? syncView(mainCtx, !!getWaState()?.syncing) : null;
  const a = accounts.get(id);
  return a ? syncView(a, !!a.syncing) : null;
}
// Progress changes often during a sync — tell open pages at most every 1.5 s per workspace.
const syncEmitTimers = new Map();
function emitSyncSoon() {
  const ws = currentWs() || DEFAULT_WS;
  if (syncEmitTimers.has(ws)) return;
  syncEmitTimers.set(ws, setTimeout(() => {
    syncEmitTimers.delete(ws);
    runInWs(ws, emitPool);
  }, 1500));
}

function authDir(id) {
  return path.join(POOL_DIR, id);
}

// The numbers of one workspace (default: the current one; platform level: all).
function wsAccounts(ws = currentWs()) {
  const all = [...accounts.values()];
  return ws ? all.filter((a) => (a.ws || DEFAULT_WS) === ws) : all;
}

export function poolState(ws = currentWs()) {
  return wsAccounts(ws).map((a) => ({
    id: a.id,
    kind: a.kind || 'qr', // 'qr' = linked by scanning; 'cloud' = official WhatsApp Cloud API
    label: a.label || '',
    role: a.role || 'warmup',
    auto_reply: !!a.autoReply,
    syncing: !!a.syncing,
    sync: syncView(a, !!a.syncing),
    status: a.status,
    qr: a.qr || null,
    me: a.me || null,
    lastError: a.lastError || null,
  }));
}

// Warm-up / campaign-sender numbers only (conversation-only numbers are excluded).
export function connectedAccounts(ws = currentWs()) {
  return wsAccounts(ws).filter(
    // not conversation numbers, and never the Developer page's API-only number
    (a) => a.status === 'connected' && a.sock && a.me?.phone && !['conversation', 'api'].includes(a.role || 'warmup')
  );
}

function emitPool() {
  emit('pool:update', poolState());
}

export function startPoolAccount(id, label = '', role, autoReply, ws) {
  const cur = accounts.get(id);
  if (cur?.kind === 'cloud') return; // official API numbers have no WhatsApp Web session
  const home = cur?.ws || ws || currentWs() || DEFAULT_WS;
  if (cur && ws && cur.ws !== ws) return; // never move a number into another workspace
  return runInWs(home, () => startPoolAccountIn(home, id, label, role, autoReply));
}

async function startPoolAccountIn(ws, id, label = '', role, autoReply) {
  let a = accounts.get(id);
  if (a?.sock) return; // already live
  if (!a) {
    a = { id, ws, label, role: role || 'warmup', autoReply: !!autoReply, status: 'connecting', qr: null, me: null };
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
    const version = await getWaVersion(); // cached — no HTTP fetch before every QR
    const isConv = (a.role || role) === 'conversation';
    const sock = makeWASocket({
      version,
      auth: state,
      logger: waLogger(id),
      // Pinned (not Browsers.appropriate, which names the host OS): with syncFullHistory on,
      // WhatsApp now closes the connection with 428 before sending a QR when the client says
      // 'Mac OS' or 'Windows' (measured); 'Ubuntu' — what the Linux VPS already sends — works.
      browser: Browsers.ubuntu('Desktop'),
      printQRInTerminal: false,
      markOnlineOnConnect: false,
      // Conversation numbers need their real chat history (WhatsApp only pushes it on a
      // FRESH link/scan). `false` delivered nothing, so request the full sync for those;
      // warm-up numbers don't need history, so keep them light.
      syncFullHistory: isConv,
      // Called with each history notification (Baileys chats.js). Baileys' own history
      // processing drops WhatsApp's @lid -> phone-number table, so read it ourselves.
      shouldSyncHistoryMessage: inWs(ws, (notif) => {
        if (isConv) onHistoryNotification(id, notif);
        return true;
      }),
      // Contacts' Status updates: the app never shows them, and decrypting them (WhatsApp
      // re-sends ones it can't) filled the error log. Baileys acknowledges and drops them.
      shouldIgnoreJid: (jid) => isJidStatusBroadcast(jid),
      // Answer recipients' retry requests so our messages decrypt (avoids "Waiting for this message").
      getMessage: inWs(ws, storedMessageFor),
    });
    a.sock = sock;
    sock.ev.on('creds.update', saveCreds);
    attachReceipts(sock, ws); // delivery/read receipts for campaigns sent from this number
    onWs(sock, ws, 'messages.upsert', (ev) => ingestPool(id, ev)); // capture this number's own chats
    if (isConv) attachConversationHandlers(id, sock);

    onWs(sock, ws, 'connection.update', async (u) => {
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
          audit('connection', `Conversation number linked: ${a.me.name || a.me.phone} — syncing history…`, { level: 'success' });
          onConversationOpen(id);
        } else if (a.role === 'api') {
          audit('connection', `API number connected: +${a.me.phone}${a.me.name ? ` (${a.me.name})` : ''} — sends the Developer API's messages`, { level: 'success' });
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
        // Why it dropped (real data: Suppo dropped at 07:02:38 and the reason was never logged).
        console.log(`  [linked ${a.me?.phone || id}] connection closed (code ${code ?? '?'})`);
        if (code !== DisconnectReason.restartRequired && !a.manualLogout && ['conversation', 'api'].includes(a.role || 'warmup')) {
          audit('connection', `Linked number ${a.me?.phone ? '+' + a.me.phone : ''} disconnected (code ${code ?? '?'})${loggedOut ? ' — logged out on the phone, scan again' : ' — reconnecting'}`, { level: 'warn' });
        }
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
          // 515 = WhatsApp's "restart required", sent right after a QR is scanned: reconnect
          // almost immediately instead of making every new link wait 3 s (250 ms lets the
          // just-saved login finish writing to disk first).
          const wait = code === DisconnectReason.restartRequired ? 250 : 3000;
          a.reconnectTimer = setTimeout(() => startPoolAccount(id, a.label, a.role, a.autoReply, a.ws), wait);
        }
      }
    });
  } catch (e) {
    a.starting = false;
    a.sock = null;
    a.status = 'disconnected';
    a.lastError = e.message;
    emitPool();
    a.reconnectTimer = setTimeout(() => startPoolAccount(id, a.label, a.role, a.autoReply, a.ws), 5000);
  } finally {
    a.starting = false;
  }
}

// Wire a conversation number's socket (linked numbers AND the main number) into the
// pipeline: history batches, saved/push names + @lid pairs, group names/permissions.
export function attachConversationHandlers(id, sock) {
  const ws = (id === 'main' ? mainCtx?.ws : accounts.get(id)?.ws) || DEFAULT_WS;
  const on = (event, fn) => onWs(sock, ws, event, fn);
  on('messaging-history.set', (ev) => {
    // Stay "syncing" until WhatsApp marks the FINAL batch (isLatest); progress hits 100 on
    // every batch, so it can't tell us the sync is finished. Quiet-gap fallback: 20 s.
    const onDemand = ev.syncType === proto.HistorySync.HistorySyncType.ON_DEMAND;
    if (!onDemand) {
      setSyncing(id, !ev.isLatest, 20000);
      noteSyncProgress(id, ev.progress);
    }
    audit('connection', `History received${id === 'main' ? ' (main number)' : ''} (type=${ev.syncType ?? '?'}, latest=${ev.isLatest}, progress=${ev.progress ?? '?'}): ${ev.messages?.length || 0} messages, ${ev.chats?.length || 0} chats, ${ev.contacts?.length || 0} contacts`, { level: 'info' });
    // Names/lid pairs in this batch first (PUSH_NAME batches have contacts but no
    // messages), then the messages — serialized with the other identity work.
    // The batch's @lid -> phone-number table (Baileys 7) — so its @lid chats show real numbers.
    const pairs = (ev.lidPnMappings || [])
      .map((m) => ({ id: m?.lid && jidNormalizedUser(m.lid), jid: m?.pn && jidNormalizedUser(m.pn) }))
      .filter((p) => isLid(p.id) && isPn(p.jid));
    rememberPairs(id, pairs);
    syncPending(id, +1);
    queueIdentity(async () => {
      try {
        if (!ctxOf(id)) return; // the number was removed while this batch waited — drop it
        if (pairs.length) await applyContactBatch(pairs);
        await applyContactBatch(ev.contacts, phoneOfAccount(id));
        await ingestPoolHistory(id, ev);
      } finally {
        syncPending(id, -1, ev.messages?.length || 0);
      }
    });
    markBaileysBatchDone(id, ev); // delivered — no fallback import needed for it
  });
  // Saved names from the phone's address book + their @lid <-> number pairs arrive via
  // the app-state contact sync (Baileys chat-utils contactAction → contacts.upsert).
  on('contacts.upsert', (list) => {
    queueIdentity(async () => {
      const n = await applyContactBatch(list, phoneOfAccount(id));
      if (n) audit('connection', `Updated ${n} chat name${n === 1 ? '' : 's'} from your WhatsApp contacts`, { level: 'info' });
    });
  });
  // Push names from incoming messages (Baileys chats.js → contacts.update).
  on('contacts.update', (list) => queueIdentity(() => applyContactBatch(list, phoneOfAccount(id))));
  // Group names (subjects) when they're created/changed.
  on('groups.upsert', (list) => applyGroupSubjects(id, list));
  on('groups.update', (list) => applyGroupSubjects(id, list));
  // Someone was made/removed as admin → our own posting rights may have changed.
  on('group-participants.update', (ev) => {
    if (ev?.action === 'promote' || ev?.action === 'demote') refreshGroupPermission(id, ev.id);
  });
  // Baileys 7: an @lid <-> phone-number pair WhatsApp told us (contact sync, profile links,
  // message envelopes) — remember it so that chat shows the real number.
  on('lid-mapping.update', (m) => {
    const list = (Array.isArray(m) ? m : [m])
      .map((x) => ({ lid: x?.lid && jidNormalizedUser(x.lid), pn: x?.pn && jidNormalizedUser(x.pn) }))
      .filter((x) => isLid(x.lid) && isPn(x.pn))
      .map((x) => ({ id: x.lid, jid: x.pn }));
    if (list.length) queueIdentity(() => applyContactBatch(list));
  });
}

// shouldSyncHistoryMessage hook: Baileys hands us each history notification here — read
// WhatsApp's number table / inline recent-chats batch from it (see onHistoryNotification).
export function historyHook(id, ws = DEFAULT_WS) {
  return inWs(ws, (notif) => {
    onHistoryNotification(id, notif);
    return true;
  });
}

// Re-read one linked phone's address book on the live connection (no QR): clear the stored
// version of WhatsApp's contacts collection (critical_unblock_low) so Baileys resyncs it from
// scratch — the same full snapshot a fresh link gets — and every saved name arrives again as
// contacts.upsert, now attributed to THIS phone.
export async function refreshAddressBook(id) {
  const a = ctxOf(id);
  if (!a?.sock || a.status !== 'connected' || !a.me?.phone) return false;
  await a.sock.authState.keys.set({ 'app-state-sync-version': { critical_unblock_low: null } });
  await a.sock.resyncAppState(['critical_unblock_low'], false);
  return true;
}

// One-time cleanup: names used to be stored once for all linked numbers, mixing address-book
// names from different phones and people's own WhatsApp names into `name`. Move those aside
// (kept in legacy_name), keep push names separately, drop the unattributed lid_map name, and
// un-flag contacts wrongly marked "number hidden". Each phone's address book is then re-read
// (refreshAddressBook) so saved names come back per number.
export async function migrateContactNames() {
  if (getSetting('namesV2', null)) return;
  const synced = { is_group: { $ne: 1 }, tags: { $in: ['whatsapp', 'inbound'] }, $or: [{ list_ids: { $exists: false } }, { list_ids: { $size: 0 } }] };
  const moved = await db.contacts().updateMany({ ...synced, name: { $nin: ['', null] } }, [{ $set: { legacy_name: '$name', name: '' } }]);
  const pushOps = [];
  for (const m of await db.lidMap().find({ notify: { $exists: true } }).toArray()) {
    pushOps.push({ updateMany: { filter: { lid: m._id, $or: [{ push_name: { $exists: false } }, { push_name: '' }] }, update: { $set: { push_name: m.notify } } } });
  }
  if (pushOps.length) await db.contacts().bulkWrite(pushOps, { ordered: false }).catch(() => {});
  await db.lidMap().updateMany({ name: { $exists: true } }, { $unset: { name: '' } });
  const unhidden = await db.contacts().updateMany(
    { lid_only: 1, lid: { $exists: true }, $expr: { $ne: ['$phone', { $arrayElemAt: [{ $split: ['$lid', '@'] }, 0] }] } },
    [{ $set: { jid: { $concat: ['$phone', '@s.whatsapp.net'] } } }, { $unset: 'lid_only' }]
  );
  await setSetting('namesV2', nowIso());
  audit('system', `Contact names: ${moved.modifiedCount} names reset to follow each number's own address book; ${unhidden.modifiedCount} chats no longer wrongly shown as "number hidden"`, { level: 'info' });
}

// A conversation number (or the main number) just connected.
export function onConversationOpen(id) {
  const a = ctxOf(id);
  if (!a) return;
  // A different phone on the same slot (the main number re-linked to another number):
  // drop the previous number's per-session caches.
  if (a.cachePhone !== a.me?.phone) {
    a.cachePhone = a.me?.phone;
    a.histSeen = new Set();
    a.histJobs = [];
    a.learnedPairs = new Map();
    a.groupSubjects = new Map();
    a.groupRO = new Map();
  }
  setSyncing(id, true, 12000); // expect history; don't show the loader forever if none comes
  // Group names: fetch once the initial sync settles, then again after history has created
  // the group chats (queries during the very first seconds can time out).
  clearTimeout(a.groupTimer1);
  clearTimeout(a.groupTimer2);
  a.groupTimer1 = setTimeout(() => syncGroupNames(id), 6000);
  a.groupTimer2 = setTimeout(() => syncGroupNames(id), 45000);
  // Once per number: re-read its address book so saved names are this phone's own (after the
  // initial sync has settled).
  clearTimeout(a.abTimer);
  a.abTimer = setTimeout(async () => {
    const phone = a.me?.phone;
    if (!phone || (getSetting('addressBookV2', {}) || {})[phone]) return;
    try {
      if (await refreshAddressBook(id)) {
        await setSetting('addressBookV2', { ...(getSetting('addressBookV2', {}) || {}), [phone]: nowIso() });
        audit('connection', `Re-read the saved contacts of +${phone} — chat names now follow this number's own address book`, { level: 'info' });
      }
    } catch (e) {
      audit('connection', `Couldn't re-read the saved contacts of +${phone}: ${e.message}`, { level: 'warn' });
    }
  }, 25000);
}

export async function removePoolAccount(id) {
  const a = ctxOf(id);
  if (accounts.has(id) && !a) return; // another workspace's number
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

// ---- Official WhatsApp Cloud API numbers ----
// They live in the same list as QR-linked numbers (same tabs, AI toggle, catalog, campaigns),
// but send through Meta's API with the business's own token instead of a WhatsApp Web session.
// `a.cloud` holds the credentials in memory; they never go to the browser.
export function registerCloudAccount(d) {
  const id = String(d._id);
  const ws = d.ws || DEFAULT_WS;
  const a = accounts.get(id) || { id };
  Object.assign(a, {
    id,
    ws,
    kind: 'cloud',
    label: d.label || '',
    role: 'conversation',
    autoReply: !!d.auto_reply,
    status: d.cloud?.error ? 'error' : 'connected',
    lastError: d.cloud?.error || null,
    qr: null,
    sock: null,
    me: { phone: d.phone || null, name: d.name || d.cloud?.verified_name || '' },
    cloud: {
      phone_number_id: d.cloud?.phone_number_id,
      waba_id: d.cloud?.waba_id,
      token: d.cloud?.token,
    },
  });
  accounts.set(id, a);
  runInWs(ws, () => emitPool());
  return a;
}
// 'cloud' for an official API number, 'qr' otherwise (main, scanned numbers, unknown ids).
export function accountKind(id) {
  return (id && id !== 'main' && ctxOf(id)?.kind) || 'qr';
}
// The credentials of an official number in this workspace (null for anything else).
export function cloudAccountOf(id) {
  const a = id === 'main' ? null : ctxOf(id);
  return a?.kind === 'cloud' ? a.cloud : null;
}
// The official number that owns a Meta phone number id (any workspace — the webhook has none).
export function accountByPhoneNumberId(pnid) {
  return [...accounts.values()].find((a) => a.kind === 'cloud' && String(a.cloud?.phone_number_id) === String(pnid)) || null;
}
// Messages an official number receives (from the webhook) — same handling as linked numbers.
export function ingestCloud(accountId, ev) {
  return ingestPool(accountId, ev);
}
const jidPhone = (jid) => {
  if (!isPn(jid)) throw new Error('Official API numbers can only message phone numbers (not groups)');
  return jidToPhone(jid);
};

export function isAccountConnected(id) {
  const a = id === 'main' ? null : ctxOf(id);
  return !!(a && a.status === 'connected' && (a.sock || a.kind === 'cloud'));
}

// Update a running account's display label (so poolState reflects it immediately).
export function setPoolLabel(id, label) {
  const a = id === 'main' ? null : ctxOf(id);
  if (a) a.label = label;
}

// Per-account AI auto-reply toggle.
export function setPoolAutoReply(id, enabled) {
  const a = id === 'main' ? null : ctxOf(id);
  if (a) a.autoReply = !!enabled;
}

// The role of a pool account ('warmup' | 'conversation' | 'api' — the Developer page's
// API-only number), or null if unknown.
export function accountRole(id) {
  return (id === 'main' ? null : ctxOf(id)?.role) || null;
}

// The workspace a number belongs to (null if unknown).
export function accountWs(id) {
  return (id === 'main' ? mainCtx?.ws : accounts.get(id)?.ws) || null;
}

export async function checkOnWhatsAppVia(fromId, phone) {
  const a = fromId === 'main' ? null : ctxOf(fromId);
  // Meta's API has no "is this number on WhatsApp?" lookup: send, and a failed delivery comes
  // back on the webhook.
  if (a?.kind === 'cloud') return a.status === 'connected' ? { exists: true, unchecked: true } : { exists: false, reason: 'not_connected' };
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
  const a = ctxOf(fromId);
  if (a?.kind === 'cloud') {
    if (a.status !== 'connected') throw new Error('Source number not connected');
    return sendCloudText(a.cloud, jidPhone(jid), text);
  }
  if (!a?.sock || a.status !== 'connected') throw new Error('Source number not connected');
  jid = await sendAddress(fromId, jid);
  await a.sock.sendPresenceUpdate('composing', jid).catch(() => {});
  const sent = await a.sock.sendMessage(jid, { text });
  return sent?.key?.id || null;
}

export async function sendFromTo(fromId, toPhone, text) {
  const a = fromId === 'main' ? null : ctxOf(fromId);
  if (a?.kind === 'cloud') {
    if (a.status !== 'connected') throw new Error('Source number not connected');
    return sendCloudText(a.cloud, toPhone, text);
  }
  if (!a?.sock || a.status !== 'connected') throw new Error('Source number not connected');
  const jid = await sendAddress(fromId, `${normalizePhone(toPhone)}@s.whatsapp.net`);
  await a.sock.sendPresenceUpdate('composing', jid).catch(() => {});
  const sent = await a.sock.sendMessage(jid, { text });
  return sent?.key?.id || null;
}

export async function sendMediaFromTo(fromId, toPhone, buffer, caption, mime) {
  const a = fromId === 'main' ? null : ctxOf(fromId);
  if (a?.kind === 'cloud') {
    if (a.status !== 'connected') throw new Error('Source number not connected');
    return sendCloudImage(a.cloud, toPhone, buffer, caption, mime);
  }
  if (!a?.sock || a.status !== 'connected') throw new Error('Source number not connected');
  const jid = await sendAddress(fromId, `${normalizePhone(toPhone)}@s.whatsapp.net`);
  const sent = await a.sock.sendMessage(jid, { image: buffer, caption: caption || undefined });
  return sent?.key?.id || null;
}

// Any Baileys message content ({ text } / { image, caption } / { document, mimetype, fileName,
// caption }) from a QR-linked number of this workspace — the Developer API sends receipts with it.
export async function sendContentFromTo(fromId, toPhone, content) {
  const a = fromId === 'main' ? null : ctxOf(fromId);
  if (a?.kind === 'cloud') throw new Error('Official API numbers send through cloud-api.js');
  if (!a?.sock || a.status !== 'connected') throw new Error('Source number not connected');
  const jid = await sendAddress(fromId, `${normalizePhone(toPhone)}@s.whatsapp.net`);
  const sent = await a.sock.sendMessage(jid, content);
  return sent?.key?.id || null;
}

// ---- Per-account inbound: capture chats for this pool number (not warm-up traffic) ----
// Text to show for a message. Unwraps disappearing / view-once / edited / captioned-document
// wrappers (Baileys normalizeMessageContent) — before, those came back empty and the message
// (often a chat's latest) was dropped. Media without text gets a WhatsApp-Web-style label.
function textOf(msg) {
  const m = normalizeMessageContent(msg.message);
  if (!m) return '';
  const text =
    m.conversation ||
    m.extendedTextMessage?.text ||
    m.imageMessage?.caption ||
    m.videoMessage?.caption ||
    m.documentMessage?.caption ||
    m.buttonsResponseMessage?.selectedDisplayText ||
    m.templateButtonReplyMessage?.selectedDisplayText ||
    m.listResponseMessage?.title ||
    '';
  if (text) return text;
  if (m.imageMessage) return '📷 Photo';
  if (m.videoMessage) return m.videoMessage.gifPlayback ? 'GIF' : '🎥 Video';
  if (m.audioMessage) return m.audioMessage.ptt ? '🎤 Voice message' : '🎵 Audio';
  if (m.stickerMessage) return 'Sticker';
  if (m.documentMessage) return `📄 ${m.documentMessage.fileName || 'Document'}`;
  if (m.locationMessage || m.liveLocationMessage) return '📍 Location';
  if (m.contactMessage || m.contactsArrayMessage) return '👤 Contact';
  const poll = m.pollCreationMessage || m.pollCreationMessageV2 || m.pollCreationMessageV3;
  if (poll) return `📊 ${poll.name || 'Poll'}`;
  return ''; // reactions, deletes, protocol messages — not shown as chat lines
}

// What a message needs stored to render like WhatsApp: for media, the download key material
// (so /api/conversations/media/:id can fetch + decrypt it later via Baileys
// downloadMediaMessage), its type/mime/caption, and the tiny inline JPEG preview WhatsApp
// ships with photos/videos (shown instantly while the full file loads); for locations, coords.
const MEDIA_NODES = ['imageMessage', 'videoMessage', 'audioMessage', 'stickerMessage', 'documentMessage'];
function mediaFieldsOf(msg) {
  const m = normalizeMessageContent(msg?.message);
  if (!m) return {};
  const node = MEDIA_NODES.find((k) => m[k]);
  if (node) {
    const c = m[node];
    const type =
      node === 'audioMessage' ? (c.ptt ? 'voice' : 'audio') : node === 'videoMessage' && c.gifPlayback ? 'gif' : node.replace('Message', '');
    const { jpegThumbnail, contextInfo, ...rest } = c; // keep the stored key small
    const out = {
      type,
      media: 1,
      media_raw: JSON.stringify({ key: msg.key, message: { [node]: rest } }, BufferJSON.replacer),
      mime: c.mimetype || '',
      caption: c.caption || '',
    };
    if (c.fileName) out.file_name = c.fileName;
    if (Number(c.seconds)) out.seconds = Number(c.seconds);
    if (Number(c.fileLength)) out.size = Number(c.fileLength);
    if (c.width && c.height) {
      out.w = c.width;
      out.h = c.height;
    }
    if (jpegThumbnail?.length) out.thumb = Buffer.from(jpegThumbnail).toString('base64');
    return out;
  }
  const loc = m.locationMessage || m.liveLocationMessage;
  if (loc) {
    return { type: 'location', location: { lat: loc.degreesLatitude, lng: loc.degreesLongitude, name: loc.name || loc.address || '' } };
  }
  return {};
}

// What WhatsApp shows around a message besides its content: the message it replies to
// (quoted, above the text), "Forwarded", and in groups who sent it (its jid is also needed to
// reply to / react to / pin that message). From the message's contextInfo.
function extrasOf(msg, myPhone, accountId) {
  const m = normalizeMessageContent(msg?.message);
  const out = {};
  if (msg?.key?.participant) out.sender_jid = msg.key.participant;
  if (!m) return out;
  const holder = Object.values(m).find((v) => v && typeof v === 'object' && v.contextInfo);
  const ctx = holder?.contextInfo;
  if (!ctx) return out;
  if (ctx.isForwarded) out.forwarded = 1;
  if (ctx.stanzaId && ctx.quotedMessage) {
    const who = String(ctx.participant || '');
    const meLid = ctxOf(accountId)?.sock?.user?.lid;
    const mine = !!who && ((myPhone && jidToPhone(who) === myPhone) || (meLid && jidToPhone(who) === jidToPhone(meLid)));
    out.quoted = { id: ctx.stanzaId, body: textOf({ message: ctx.quotedMessage }).slice(0, 300), participant: who, from_me: mine ? 1 : 0 };
  }
  return out;
}

// "Pin for everyone" / "Unpin" from either side (the phone, the contact, or this app) →
// the pinned message shows in a bar under the chat header until it expires.
async function applyPin(msg) {
  const p = normalizeMessageContent(msg?.message)?.pinInChatMessage;
  if (!p?.key?.id) return false;
  const secs = Number(normalizeMessageContent(msg.message)?.messageContextInfo?.messageAddOnDurationInSecs) || 7 * 86400;
  if (p.type === 1) {
    await db.messages().updateOne({ wa_message_id: p.key.id }, { $set: { pinned_at: nowIso(), pinned_until: new Date(Date.now() + secs * 1000).toISOString() } });
  } else {
    await db.messages().updateOne({ wa_message_id: p.key.id }, { $unset: { pinned_at: '', pinned_until: '' } });
  }
  return true;
}

// The WhatsApp key of a stored message: needed to reply to it, react, pin, star or delete it.
// Incoming group messages also need the sender (stored as sender_jid since 2026-11-24);
// older ones without it get null for actions that need it.
export function messageKeyOf(doc, contact) {
  const remoteJid = doc.chat_jid || chatJidOf(contact);
  const key = { remoteJid, fromMe: doc.direction === 'out', id: doc.wa_message_id };
  if (remoteJid.endsWith('@g.us') && doc.direction === 'in') {
    if (!doc.sender_jid) return null;
    key.participant = doc.sender_jid;
  }
  return key;
}
// The stored message as WhatsApp content (photo/document: the original media; else its text).
export async function contentOf(doc) {
  if (doc.media_raw) {
    try {
      const w = JSON.parse(doc.media_raw, BufferJSON.reviver);
      if (w?.message && Object.keys(w.message).length) return w.message;
    } catch {}
  }
  return doc.body ? { conversation: doc.body } : null;
}
// Send any content (text with a quote, a reaction, a pin, a delete, a forward) from one of this
// workspace's QR-linked numbers into a chat. Returns the WhatsApp id and the address used.
// `exact`: an action on an existing message (react, pin, delete) goes to that message's own
// chat address, not re-resolved.
export async function sendToChat(accountId, jid, content, { exact = false, ...options } = {}) {
  const a = ctxOf(accountId);
  if (!a?.sock || a.status !== 'connected') throw new Error('That number is not connected');
  const to = exact ? jid : await sendAddress(accountId, jid);
  if (content?.text) await a.sock.sendPresenceUpdate('composing', to).catch(() => {});
  const sent = await a.sock.sendMessage(to, content, options);
  return { id: sent?.key?.id || null, jid: to };
}
// Star / delete-for-me on the linked phone too (WhatsApp syncs these between your devices).
export async function chatModifyOn(accountId, mod, jid) {
  const a = ctxOf(accountId);
  if (!a?.sock || a.status !== 'connected') return false;
  try {
    await a.sock.chatModify(mod, jid);
    return true;
  } catch {
    return false; // app-state not synced yet — the change still applies in this app
  }
}

// One more unread message in a chat — in total (unread) and on the number it came to
// (unread_by.<phone>), so each number's tab can show its own red counter.
function unreadInc(myPhone) {
  return /^\d+$/.test(String(myPhone || '')) ? { unread: 1, [`unread_by.${myPhone}`]: 1 } : { unread: 1 };
}

// A reaction (👍 on a message) updates the message it points at, like WhatsApp shows it.
async function applyReaction(msg) {
  const r = normalizeMessageContent(msg?.message)?.reactionMessage;
  if (!r?.key?.id) return false;
  const from = msg.key?.fromMe ? 'me' : msg.key?.participant || msg.key?.remoteJid || '';
  await db.messages().updateOne({ wa_message_id: r.key.id }, { $pull: { reactions: { from } } });
  if (r.text) await db.messages().updateOne({ wa_message_id: r.key.id }, { $push: { reactions: { emoji: r.text, from } } });
  return true;
}

// Fetch + decrypt a stored media message. If WhatsApp's server already deleted the file
// (404/410), Baileys asks the linked phone to re-upload it (reuploadRequest), like WA Web.
export async function downloadStoredMedia(doc) {
  const waMsg = JSON.parse(doc.media_raw, BufferJSON.reviver);
  const ws = currentWs() || DEFAULT_WS; // only this workspace's numbers fetch its media
  const live = [...accounts.values(), mainCtx].filter((a) => a?.sock && a.status === 'connected' && (a.ws || DEFAULT_WS) === ws);
  const acc = live.find((a) => doc.account_phone && a.me?.phone === doc.account_phone) || live.find((a) => a.role === 'conversation');
  return downloadMediaMessage(waMsg, 'buffer', {}, acc ? { logger, reuploadRequest: acc.sock.updateMediaMessage } : undefined);
}

// A message's own send time (WhatsApp timestamp), not the time we happened to receive it —
// matters for messages caught up from the offline queue after a reconnect.
function msgTime(msg) {
  const t = Number(msg?.messageTimestamp) || 0;
  return t ? new Date(t * 1000).toISOString() : nowIso();
}
const isLid = (j) => typeof j === 'string' && j.endsWith('@lid');
const isPn = (j) => typeof j === 'string' && j.endsWith('@s.whatsapp.net');

// The real-number jid of a 1:1 chat, if the message carries one. Baileys 7 puts the chat's
// other address in key.remoteJidAlt (6.7: senderPn / participantPn). Those come from the
// SENDER's envelope, so on our own (fromMe) messages the alt can be OUR number — never let
// it name the chat.
function pnOf(msg) {
  const k = msg.key || {};
  const own = k.fromMe ? ourPhones() : null;
  const alt = own && isPn(k.remoteJidAlt) && own.has(jidToPhone(k.remoteJidAlt)) ? null : k.remoteJidAlt;
  const cands = k.fromMe ? [k.remoteJid, alt] : [k.remoteJid, alt, k.senderPn, k.participantPn];
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

// Which address to send a 1:1 message to. WhatsApp has moved some numbers' chats to hidden
// IDs (@lid): on such a number a message to the phone-number address never arrives (Baileys
// 6.7: stuck at "sent"; 7: rejected with error 479 "smax-invalid"), while the phone itself
// sends that chat to the @lid and it's read. Measured on 2026-11-24: the Grabatoz number sent
// 93 of its 137 phone messages to @lid and all 4 app sends to numbers failed; the main
// number's chats still use numbers and its app sends are delivered. So send the way this
// number's chat already works: the address of its newest message that proves it (one we
// received, or one delivered/read). No such message → the number, as before.
export async function sendAddress(accountId, jid) {
  if (!isPn(jid)) return jid; // groups, @lid chats, newsletters are already exact
  const myPhone = phoneOfAccount(accountId);
  if (!myPhone) return jid;
  try {
    const contact = await db.contacts().findOne({ phone: jidToPhone(jid), is_group: { $ne: 1 } }, { projection: { _id: 1, lid: 1 } });
    if (!contact) return jid; // never talked → nothing to go by
    const lid = isLid(contact.lid) ? contact.lid : (await db.lidMap().findOne({ pn: jid }, { projection: { _id: 1 } }))?._id;
    if (!isLid(lid)) return jid;
    const [last] = await db
      .messages()
      .find(
        { contact_id: String(contact._id), account_phone: myPhone, chat_jid: { $in: [jid, lid] }, $or: [{ direction: 'in' }, { status: { $in: ['delivered', 'read'] } }] },
        { projection: { chat_jid: 1 } }
      )
      .sort({ created_at: -1 })
      .limit(1)
      .toArray();
    return last?.chat_jid === lid ? lid : jid;
  } catch {
    return jid;
  }
}

// The linked session that owns a phone in this workspace ('main' or a pool id).
function accountIdForPhone(phone) {
  if (!phone) return null;
  if (mainCtx?.me?.phone === phone && ctxOf('main')) return 'main';
  const list = wsAccounts().filter((a) => a.me?.phone === phone && a.sock);
  return (list.find((a) => a.status === 'connected') || list[0])?.id || null;
}

// WhatsApp rejected one of our 1:1 messages with error 479 ("smax-invalid": the address
// doesn't fit how this chat is addressed). Send it once more to the chat's other address
// (number <-> @lid). It never arrived, so this can't duplicate it.
const resentOnce = new Set();
async function resendOnOtherAddress(waId, code) {
  if (String(code) !== '479' || !waId || resentOnce.has(waId)) return;
  resentOnce.add(waId);
  try {
    const m = await db.messages().findOne({ wa_message_id: waId, direction: 'out' });
    if (!m || m.resent_from || !m.contact_id || !m.chat_jid) return;
    const contact = await db.contacts().findOne({ _id: oid(m.contact_id) });
    if (!contact || contact.is_group) return;
    const pn = contact.phone && !contact.lid_only ? `${normalizePhone(contact.phone)}@s.whatsapp.net` : null;
    const lid = isLid(contact.lid) ? contact.lid : pn ? (await db.lidMap().findOne({ pn }, { projection: { _id: 1 } }))?._id : null;
    const other = m.chat_jid === lid ? pn : isPn(m.chat_jid) && isLid(lid) ? lid : null;
    const id = accountIdForPhone(m.account_phone);
    const sock = id && ctxOf(id)?.sock;
    if (!other || !sock) return;
    const content = await storedMessageFor({ id: waId });
    if (!content) return;
    const newId = content.conversation != null && Object.keys(content).length === 1
      ? (await sock.sendMessage(other, { text: content.conversation }))?.key?.id
      : await sock.relayMessage(other, content, {});
    if (!newId) return;
    await db.messages().updateOne(
      { _id: m._id },
      { $set: { wa_message_id: newId, chat_jid: other, status: 'sent', resent_from: waId }, $unset: { error_code: '', status_code: '' } }
    );
    audit('reply', `WhatsApp rejected a message to ${contact.name || '+' + contact.phone} at its ${isLid(m.chat_jid) ? 'hidden ID' : 'number'} — sent it again to its ${isLid(other) ? 'hidden ID' : 'number'}`, { level: 'info' });
    emit('message:status', { waId: newId });
  } catch (e) {
    audit('reply', `Couldn't resend a rejected message: ${e.message}`, { level: 'warn' });
  }
}
setRejectedHandler(resendOnOtherAddress);

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
// Like WhatsApp: a SAVED name belongs to the address book of the linked phone it came from
// (ownerPhone) — kept per number in saved_names — while the push name (the person's own
// WhatsApp name, shown as "~Name") is the same everywhere.
async function applyContactBatch(list, ownerPhone = null) {
  const entries = [];
  for (const c of list || []) {
    if (!c?.id || typeof c.id !== 'string') continue;
    if (c.id.endsWith('@g.us') || c.id.endsWith('@newsletter') || c.id.endsWith('@broadcast')) continue;
    const jids = [c.id, c.lid, c.jid, c.phoneNumber].filter((x) => typeof x === 'string');
    const lid = jids.find(isLid) || null;
    const pn = jids.find(isPn) || null;
    const saved = String(c.name || '').trim();
    const push = String(c.notify || c.verifiedName || '').trim();
    const savedHere = ownerPhone ? saved : ''; // can't attribute a saved name without its phone
    if (!(lid && pn) && !savedHere && !push) continue; // nothing useful (e.g. a picture change)
    entries.push({ lid, pn, saved: savedHere, push });
  }
  if (!entries.length) return 0;

  // 1) Remember lid -> number/name so later history + live messages resolve straight away.
  const mapOps = [];
  for (const e of entries) {
    if (!e.lid) continue;
    const set = { updated_at: nowIso() };
    if (e.pn) set.pn = e.pn;
    if (e.saved) set[`names.${ownerPhone}`] = e.saved;
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
  const w = contactWriter();
  let fixed = 0;
  for (const e of entries) {
    if (reconcileContact(e, byPhone, byLid, w, ownerPhone)) fixed++;
  }
  if (fixed) {
    await w.flush(); // one round of writes for the whole batch
    emit('message:in', {});
  }
  return fixed;
}

// Decides in memory what to change for one contact entry; writes go through `w` (batched).
function reconcileContact(e, byPhone, byLid, w, ownerPhone) {
  const lidNum = e.lid ? jidToPhone(e.lid) : null;
  const pnNum = e.pn ? jidToPhone(e.pn) : null;
  let lidC = e.lid ? byLid.get(e.lid) || byPhone.get(lidNum) || null : null;
  const pnC = pnNum ? byPhone.get(pnNum) || null : null;
  if (lidC && pnC && String(lidC._id) === String(pnC._id)) lidC = null;

  // Same person stored twice (once by @lid, once by real number) → merge into the number.
  if (lidC && pnC) {
    w.moveMessages(lidC._id, pnC._id);
    const set = { lid: e.lid };
    for (const [ph, nm] of Object.entries(lidC.saved_names || {})) if (nm && !pnC.saved_names?.[ph]) set[`saved_names.${ph}`] = nm;
    if (e.saved) set[`saved_names.${ownerPhone}`] = e.saved;
    const push = e.push || pnC.push_name || lidC.push_name;
    if (push && push !== pnC.push_name) set.push_name = push;
    if (!pnC.name && lidC.name) set.name = lidC.name; // a name the user gave in this app (import/edit)
    if (lidC.pinned) set.pinned = 1;
    const inc = lidC.unread ? { unread: lidC.unread } : {};
    for (const [ph, n] of Object.entries(lidC.unread_by || {})) if (n > 0) inc[`unread_by.${ph}`] = n; // per-number unread moves too
    w.update(pnC, { set, unset: { lid_only: '' }, inc });
    w.remove(lidC);
    applySet(pnC, set);
    delete pnC.lid_only;
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
  } else if (lidC && !lidC.lid_only && lidC.phone === lidNum) {
    // Only rows that stored the lid AS the phone are "number hidden". (Real bug: a push-name
    // update keyed by @lid flagged a contact whose real number we already had.)
    set.lid = e.lid;
    set.jid = e.lid;
    set.lid_only = 1;
  } else if (pnC && e.lid && !pnC.lid) {
    set.lid = e.lid;
  }
  if (e.saved && target.saved_names?.[ownerPhone] !== e.saved) set[`saved_names.${ownerPhone}`] = e.saved;
  if (e.push && target.push_name !== e.push) set.push_name = e.push;
  if (!Object.keys(set).length) return false;
  w.update(target, { set, unset: resolved ? { lid_only: '' } : {} });
  if (resolved) {
    byPhone.delete(lidC.phone);
    byPhone.set(pnNum, target);
    delete target.lid_only;
  }
  applySet(target, set);
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

// History batches. Baileys 7 handles every history notification itself — the downloaded
// blobs AND the first batch WhatsApp sends inline (initialHistBootstrapInlinePayload, which
// 6.7 failed on with "Cannot derive from empty media key") — and emits messaging-history.set
// with the batch's @lid -> phone-number table (lidPnMappings). So the app no longer downloads
// each blob a second time to read that table. What stays here is the safety net: each
// notification becomes a job; when Baileys delivers the batch the job is done, and if it
// never does (download failed, initial-sync buffer stuck on the phone), we import it ourselves.
const HIST_FALLBACK_MS = 60000;
function onHistoryNotification(id, notif) {
  const a = ctxOf(id);
  if (!a) return;
  const inline = notif?.initialHistBootstrapInlinePayload;
  if (!inline?.length && !(notif?.directPath && notif?.mediaKey)) return; // Baileys' "will we sync?" probe
  a.histSeen ||= new Set();
  const key = inline?.length ? `inline:${notif.syncType}:${notif.chunkOrder ?? ''}:${inline.length}` : notif.directPath;
  if (a.histSeen.has(key)) return;
  a.histSeen.add(key);
  const job = { notif, inline: !!inline?.length, retries: 0 };
  (a.histJobs ||= []).push(job);
  // Type 1 (INITIAL_STATUS_V3) is the Status-updates feed, not chats: tracked (so the jobs
  // stay matched to Baileys' batches) but never imported by us.
  if (notif.syncType === proto.HistorySync.HistorySyncType.INITIAL_STATUS_V3) return;
  const arm = () => {
    job.timer = setTimeout(() => {
      const acc = ctxOf(id);
      if (!acc || job.done) return;
      // Baileys still delivering batches recently → it's progressing; give it more time.
      if (acc.lastHistAt && Date.now() - acc.lastHistAt < 20000 && job.retries++ < 3) return arm();
      job.done = true;
      if (job.inline) importInlineHistory(id, notif);
      else runHistJob(id, job);
    }, HIST_FALLBACK_MS);
  };
  arm();
}

// Baileys delivered a batch (messaging-history.set): its job needs no fallback. Matched by
// type + chunk order when the batch says, else the oldest open job.
function markBaileysBatchDone(id, ev) {
  const a = ctxOf(id);
  if (!a) return;
  a.lastHistAt = Date.now();
  const open = (a.histJobs || []).filter((j) => !j.done);
  const job =
    (ev?.chunkOrder != null && open.find((j) => j.notif.syncType === ev.syncType && j.notif.chunkOrder === ev.chunkOrder)) ||
    open.find((j) => j.notif.syncType === ev?.syncType) ||
    open[0];
  if (!job) return;
  job.done = true;
  clearTimeout(job.timer);
  a.histJobs = a.histJobs.filter((j) => !j.done);
}

// The inline payload is a HistorySync, zlib-compressed like the downloaded blobs (Baileys'
// downloadHistory inflates then decodes). Try that first, then plain, and keep whichever
// decodes to real content — the audit line records which one it was.
async function decodeInlineHistory(bytes) {
  const buf = Buffer.from(bytes);
  let lastErr = null;
  for (const compressed of [true, false]) {
    try {
      const data = proto.HistorySync.decode(compressed ? await inflateAsync(buf) : buf);
      if (data?.conversations?.length || data?.phoneNumberToLidMappings?.length || data?.pushnames?.length) {
        return { data, compressed };
      }
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr || new Error('payload had no chats');
}

// Fallback for WhatsApp's inline first batch (your most recent chats), when Baileys didn't
// deliver it.
function importInlineHistory(id, notif) {
  syncPending(id, +1);
  histChain = histChain.then(async () => {
    try {
      await importInlineHistoryNow(id, notif);
    } finally {
      syncPending(id, -1);
    }
  });
}
async function importInlineHistoryNow(id, notif) {
  if (!ctxOf(id)) return;
  let res;
  try {
    res = await decodeInlineHistory(notif.initialHistBootstrapInlinePayload);
  } catch (e) {
    audit('connection', `Couldn't read WhatsApp's first history batch (recent chats, type=${notif.syncType}): ${e.message}`, { level: 'warn' });
    return;
  }
  const raw = res.data;
  if (raw.syncType == null) raw.syncType = notif.syncType;
  const pairs = mappingsFromHistory(raw);
  rememberPairs(id, pairs);
  await queueIdentity(async () => {
    if (!ctxOf(id)) return; // removed meanwhile
    if (pairs.length) await applyContactBatch(pairs);
    const data = processHistoryMessage(raw); // Baileys' own parser → same shape as its event
    audit('connection', `Imported your most recent chats (type=${raw.syncType}, ${res.compressed ? 'compressed' : 'plain'}): ${data.messages.length} messages, ${data.chats.length} chats${pairs.length ? `, ${pairs.length} phone numbers` : ''}`, { level: 'success' });
    await applyContactBatch(data.contacts, phoneOfAccount(id));
    await ingestPoolHistory(id, data);
  });
}

let histChain = Promise.resolve();
// Fallback: WhatsApp announced a history blob but Baileys never delivered it — download and
// import it ourselves (idempotent: messages dedupe by WhatsApp id).
function runHistJob(id, job) {
  syncPending(id, +1);
  histChain = histChain.then(async () => {
    try {
      if (!ctxOf(id)) return; // number was removed meanwhile
      let raw;
      try {
        raw = await downloadHistory(job.notif, {});
      } catch (e) {
        audit('connection', `Couldn't download a history batch (WhatsApp never delivered it): ${e.message}`, { level: 'warn' });
        return;
      }
      const pairs = mappingsFromHistory(raw);
      rememberPairs(id, pairs);
      await queueIdentity(async () => {
        if (!ctxOf(id)) return;
        if (pairs.length) await applyContactBatch(pairs);
        const data = processHistoryMessage(raw); // Baileys' own parser → same shape as the event
        audit('connection', `Imported a history batch directly (type=${raw.syncType}): ${data.messages.length} messages, ${data.chats.length} chats — WhatsApp hadn't delivered it`, { level: 'info' });
        await applyContactBatch(data.contacts, phoneOfAccount(id));
        await ingestPoolHistory(id, data);
      });
    } finally {
      syncPending(id, -1);
    }
  });
}
// In-memory backup of learned @lid -> number pairs, in case the lid_map write fails.
function rememberPairs(id, pairs) {
  const a = ctxOf(id);
  if (!a || !pairs?.length) return;
  a.learnedPairs ||= new Map();
  for (const p of pairs) a.learnedPairs.set(p.id, p.jid);
}

// Can this linked number post in a group? From Baileys group metadata (groups.js):
//  isCommunity        → the community itself; nobody posts there (you post in its groups)
//  announce / isCommunityAnnounce → admins only ("Only admins can send messages")
//  participants[].admin           → 'admin' | 'superadmin' | null for each member (by pn or lid)
function myIds(a) {
  const u = a?.sock?.user || {};
  return new Set([u.id, u.lid].filter(Boolean).map((j) => jidNormalizedUser(j)));
}
export function groupReadOnly(g, mine) {
  if (g?.isCommunity) return true;
  if (!(g?.announce || g?.isCommunityAnnounce)) return false;
  const me = (g.participants || []).find((p) => [p.id, p.jid, p.lid, p.phoneNumber].some((x) => x && mine.has(jidNormalizedUser(x))));
  return !me?.admin;
}
// read_only_for = the linked numbers (phones) that can't post in this group.
function readOnlyOp(jid, phone, ro) {
  return {
    updateMany: {
      filter: { jid, is_group: 1 },
      update: ro ? { $addToSet: { read_only_for: phone } } : { $pull: { read_only_for: phone } },
    },
  };
}

// Group subjects (names) + posting permission — history sync carries neither, so fetch them
// like WhatsApp Web does.
async function syncGroupNames(id) {
  const a = ctxOf(id);
  if (!a?.sock || a.status !== 'connected') return;
  let groups;
  try {
    groups = await a.sock.groupFetchAllParticipating();
  } catch {
    return;
  }
  const subjects = new Map();
  const mine = myIds(a);
  const ops = [];
  for (const [jid, g] of Object.entries(groups || {})) {
    if (g?.subject) {
      subjects.set(jid, g.subject);
      ops.push({ updateMany: { filter: { jid, is_group: 1, name: { $ne: g.subject } }, update: { $set: { name: g.subject } } } });
    }
    if (a.me?.phone) ops.push(readOnlyOp(jid, a.me.phone, groupReadOnly(g, mine)));
  }
  a.groupSubjects = subjects;
  a.groupRO = new Map(Object.entries(groups || {}).map(([jid, g]) => [jid, groupReadOnly(g, mine)]));
  if (!ops.length) return;
  try {
    const r = await db.contacts().bulkWrite(ops, { ordered: false });
    if (r.modifiedCount) emit('message:in', {});
  } catch {}
}

// One group's metadata changed (admins-only toggled, we were promoted/demoted) → re-check.
async function refreshGroupPermission(id, jid) {
  const a = ctxOf(id);
  if (!a?.sock || a.status !== 'connected' || !a.me?.phone || !jid) return;
  try {
    const g = await a.sock.groupMetadata(jid);
    const ro = groupReadOnly(g, myIds(a));
    (a.groupRO ||= new Map()).set(jid, ro);
    await db.contacts().bulkWrite([readOnlyOp(jid, a.me.phone, ro)]);
    emit('message:status', {});
  } catch {}
}

// Checked right before sending to a group: cached permission, else ask WhatsApp for this
// group's metadata. If WhatsApp can't be asked, allow it (a rejection is still caught and
// shown as "not sent" via the error ack).
export async function canPostInGroup(id, jid) {
  const a = ctxOf(id);
  if (!a?.sock || !jid) return true;
  if (a.groupRO?.has(jid)) return !a.groupRO.get(jid);
  try {
    const g = await Promise.race([a.sock.groupMetadata(jid), new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 6000))]);
    const ro = groupReadOnly(g, myIds(a));
    (a.groupRO ||= new Map()).set(jid, ro);
    if (a.me?.phone) db.contacts().bulkWrite([readOnlyOp(jid, a.me.phone, ro)]).catch(() => {});
    return !ro;
  } catch {
    return true;
  }
}

function applyGroupSubjects(id, list) {
  const a = ctxOf(id);
  for (const g of list || []) {
    if (!g?.id) continue;
    if ('announce' in g || 'restrict' in g || 'participants' in g) refreshGroupPermission(id, g.id);
    if (!g.subject) continue;
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

// Apply a $set-style map (keys may be dotted, e.g. 'saved_names.92300…') to an in-memory doc.
function applySet(doc, set) {
  for (const [k, v] of Object.entries(set)) {
    const parts = k.split('.');
    let o = doc;
    for (let i = 0; i < parts.length - 1; i++) {
      if (!o[parts[i]] || typeof o[parts[i]] !== 'object') o[parts[i]] = {};
      o = o[parts[i]];
    }
    o[parts[parts.length - 1]] = v;
  }
}

// ---- Contact storage, batched ----
// Every DB call is a round trip to Atlas (~64 ms measured). Looking contacts up and writing
// them one chat at a time made a 100-chat history batch take ~25 s before anything showed.
// So: one lookup for a whole batch, decide everything in memory, then one write.

// Index of stored contacts relevant to a batch (by number, by @lid, by jid).
async function loadContactIndex({ phones = [], lids = [], jids = [] }) {
  const or = [];
  const p = [...new Set(phones.filter(Boolean))];
  const l = [...new Set(lids.filter(Boolean))];
  const j = [...new Set(jids.filter(Boolean))];
  if (p.length) or.push({ phone: { $in: p } });
  if (l.length) or.push({ lid: { $in: l } });
  if (j.length) or.push({ jid: { $in: j } });
  const docs = or.length ? await db.contacts().find({ $or: or }).toArray() : [];
  const idx = { byPhone: new Map(), byLid: new Map(), byJid: new Map() };
  for (const d of docs) indexContact(idx, d);
  return idx;
}
function indexContact(idx, d) {
  if (d.phone) idx.byPhone.set(d.phone, d);
  if (d.lid) idx.byLid.set(d.lid, d);
  if (d.jid) idx.byJid.set(d.jid, d);
}

// Collects contact inserts/updates/deletes/merges for a batch and writes them in one go.
// Updates to the same contact are folded into a single operation.
function contactWriter() {
  const inserts = [];
  const insertSet = new Set();
  const updates = new Map(); // id -> { _id, set, unset, inc }
  const deletes = new Map(); // id -> _id
  const moves = []; // [fromContactId, toContactId] — messages of a merged duplicate
  return {
    insert(doc) {
      inserts.push(doc);
      insertSet.add(doc);
    },
    update(doc, { set = {}, unset = {}, inc = {} }) {
      if (insertSet.has(doc)) {
        // not written yet → just change the document we're about to insert
        applySet(doc, set);
        for (const f of Object.keys(unset)) delete doc[f];
        for (const [f, v] of Object.entries(inc)) doc[f] = (doc[f] || 0) + v;
        return;
      }
      const k = String(doc._id);
      const u = updates.get(k) || { _id: doc._id, set: {}, unset: {}, inc: {} };
      for (const [f, v] of Object.entries(set)) {
        u.set[f] = v;
        delete u.unset[f];
      }
      for (const f of Object.keys(unset)) {
        u.unset[f] = '';
        delete u.set[f];
      }
      for (const [f, v] of Object.entries(inc)) u.inc[f] = (u.inc[f] || 0) + v;
      updates.set(k, u);
    },
    remove(doc) {
      deletes.set(String(doc._id), doc._id);
      updates.delete(String(doc._id));
    },
    moveMessages(fromId, toId) {
      moves.push([String(fromId), String(toId)]);
    },
    // Returns a map of planned-new-contact id → real id, for the rare case where another
    // writer (e.g. a live message) created the same number between our lookup and insert.
    async flush() {
      const remap = new Map();
      if (inserts.length) {
        try {
          await db.contacts().insertMany(inserts, { ordered: false });
        } catch (e) {
          const errs = [].concat(e?.writeErrors || []);
          if (!errs.length || errs.some((w) => (w.code ?? w.err?.code) !== 11000)) throw e;
          const lost = errs.map((w) => inserts[w.index]).filter(Boolean);
          const found = await db.contacts().find({ $or: [{ phone: { $in: lost.map((d) => d.phone) } }, { jid: { $in: lost.map((d) => d.jid).filter(Boolean) } }] }).toArray();
          for (const d of lost) {
            const real = found.find((f) => f.phone === d.phone || (d.is_group && f.jid === d.jid));
            if (real) remap.set(String(d._id), real._id);
          }
        }
      }
      if (moves.length) {
        await db.messages().bulkWrite(moves.map(([from, to]) => ({ updateMany: { filter: { contact_id: from }, update: { $set: { contact_id: to } } } })), { ordered: true });
      }
      const ops = [];
      for (const u of updates.values()) {
        if (deletes.has(String(u._id))) continue;
        const upd = {};
        if (Object.keys(u.set).length) upd.$set = u.set;
        if (Object.keys(u.unset).length) upd.$unset = u.unset;
        if (Object.keys(u.inc).length) upd.$inc = u.inc;
        if (Object.keys(upd).length) ops.push({ updateOne: { filter: { _id: u._id }, update: upd } });
      }
      for (const _id of deletes.values()) ops.push({ deleteOne: { filter: { _id } } });
      // A number change can hit the unique index if another row already has it — skip just that one.
      if (ops.length) await db.contacts().bulkWrite(ops, { ordered: false }).catch(() => {});
      return remap;
    },
  };
}

// Decide (in memory) which stored contact a chat belongs to, or create one. Groups by jid.
// 1:1 by real number — or, when WhatsApp only gave us an @lid, by that lid (flagged lid_only
// so the UI never shows the lid as if it were a phone number). Same rules as before; only
// the database access is batched.
function planChat(idx, w, { phone, jid, isGroup = false, name = '', lid = null, savedName = '', pushName = '', ownerPhone = null }) {
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
    const existing = idx.byJid.get(jid);
    if (existing) {
      if (name && existing.name !== name) {
        w.update(existing, { set: { name } });
        existing.name = name;
      }
      return existing;
    }
    const doc = { _id: new ObjectId(), ...base, name: name || '', phone: jid.split('@')[0], jid, is_group: 1 };
    w.insert(doc);
    indexContact(idx, doc);
    return doc;
  }

  const lidNum = lid ? jidToPhone(lid) : null;
  const resolved = !!phone && phone !== lidNum; // we know the real number
  const existing = (resolved && idx.byPhone.get(phone)) || (lid && idx.byLid.get(lid)) || (lidNum && idx.byPhone.get(lidNum)) || null;

  if (existing) {
    const set = {};
    const unset = {};
    if (savedName && ownerPhone && existing.saved_names?.[ownerPhone] !== savedName) set[`saved_names.${ownerPhone}`] = savedName;
    if (pushName && existing.push_name !== pushName) set.push_name = pushName;
    if (lid && !existing.lid) set.lid = lid;
    if (resolved && existing.phone !== phone) {
      set.phone = phone;
      set.jid = `${phone}@s.whatsapp.net`;
      unset.lid_only = '';
    } else if (!resolved && lid && !existing.lid_only && existing.phone === lidNum) {
      set.lid_only = 1;
      set.jid = lid;
    }
    if (Object.keys(set).length) {
      w.update(existing, { set, unset });
      applySet(existing, set);
      if (unset.lid_only !== undefined) delete existing.lid_only;
      indexContact(idx, existing);
    }
    return existing;
  }

  // `name` stays for names given in this app (imports/edits); WhatsApp names go to
  // saved_names (per linked phone) and push_name.
  const names = {
    name: name || '',
    saved_names: savedName && ownerPhone ? { [ownerPhone]: savedName } : {},
    push_name: pushName || '',
  };
  const doc = resolved
    ? { _id: new ObjectId(), ...base, ...names, phone, jid: `${phone}@s.whatsapp.net`, is_group: 0, ...(lid ? { lid } : {}) }
    : { _id: new ObjectId(), ...base, ...names, phone: lidNum, jid: lid, lid, lid_only: 1, is_group: 0 };
  if (!doc.phone) return null;
  w.insert(doc);
  indexContact(idx, doc);
  return doc;
}

// Find/create one chat's contact (live messages): one lookup + at most one write.
async function upsertPoolChat(spec) {
  const lid = spec.lid || null;
  const idx = await loadContactIndex(
    spec.isGroup ? { jids: [spec.jid] } : { phones: [spec.phone, lid && jidToPhone(lid)], lids: [lid] }
  );
  const w = contactWriter();
  const c = planChat(idx, w, spec);
  if (!c) return null;
  const remap = await w.flush();
  return remap.has(String(c._id)) ? await db.contacts().findOne({ _id: remap.get(String(c._id)) }) : c;
}

// AI auto-reply, like a person answering: wait the human-like delay, and if more messages
// arrive meanwhile, restart the wait — then answer ONCE, to the latest message. (Before, every
// message in a burst got its own AI reply.)
// The wait never stretches past max seconds after their FIRST unanswered message (+ a short
// quiet gap, ≤3 s, if they're still typing) — measured replies were coming 12–31 s, up to ~1 min in bursts.
const autoReplyTimers = new Map(); // `${accountId}:${contactId}` -> { timer, firstAt, due }
function scheduleAutoReply(accountId, contact) {
  const key = `${accountId}:${contact._id}`;
  const minS = Math.max(0, Number(getSetting('autoReplyMinSec', 3)) || 0);
  const maxS = Math.max(minS, Number(getSetting('autoReplyMaxSec', 10)) || minS);
  const now = Date.now();
  const prev = autoReplyTimers.get(key);
  clearTimeout(prev?.timer);
  const firstAt = prev?.firstAt ?? now;
  const quiet = Math.min(3000, Math.max(1000, maxS * 1000)); // "still typing" gap, never longer than the max
  const due = prev
    ? Math.min(Math.max(prev.due, now + quiet), firstAt + maxS * 1000 + quiet) // short quiet gap, capped
    : now + randInt(minS, maxS) * 1000;
  const timer = setTimeout(() => {
    autoReplyTimers.delete(key);
    poolAutoReply(accountId, contact).catch(() => {});
  }, Math.max(0, due - now));
  autoReplyTimers.set(key, { timer, firstAt, due });
}

async function poolAutoReply(accountId, contact) {
  try {
    // The conversation as THIS number sees it: its own messages with this person, newest
    // last. (Real bug: it took the 14 OLDEST messages by insert order, across ALL linked
    // numbers — so a plain "Asslamoalikum" was answered about another chat's SEO issue.)
    const myPhone = phoneOfAccount(accountId);
    const q = { contact_id: String(contact._id), ...(myPhone ? { account_phone: myPhone } : { account_id: accountId }) };
    const history = (await db.messages().find(q).sort({ created_at: -1, _id: -1 }).limit(12).toArray()).reverse();
    // Product catalog (if connected): look up what they're asking about. Their new message(s)
    // count most; their earlier ones fill in ("asus gaming laptop?" … "the one under 2000AED" →
    // ASUS gaming laptops, budget 2000). Our last reply is passed apart: never read as their
    // budget, only used when they name nothing ("kitne ka hai?" after we named one).
    // Only the catalog chosen for THIS number (Conversations → AI settings).
    let products = null;
    const catalogIds = await catalogIdsForAccount(accountId);
    if (catalogIds.length) {
      let lastOutAt = history.length - 1;
      while (lastOutAt >= 0 && history[lastOutAt].direction !== 'out') lastOutAt--;
      const fresh = history.slice(lastOutAt + 1).filter((m) => m.direction === 'in').slice(-3).map((m) => m.body);
      const before = history.slice(0, lastOutAt + 1);
      const earlier = before.filter((m) => m.direction === 'in').slice(-2).map((m) => m.body);
      const ours = lastOutAt >= 0 ? history[lastOutAt].body || '' : '';
      products = await productContext({ latest: fresh.join('\n'), earlier: earlier.join('\n'), ours, catalogIds });
    }
    const reply = await conversationReply(history.map((m) => ({ direction: m.direction, body: m.body })), { products });
    if (reply === null) return; // "ok" / "thanks" / already answered — no reply needed
    const who = contact.name || contact.push_name || (contact.phone ? '+' + contact.phone : 'A contact');
    if (reply.handoff) {
      // It couldn't answer from what it knows — flag the chat so a person replies (Conversations →
      // "Needs human"), instead of a promise to "get back" that nothing keeps.
      const asked = history.filter((m) => m.direction === 'in').slice(-1)[0]?.body || '';
      await setHandoff(contact._id, myPhone, 'ai'); // on THIS number only
      audit('handoff', `AI couldn't answer ${who} — needs a person ("${asked.slice(0, 80)}")`, { level: 'warn', meta: { contactId: String(contact._id) } });
      emit('stats:dirty', {});
    }
    if (!reply.text) return;
    const waId = await sendJidFrom(accountId, chatJidOf(contact), reply.text);
    await db.messages().insertOne({
      contact_id: String(contact._id),
      campaign_id: null,
      account_id: accountId,
      account_phone: myPhone,
      chat_jid: chatJidOf(contact),
      direction: 'out',
      body: reply.text,
      status: 'sent',
      wa_message_id: waId,
      ai_auto: true,
      created_at: nowIso(),
      day_key: dayKey(),
    });
    await db.contacts().updateOne({ _id: contact._id }, { $set: { last_outbound_at: nowIso() } });
    emit('message:out', { contactId: String(contact._id) });
  } catch (err) {
    await setHandoff(contact._id, phoneOfAccount(accountId), 'reply');
    audit('handoff', `AI auto-reply failed for ${contact.name || contact.push_name || '+' + contact.phone} — handed to a human (${err.message})`, { level: 'warn', meta: { contactId: String(contact._id) } });
    emit('stats:dirty', {});
  }
}

// Ask the phone for messages older than the oldest one we have in a chat — WhatsApp Web's
// "Click here to get older messages from your phone" (Baileys fetchMessageHistory →
// HISTORY_SYNC_ON_DEMAND). The phone answers with an ON_DEMAND history batch, which the
// normal history import stores; the UI then loads them like any older page.
export async function requestOlderMessages(id, { chatJid, msgId, fromMe, tsMs, count = 50 }) {
  const a = ctxOf(id);
  if (a?.kind === 'cloud') throw new Error("Official API numbers can't load older messages — Meta only sends new messages to the app");
  if (!a?.sock || a.status !== 'connected') throw new Error('That number is not connected');
  await a.sock.fetchMessageHistory(count, { remoteJid: chatJid, fromMe: !!fromMe, id: msgId }, tsMs);
}

// The main number's live messages (client.js) — same handling as linked numbers.
export function ingestMain(ev) {
  return ingestPool('main', ev);
}

async function ingestPool(accountId, { messages, type }) {
  // 'notify' = new message; 'append' = delivered from WhatsApp's offline queue after we were
  // briefly disconnected (Baileys messages-recv: node.attrs.offline). Store both — dropping
  // 'append' lost every message that arrived during a restart/reconnect.
  if (type !== 'notify' && type !== 'append') return;
  // Warm-up numbers are isolated — they only message each other and never show in Conversations.
  if ((ctxOf(accountId)?.role || 'warmup') !== 'conversation') return;
  const myPhone = ctxOf(accountId)?.me?.phone || null; // tag chats by the linked number
  for (const msg of messages) {
    try {
      if (!msg.message) continue;
      const raw = msg.key.remoteJid || '';
      if (raw.endsWith('@newsletter') || raw === 'status@broadcast') continue;
      const isGroup = raw.endsWith('@g.us');
      const id = msg.key.id;
      if (!id) continue;
      // Reaction → attach to the message it targets (not a chat line of its own).
      if (await applyReaction(msg)) {
        emit('message:status', {});
        continue;
      }
      if (await applyPin(msg)) {
        emit('message:status', {});
        continue;
      }
      const body = textOf(msg).trim();

      // Group message: store for the thread (conversation numbers only), no lead automation.
      if (isGroup) {
        if ((ctxOf(accountId)?.role || 'warmup') !== 'conversation') continue;
        if (!body && !msg.key.fromMe) continue;
        const gc = await upsertPoolChat({ jid: raw, isGroup: true, name: ctxOf(accountId)?.groupSubjects?.get(raw) || '' });
        if (!gc || !body) continue;
        const r = await db.messages().updateOne(
          { wa_message_id: id },
          { $set: { account_phone: myPhone, chat_jid: msg.key?.remoteJid || null, ...mediaFieldsOf(msg), ...extrasOf(msg, myPhone, accountId) }, $setOnInsert: { contact_id: String(gc._id), campaign_id: null, account_id: accountId, direction: msg.key.fromMe ? 'out' : 'in', body, sender: msg.key.fromMe ? '' : msg.pushName || '', status: msg.key.fromMe ? 'sent' : 'read', wa_message_id: id, synced: 1, created_at: msgTime(msg), day_key: dayKey() } },
          { upsert: true }
        );
        if (r.upsertedCount) {
          await db.contacts().updateOne({ _id: gc._id }, { $set: msg.key.fromMe ? { last_outbound_at: nowIso() } : { last_inbound_at: nowIso() }, ...(msg.key.fromMe ? {} : { $inc: unreadInc(myPhone) }) });
          emit(msg.key.fromMe ? 'message:out' : 'message:in', { contactId: String(gc._id) });
        }
        continue;
      }

      if (!body) continue; // nothing to show (every path below needs text)

      // Who is this chat with? Live stanzas carry the @lid AND the real number
      // (Baileys 7: remoteJid + remoteJidAlt; 6.7: senderLid/senderPn); learn the pair so the
      // chat shows the real contact.
      let pnJid = pnOf(msg);
      const altLid = [msg.key.remoteJidAlt, msg.key.senderLid].find(isLid);
      const lidJid = isLid(raw) ? raw : !msg.key.fromMe && altLid ? altLid : null;
      if (!isPn(pnJid) && lidJid) {
        const info = (await lidLookup([lidJid])).get(lidJid);
        const learned = ctxOf(accountId)?.learnedPairs?.get(lidJid);
        if (isPn(info?.pn)) pnJid = info.pn;
        else if (isPn(learned)) pnJid = learned;
      }
      if (lidJid && isPn(pnJid) && !msg.key.fromMe) {
        // Remember the pair + merge any older @lid copy of this chat (don't block this message).
        queueIdentity(() => applyContactBatch([{ id: lidJid, jid: pnJid, notify: msg.pushName || '' }], myPhone));
      }
      const phone = isPn(pnJid) ? jidToPhone(pnJid) : null;
      if (!phone && !lidJid) continue;
      // Warm-up numbers: skip chatter between our own numbers. Conversation numbers: keep everything.
      const isConvAcct = (ctxOf(accountId)?.role || 'warmup') === 'conversation';
      if (!isConvAcct && phone && ourPhones().has(phone)) continue;

      const contact = await upsertPoolChat({ phone, lid: lidJid, pushName: msg.key.fromMe ? '' : msg.pushName || '', ownerPhone: myPhone });
      if (!contact || contact.warmup === 1) continue;

      if (msg.key.fromMe) {
        if (!body) continue;
        const r = await db.messages().updateOne(
          { wa_message_id: id },
          { $set: { account_phone: myPhone, chat_jid: msg.key?.remoteJid || null, ...mediaFieldsOf(msg), ...extrasOf(msg, myPhone, accountId) }, $setOnInsert: { contact_id: String(contact._id), campaign_id: null, account_id: accountId, direction: 'out', body, status: 'sent', wa_message_id: id, created_at: msgTime(msg), day_key: dayKey() } },
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
        { $set: { account_phone: myPhone, chat_jid: msg.key?.remoteJid || null, ...mediaFieldsOf(msg), ...extrasOf(msg, myPhone, accountId) }, $setOnInsert: { contact_id: String(contact._id), campaign_id: null, account_id: accountId, direction: 'in', body, status: 'read', wa_message_id: id, created_at: msgTime(msg), day_key: dayKey() } },
        { upsert: true }
      );
      if (!r.upsertedCount) continue; // already stored
      await db.contacts().updateOne({ _id: contact._id }, { $set: { last_inbound_at: nowIso() }, $inc: unreadInc(myPhone) });
      if (type !== 'notify') {
        // Caught-up offline message: show it, but don't fire auto-replies/handoffs for backlog.
        emit('message:in', { contactId: String(contact._id) });
        continue;
      }

      const stop = getSetting('stopKeywords', []);
      const lc = body.toLowerCase();
      // this number's own AI toggle (a suspended workspace sends nothing automatically)
      const acctAutoReply = !!ctxOf(accountId)?.autoReply && !isWsSuspended(currentWs() || DEFAULT_WS);
      if (stop.some((w) => lc === w || lc.startsWith(w))) {
        await db.contacts().updateOne({ _id: contact._id }, { $set: { status: 'opted_out', handoff: 0, handoff_reason: '', handoffs: {} } });
        audit('reply', `${contact.name || (phone ? '+' + phone : 'A contact')} opted out ("${body}")`, { level: 'warn', meta: { contactId: String(contact._id) } });
      } else if (acctAutoReply && aiAvailable()) {
        await db.targets().updateMany({ contact_id: String(contact._id), status: 'queued' }, { $set: { status: 'replied' } });
        scheduleAutoReply(accountId, contact); // one reply after the burst, not one per message
      } else if (getSetting('handoffOnReply', true)) {
        await setHandoff(contact._id, myPhone, 'reply'); // on the number they wrote to
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
// bulkWrite in chunks with one retry per chunk. Returns how many upserts were saved and the
// last error (if any chunk still failed) — never silently drops a whole batch.
async function writeChunked(collection, ops, ordered, size = 500) {
  let saved = 0;
  let error = null;
  for (let i = 0; i < ops.length; i += size) {
    const chunk = ops.slice(i, i + size);
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        saved += (await collection.bulkWrite(chunk, { ordered })).upsertedCount || 0;
        break;
      } catch (err) {
        if (attempt === 2) {
          saved += err?.result?.upsertedCount || 0;
          error = err;
        } else await new Promise((r) => setTimeout(r, 800));
      }
    }
  }
  return { saved, error };
}

async function ingestPoolHistory(accountId, { messages, chats }) {
  if (!messages?.length) return;
  // Note: the batch's contacts were already applied (names + lid pairs) by the caller.

  // Real shape (diag-3): chats/contacts arrive as bare { id } — no names, and @lid chats
  // carry no phone number. So names/numbers come from lid_map (filled by the app-state
  // contact sync + live traffic) and group names from the group-metadata fetch.
  // The linked number's own phone — tags every message (so a chat stays attached to its tab
  // even if the number is re-added) and picks the saved names from THIS phone's address book.
  const myPhone = ctxOf(accountId)?.me?.phone || null;
  const lids = messages.map((m) => m.key?.remoteJid).filter(isLid);
  const lidInfo = await lidLookup(lids);
  // Pairs learned this session (backup in case the lid_map write didn't persist).
  const learned = ctxOf(accountId)?.learnedPairs;
  if (learned) for (const lid of lids) if (!isPn(lidInfo.get(lid)?.pn) && learned.has(lid)) lidInfo.set(lid, { ...(lidInfo.get(lid) || {}), pn: learned.get(lid) });
  const groupSubjects = ctxOf(accountId)?.groupSubjects || new Map();
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
      byChat.set(key, { msgs: [], isGroup: false, phone, lid, savedName: info?.names?.[myPhone] || chatName.get(raw) || '', pushName: info?.notify || '' });
    }
    const e = byChat.get(key);
    e.msgs.push(msg);
    if (!e.lid && lid) e.lid = lid;
    if (!e.isGroup && !e.pushName && msg.pushName && !msg.key?.fromMe) e.pushName = msg.pushName;
  }


  // 1) Every chat's contact: one lookup for the whole batch, decided in memory, one write.
  const chatsList = [...byChat];
  const idx = await loadContactIndex({
    jids: chatsList.filter(([, e]) => e.isGroup).map(([k]) => k),
    phones: chatsList.flatMap(([, e]) => (e.isGroup ? [] : [e.phone, e.lid && jidToPhone(e.lid)])),
    lids: chatsList.map(([, e]) => e.lid),
  });
  const w = contactWriter();
  const planned = chatsList.map(([chatJid, e]) => ({
    e,
    contact: e.isGroup
      ? planChat(idx, w, { jid: chatJid, isGroup: true, name: e.name })
      : planChat(idx, w, { phone: e.phone, lid: e.lid, savedName: e.savedName, pushName: e.pushName, ownerPhone: myPhone }),
  }));
  const remap = await w.flush();

  // 2) All messages of the batch in one write (dedupe by WhatsApp id → safe to repeat).
  const ops = [];
  const reactions = [];
  for (const { e, contact } of planned) {
    if (!contact || contact.warmup === 1) continue;
    const contactId = String(remap.get(String(contact._id)) || contact._id);
    for (const msg of e.msgs) {
      const id = msg.key?.id;
      if (!id) continue;
      const r = normalizeMessageContent(msg.message)?.reactionMessage;
      if (r?.key?.id) {
        reactions.push({ target: r.key.id, emoji: r.text || '', from: msg.key.fromMe ? 'me' : msg.key.participant || msg.key.remoteJid || '' });
        continue;
      }
      const body = textOf(msg).trim();
      if (!body) continue;
      const tsNum = Number(msg.messageTimestamp) || 0;
      const ts = tsNum ? new Date(tsNum * 1000).toISOString() : nowIso();
      const dir = msg.key.fromMe ? 'out' : 'in';
      const sender = e.isGroup && !msg.key.fromMe ? msg.pushName || '' : '';
      ops.push({
        updateOne: {
          filter: { wa_message_id: id },
          update: {
            $set: { account_phone: myPhone, chat_jid: msg.key?.remoteJid || null, ...mediaFieldsOf(msg), ...extrasOf(msg, myPhone, accountId) },
            $setOnInsert: { contact_id: contactId, campaign_id: null, account_id: accountId, direction: dir, body, sender, status: dir === 'out' ? 'sent' : 'read', wa_message_id: id, synced: 1, created_at: ts, day_key: ts.slice(0, 10) },
          },
          upsert: true,
        },
      });
    }
  }
  // Write in chunks (a 4,550-message batch once saved nothing, silently), retrying a failed
  // chunk once — safe because every op is an upsert keyed by the WhatsApp message id.
  const { saved: imported, error: writeErr } = await writeChunked(db.messages(), ops, false);
  if (writeErr) {
    audit('connection', `Saving history messages failed for ${ops.length - imported} of ${ops.length}: ${writeErr.message}${writeErr.code ? ` (code ${writeErr.code})` : ''}`, { level: 'error' });
  }
  // 3) Reactions, in order, after their target messages exist (one write).
  if (reactions.length) {
    const rops = [];
    for (const r of reactions) {
      rops.push({ updateOne: { filter: { wa_message_id: r.target }, update: { $pull: { reactions: { from: r.from } } } } });
      if (r.emoji) rops.push({ updateOne: { filter: { wa_message_id: r.target }, update: { $push: { reactions: { emoji: r.emoji, from: r.from } } } } });
    }
    const { error: rErr } = await writeChunked(db.messages(), rops, true);
    if (rErr) audit('connection', `Saving reactions failed: ${rErr.message}`, { level: 'warn' });
  }
  if (imported) {
    audit('connection', `Synced ${imported} messages for a conversation number`, { level: 'success' });
    emit('message:in', {});
    emit('stats:dirty', {});
  }
}

// Reconnect every saved account on boot (after Mongo is up), each in its own workspace.
export async function reconnectPoolAccounts() {
  await runInWs(DEFAULT_WS, () => migrateContactNames()).catch((e) => audit('system', `Contact-name cleanup failed: ${e.message}`, { level: 'error', ws: DEFAULT_WS }));
  try {
    const docs = await col('warmup_accounts').find().toArray();
    for (const d of docs) {
      if (d.kind === 'cloud') registerCloudAccount(d);
      else startPoolAccount(String(d._id), d.label || '', d.role || 'warmup', !!d.auto_reply, d.ws || DEFAULT_WS);
    }
  } catch {
    /* mongo not ready yet; caller retries */
  }
}

// Internals exposed for the local test harness only (no runtime effect).
export const __test = {
  accounts, applyContactBatch, upsertPoolChat, ingestPoolHistory, ingestPool, applyGroupSubjects, mappingsFromHistory, onHistoryNotification, textOf, pnOf,
  settle: async () => { await histChain; await identityChain; }, // wait for queued history/identity work
};
