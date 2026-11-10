import { Router } from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from '../config.js';
import { db, audit, oid, pub, pubList, nowIso, dayKey, getSetting, setSetting } from '../db/mongo.js';
import { emit } from '../events.js';
import { sendText, sendToJid, isConnected, getWaState } from '../whatsapp/client.js';
import { poolState, sendJidFrom, chatJidOf, isAccountConnected, startPoolAccount, removePoolAccount, setPoolLabel, setPoolAutoReply, downloadStoredMedia } from '../whatsapp/pool.js';

const MEDIA_DIR = path.join(DATA_DIR, 'media_cache');
const mediaInflight = new Map(); // one download per file even if the page asks twice

export const conversations = Router();

// All stored account_ids that belong to the same physical phone as this tab
// (the same WhatsApp number can be linked more than once — main + warm-up, etc.).
function accountGroup(account) {
  const wa = getWaState();
  const pool = poolState().filter((a) => a.me?.phone);
  const phoneById = new Map(pool.map((a) => [a.id, a.me.phone]));
  const phone = account === 'main' ? wa.me?.phone || null : phoneById.get(account) || null;

  const ids = new Set([account]);
  let includeLegacy = account === 'main';
  if (phone) {
    if (wa.me?.phone === phone) { ids.add('main'); includeLegacy = true; }
    for (const a of pool) if (a.me.phone === phone) ids.add(a.id);
  }
  return { ids: [...ids], includeLegacy, phone };
}

// Match messages belonging to one account tab ('main' also matches legacy untagged rows).
// Primary match is by the linked phone number (account_phone) so a tab keeps its chats
// even after the number is removed and re-added (which assigns a new account_id).
function accountMatch(account) {
  const { ids, includeLegacy, phone } = accountGroup(account);
  const or = [{ account_id: { $in: ids } }];
  if (phone) or.push({ account_phone: phone });
  if (includeLegacy) or.push({ account_id: null }, { account_id: { $exists: false } });
  return { $or: or };
}

// The WhatsApp numbers that own conversation tabs — one tab per unique phone.
// Built from saved accounts so a tab shows immediately (as "connecting") after a
// restart, instead of popping in only once its session finishes reconnecting.
conversations.get('/accounts', async (req, res) => {
  const wa = getWaState();
  const live = new Map(poolState().map((a) => [a.id, a]));
  let docs = [];
  try {
    docs = await db.warmupAccounts().find().toArray();
  } catch {}

  const raw = [
    {
      id: 'main',
      label: getSetting('mainConvLabel', '') || 'Main number',
      phone: wa.me?.phone || null,
      connected: wa.status === 'connected',
      role: 'main',
      auto_reply: !!getSetting('autoReplyEnabled', false),
      syncing: !!wa.syncing,
    },
  ];
  for (const d of docs) {
    const id = String(d._id);
    const a = live.get(id);
    const role = a?.role || d.role || 'warmup';
    if (role === 'warmup') continue; // warm-up numbers live only in the Warmup page
    const phone = a?.me?.phone || d.phone || null;
    if (!phone) continue; // not linked yet (awaiting first QR scan)
    raw.push({
      id,
      label: a?.label ?? d.label ?? '',
      phone,
      connected: a?.status === 'connected',
      role,
      auto_reply: a ? !!a.auto_reply : !!d.auto_reply,
      syncing: !!a?.syncing,
    });
  }

  // Collapse duplicate links of the same number into one tab (prefer main, then a connected/named one).
  const byPhone = new Map();
  for (const acc of raw) {
    const key = acc.phone || acc.id;
    const cur = byPhone.get(key);
    if (!cur) { byPhone.set(key, acc); continue; }
    const merged = {
      auto_reply: cur.auto_reply || acc.auto_reply,
      syncing: cur.syncing || acc.syncing,
      connected: cur.connected || acc.connected,
    };
    let rep = cur;
    if (acc.id === 'main') rep = acc;
    else if (!cur.connected && acc.connected) rep = acc;
    else if (!cur.label && acc.label) rep = { ...cur, label: acc.label };
    byPhone.set(key, { ...rep, ...merged });
  }
  res.json([...byPhone.values()]);
});

// Turn AI auto-reply on/off for a number (applies to every link of that phone).
conversations.post('/accounts/:id/autoreply', async (req, res) => {
  const enabled = !!req.body?.enabled;
  const { ids } = accountGroup(req.params.id);
  for (const id of ids) {
    if (id === 'main') {
      await setSetting('autoReplyEnabled', enabled);
    } else {
      const _id = oid(id);
      if (_id) {
        await db.warmupAccounts().updateOne({ _id }, { $set: { auto_reply: enabled } });
        setPoolAutoReply(id, enabled);
      }
    }
  }
  res.json({ ok: true, enabled });
});

// Add a conversation-only number (not used for warm-up or campaigns). Scan its QR.
conversations.post('/accounts', async (req, res) => {
  const label = (req.body?.label || '').trim();
  const r = await db.warmupAccounts().insertOne({
    label,
    role: 'conversation',
    phone: null,
    name: null,
    created_at: nowIso(),
  });
  const id = String(r.insertedId);
  startPoolAccount(id, label, 'conversation');
  audit('connection', 'Conversation number added — awaiting QR scan');
  res.json({ id, label });
});

// Poll a (connecting) conversation number's QR + status.
conversations.get('/accounts/:id/qr', (req, res) => {
  const a = poolState().find((x) => x.id === req.params.id);
  if (!a) return res.status(404).json({ error: 'Not found' });
  res.json({ status: a.status, qr: a.qr || null, me: a.me || null });
});

// Rename an account tab (works for the main number too).
conversations.put('/accounts/:id/label', async (req, res) => {
  const label = String(req.body?.label || '').trim();
  if (req.params.id === 'main') {
    await setSetting('mainConvLabel', label);
  } else {
    const _id = oid(req.params.id);
    if (!_id) return res.status(400).json({ error: 'Bad id' });
    await db.warmupAccounts().updateOne({ _id }, { $set: { label } });
    setPoolLabel(req.params.id, label);
  }
  res.json({ ok: true });
});

conversations.delete('/accounts/:id', async (req, res) => {
  if (req.params.id === 'main') return res.status(400).json({ error: "The main number can't be removed here" });
  const _id = oid(req.params.id);
  if (!_id) return res.status(400).json({ error: 'Bad id' });
  // Remove every saved link of this phone (duplicate links + warm-up copies), so the tab goes away.
  const doc = await db.warmupAccounts().findOne({ _id });
  const phone = doc?.phone || null;
  const docs = phone ? await db.warmupAccounts().find({ phone }).toArray() : doc ? [doc] : [];
  for (const d of docs) {
    const idStr = String(d._id);
    await removePoolAccount(idStr);
    await db.warmupAccounts().deleteOne({ _id: d._id });
  }
  audit('connection', `Number removed from Conversations${phone ? ` (+${phone})` : ''}`);
  res.json({ ok: true, removed: docs.length });
});

// Thread list: one row per contact that has messages, newest activity first.
conversations.get('/', async (req, res) => {
  const { filter = '', account = 'main' } = req.query;
  // One row per contact (for this account tab), ordered by most recent message.
  const summaries = await db
    .messages()
    .aggregate([
      { $match: accountMatch(account) },
      { $sort: { created_at: 1 } },
      {
        $group: {
          _id: '$contact_id',
          last_message: { $last: '$body' },
          last_direction: { $last: '$direction' },
          last_status: { $last: '$status' },
          last_sender: { $last: '$sender' },
          last_at: { $last: '$created_at' },
        },
      },
      { $sort: { last_at: -1 } },
      { $limit: 500 },
    ])
    .toArray();

  const ids = summaries.map((s) => oid(s._id)).filter(Boolean);
  const cfilter = { _id: { $in: ids } };
  if (filter === 'handoff') cfilter.handoff = 1;
  else if (filter === 'groups') cfilter.is_group = 1;
  else if (filter === 'unread') cfilter.unread = { $gt: 0 };
  const contactsList = await db.contacts().find(cfilter).toArray();
  const byId = new Map(contactsList.map((c) => [String(c._id), c]));

  const rows = [];
  for (const s of summaries) {
    const c = byId.get(s._id);
    if (!c) continue;
    rows.push({
      id: String(c._id),
      name: c.name,
      phone: c.phone,
      status: c.status,
      handoff: c.handoff,
      handoff_reason: c.handoff_reason,
      synced: c.synced ? 1 : 0,
      is_group: c.is_group ? 1 : 0,
      lid_only: c.lid_only ? 1 : 0, // WhatsApp hid this contact's number (@lid) — don't show the lid as a phone
      pinned: c.pinned ? 1 : 0,
      unread: c.unread || 0,
      last_inbound_at: c.last_inbound_at,
      last_outbound_at: c.last_outbound_at,
      last_message: s.last_message,
      last_direction: s.last_direction,
      last_status: s.last_status,
      last_sender: s.last_sender || '',
      last_at: s.last_at,
    });
    if (rows.length >= 300) break;
  }
  // Pinned chats float to the top (keeping recent-activity order within each group).
  rows.sort((a, b) => b.pinned - a.pinned);
  res.json(rows);
});

// Pin / unpin a chat (no limit on how many).
conversations.post('/:contactId/pin', async (req, res) => {
  const _id = oid(req.params.contactId);
  if (!_id) return res.status(400).json({ error: 'Bad id' });
  await db.contacts().updateOne({ _id }, { $set: { pinned: req.body?.pinned ? 1 : 0 } });
  res.json({ ok: true });
});

// A message's photo / voice note / video / sticker / document: fetched from WhatsApp and
// decrypted on first view, then served from a local cache. sendFile handles Range requests,
// so audio and video can seek.
conversations.get('/media/:messageId', async (req, res) => {
  const _id = oid(req.params.messageId);
  if (!_id) return res.status(400).json({ error: 'Bad id' });
  const doc = await db.messages().findOne({ _id }, { projection: { media_raw: 1, mime: 1, account_phone: 1, file_name: 1, type: 1 } });
  if (!doc?.media_raw) return res.status(404).json({ error: 'No media on this message' });
  const file = path.join(MEDIA_DIR, String(_id));
  try {
    if (!fs.existsSync(file)) {
      if (!mediaInflight.has(file)) {
        mediaInflight.set(
          file,
          (async () => {
            const buf = await downloadStoredMedia(doc);
            await fs.promises.mkdir(MEDIA_DIR, { recursive: true });
            await fs.promises.writeFile(file, buf);
          })().finally(() => mediaInflight.delete(file))
        );
      }
      await mediaInflight.get(file);
    }
    res.setHeader('Cache-Control', 'private, max-age=31536000, immutable');
    if (doc.type === 'document' && doc.file_name) {
      res.setHeader('Content-Disposition', `inline; filename*=UTF-8''${encodeURIComponent(doc.file_name)}`);
    }
    res.sendFile(file, { headers: { 'Content-Type': doc.mime || 'application/octet-stream' } });
  } catch (e) {
    res.status(404).json({ error: `This media is no longer available on WhatsApp (${e.message})` });
  }
});

// One chat's messages, newest page first (like WhatsApp): ?before=<created_at> loads the
// page of older messages before that point. Previously this returned the OLDEST 1000, so a
// busy chat never showed its latest messages.
conversations.get('/:contactId', async (req, res) => {
  const _id = oid(req.params.contactId);
  if (!_id) return res.status(400).json({ error: 'Bad id' });
  const contact = await db.contacts().findOne({ _id });
  if (!contact) return res.status(404).json({ error: 'Not found' });
  const account = req.query.account || 'main';
  const limit = Math.min(Math.max(Number(req.query.limit) || 150, 20), 500);
  const q = { contact_id: String(_id), ...accountMatch(account) };
  if (req.query.before) q.created_at = { $lt: String(req.query.before) };
  const page = await db
    .messages()
    .find(q, { projection: { media_raw: 0 } }) // download keys stay server-side
    .sort({ created_at: -1, _id: -1 })
    .limit(limit + 1)
    .toArray();
  const has_more = page.length > limit;
  const messages = page.slice(0, limit).reverse();
  // Opening a thread marks it read.
  if (contact.unread && !req.query.before) db.contacts().updateOne({ _id }, { $set: { unread: 0 } }).catch(() => {});
  res.json({ contact: pub({ ...contact, unread: 0 }), messages: pubList(messages), has_more });
});

conversations.post('/:contactId/reply', async (req, res) => {
  const _id = oid(req.params.contactId);
  if (!_id) return res.status(400).json({ error: 'Bad id' });
  const { body } = req.body;
  const account = req.body.account || 'main';
  const contact = await db.contacts().findOne({ _id });
  if (!contact) return res.status(404).json({ error: 'Not found' });
  if (!body?.trim()) return res.status(400).json({ error: 'Message is empty' });

  // Send from whichever linked session of this number is actually connected.
  const { ids } = accountGroup(account);
  const useMain = ids.includes('main') && isConnected();
  const poolId = ids.find((id) => id !== 'main' && isAccountConnected(id));
  if (!useMain && !poolId) return res.status(400).json({ error: 'That number is not connected' });

  try {
    // Groups go to the group jid, @lid-only contacts to their lid, everyone else to the number.
    const jid = chatJidOf(contact);
    let waId;
    if (useMain) {
      waId = contact.is_group || contact.lid_only ? await sendToJid(jid, body.trim()) : await sendText(contact.phone, body.trim());
    } else {
      waId = await sendJidFrom(poolId, jid, body.trim());
    }
    await db.messages().insertOne({
      contact_id: String(_id),
      campaign_id: null,
      account_id: account,
      direction: 'out',
      body: body.trim(),
      status: 'sent',
      wa_message_id: waId,
      created_at: nowIso(),
      day_key: dayKey(),
    });
    await db.contacts().updateOne({ _id }, { $set: { last_outbound_at: nowIso() } });
    audit('reply', `Human replied to ${contact.name || contact.phone}`);
    emit('message:out', { contactId: String(_id) });
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

conversations.post('/:contactId/resolve', async (req, res) => {
  const _id = oid(req.params.contactId);
  if (!_id) return res.status(400).json({ error: 'Bad id' });
  await db.contacts().updateOne({ _id }, { $set: { handoff: 0, handoff_reason: '' } });
  audit('handoff', `Handoff resolved for contact ${req.params.contactId}`, { level: 'success' });
  emit('stats:dirty', {});
  res.json({ ok: true });
});
