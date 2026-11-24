import { Router } from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from '../config.js';
import { db, audit, oid, pub, pubList, nowIso, dayKey, getSetting, setSetting, clearHandoff, handoffFor } from '../db/mongo.js';
import { emit } from '../events.js';
import { sendText, sendToJid, isConnected } from '../whatsapp/client.js';
import { poolState, sendJidFrom, chatJidOf, isAccountConnected, startPoolAccount, removePoolAccount, setPoolLabel, setPoolAutoReply, downloadStoredMedia, canPostInGroup, phoneOfAccount, requestOlderMessages } from '../whatsapp/pool.js';
import { accountGroup, tabPhone, listNumbers, hasMain } from '../numbers.js';
import { canLinkNumber } from '../limits.js';
import { accountKind } from '../whatsapp/pool.js';
import { connectCloudNumber, updateCloudNumber, cloudDetails, templatesFor, downloadCloudStored, replyWindowOpen } from '../whatsapp/cloud.js';

const MEDIA_DIR = path.join(DATA_DIR, 'media_cache');
const mediaInflight = new Map(); // one download per file even if the page asks twice

export const conversations = Router();

// What to call a chat in a given number's tab, like WhatsApp: a group's subject; else the name
// saved in THIS number's address book; else a name given in this app (imports/edits). People
// not saved on this phone get no name here — the UI shows their number and "~push name".
function chatNameFor(c, tabPhone) {
  if (c.is_group) return c.name || '';
  return (tabPhone && c.saved_names?.[tabPhone]) || c.name || '';
}

// Messages belonging to one tab: everything tagged with its number (account_phone), plus
// older untagged rows from this number's own linked sessions. Untagged 'main' rows are NOT
// included — they came from whichever number was the main number before (WhatsApp Web
// only shows the current number's chats). No number → nothing.
async function accountMatch(account) {
  const phone = await tabPhone(account);
  if (!phone) return { _id: { $exists: false } };
  const poolIds = accountGroup(account).ids.filter((x) => x !== 'main');
  const or = [{ account_phone: phone }];
  if (poolIds.length) or.push({ account_id: { $in: poolIds }, account_phone: { $exists: false } });
  return { $or: or };
}

// The WhatsApp numbers that own conversation tabs — one tab per unique phone (numbers.js).
conversations.get('/accounts', async (_req, res) => {
  res.json(await listNumbers());
});

// Make a number the default one (Conversations opens on its tab).
conversations.put('/accounts/:id/default', async (req, res) => {
  const phone = await tabPhone(req.params.id);
  if (!phone) return res.status(400).json({ error: "This number isn't linked yet" });
  await setSetting('defaultConvPhone', phone);
  audit('connection', `Default number set to +${phone}`);
  emit('pool:update', poolState()); // open pages refresh their number list
  res.json({ ok: true, phone });
});

// Turn AI auto-reply on/off for a number (applies to every link of that phone).
conversations.post('/accounts/:id/autoreply', async (req, res) => {
  const enabled = !!req.body?.enabled;
  const { ids } = accountGroup(req.params.id);
  for (const id of ids) {
    if (id === 'main') {
      if (hasMain()) await setSetting('autoReplyEnabled', enabled);
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

// Which product catalog this number's AI answers from: a catalog id, 'none', or null (= the
// only catalog when there's exactly one). Applies to every link of that phone.
conversations.put('/accounts/:id/catalog', async (req, res) => {
  const v = req.body?.catalog_id;
  const value = v === 'none' ? 'none' : v ? String(v) : null;
  const { ids } = accountGroup(req.params.id);
  for (const id of ids) {
    if (id === 'main') {
      if (hasMain()) await setSetting('mainCatalogId', value);
    } else {
      const _id = oid(id);
      if (_id) await db.warmupAccounts().updateOne({ _id }, value === null ? { $unset: { catalog_id: '' } } : { $set: { catalog_id: value } });
    }
  }
  res.json({ ok: true, catalog_id: value });
});

// Add a conversation-only number (not used for warm-up or campaigns). Scan its QR.
conversations.post('/accounts', async (req, res) => {
  const full = await canLinkNumber(); // the super admin's limit on numbers per workspace
  if (full) return res.status(400).json({ error: full });
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

// Connect an official WhatsApp number (Meta WhatsApp Cloud API) with the business's own
// details. They're checked with Meta first; the token and app secret never come back.
conversations.post('/accounts/cloud', async (req, res) => {
  const full = await canLinkNumber();
  if (full) return res.status(400).json({ error: full });
  try {
    res.json(await connectCloudNumber(req.body || {}));
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// An official number's setup details (webhook verify token, status) for the Gateway page.
conversations.get('/accounts/:id/cloud', async (req, res) => {
  const d = await cloudDetails(req.params.id);
  if (!d) return res.status(404).json({ error: 'Not found' });
  res.json(d);
});

// New access token and/or app secret for an official number.
conversations.put('/accounts/:id/cloud', async (req, res) => {
  try {
    res.json(await updateCloudNumber(req.params.id, req.body || {}));
  } catch (e) {
    res.status(e.message === 'Not found' ? 404 : 400).json({ error: e.message });
  }
});

// An official number's approved message templates (what its campaigns can send).
conversations.get('/accounts/:id/templates', async (req, res) => {
  if (accountKind(req.params.id) !== 'cloud') return res.status(400).json({ error: 'Only official WhatsApp API numbers use approved templates' });
  try {
    res.json(await templatesFor(req.params.id));
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
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
    if (!hasMain()) return res.status(404).json({ error: 'Not found' });
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
  // It was the default → the main number is the default again (not this one if it's re-linked later).
  if (phone && getSetting('defaultConvPhone', null) === phone) await setSetting('defaultConvPhone', null);
  audit('connection', `Number unlinked${phone ? ` (+${phone})` : ''}`);
  res.json({ ok: true, removed: docs.length });
});

// Thread list: one row per contact that has messages, newest activity first.
conversations.get('/', async (req, res) => {
  const { filter = '', account = 'main' } = req.query;
  const withCounts = req.query.counts === '1'; // the chips' numbers: Unread 57, Groups 25, …
  // One row per contact (for this account tab), ordered by most recent message.
  const summaries = await db
    .messages()
    .aggregate([
      { $match: await accountMatch(account) },
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

  const phoneOfTab = await tabPhone(account);
  const ids = summaries.map((s) => oid(s._id)).filter(Boolean);
  // Every chat of this tab once (the counts need all of them); the filter is applied below.
  const contactsList = await db.contacts().find({ _id: { $in: ids } }).toArray();
  const byId = new Map(contactsList.map((c) => [String(c._id), c]));
  const counts = { all: 0, unread: 0, groups: 0, handoff: 0 };
  const passes = (c, handoff) =>
    filter === 'handoff' ? !!handoff : filter === 'groups' ? !!c.is_group : filter === 'unread' ? (c.unread || 0) > 0 : true;

  const rows = [];
  for (const s of summaries) {
    const c = byId.get(s._id);
    if (!c) continue;
    const handoff = handoffFor(c, phoneOfTab); // only when THIS number's chat needs a person
    counts.all++;
    if ((c.unread || 0) > 0) counts.unread++;
    if (c.is_group) counts.groups++;
    if (handoff) counts.handoff++;
    if (!passes(c, handoff) || rows.length >= 300) continue;
    rows.push({
      id: String(c._id),
      name: chatNameFor(c, phoneOfTab),
      push_name: c.is_group ? '' : c.push_name || '',
      phone: c.phone,
      status: c.status,
      handoff: handoff ? 1 : 0,
      handoff_reason: handoff,
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
  }
  // Pinned chats float to the top (keeping recent-activity order within each group).
  rows.sort((a, b) => b.pinned - a.pinned);
  res.json(withCounts ? { rows, counts } : rows);
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
  const doc = await db.messages().findOne({ _id }, { projection: { media_raw: 1, cloud_media_id: 1, account_id: 1, mime: 1, account_phone: 1, file_name: 1, type: 1, local_media: 1 } });
  // local_media: a file this app sent (Developer API receipts) — kept here, not on WhatsApp's servers.
  if (!doc?.media_raw && !doc?.cloud_media_id && !doc?.local_media) return res.status(404).json({ error: 'No media on this message' });
  const file = path.join(MEDIA_DIR, String(_id));
  try {
    if (!fs.existsSync(file)) {
      if (!doc.media_raw && !doc.cloud_media_id) throw new Error('the file was removed from this server');
      if (!mediaInflight.has(file)) {
        mediaInflight.set(
          file,
          (async () => {
            const buf = doc.cloud_media_id ? await downloadCloudStored(doc) : await downloadStoredMedia(doc);
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
  const q = { contact_id: String(_id), ...(await accountMatch(account)) };
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
  // Admins-only group (or a community itself) for THIS linked number → UI shows WhatsApp's
  // "Only admins can send messages" instead of the message box.
  const { phone } = accountGroup(account);
  const read_only = !!(contact.is_group && phone && (contact.read_only_for || []).includes(phone));
  // Names saved on OTHER linked phones (and old mixed-up names) stay server-side.
  const { read_only_for, saved_names, legacy_name, handoffs, ...shown } = contact;
  const tabPh = phone || (await tabPhone(account));
  const handoff = handoffFor(contact, tabPh);
  const named = { name: chatNameFor(contact, tabPh), push_name: contact.is_group ? '' : contact.push_name || '', handoff: handoff ? 1 : 0, handoff_reason: handoff };
  res.json({ contact: pub({ ...shown, ...named, unread: 0, read_only }), messages: pubList(messages), has_more });
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
  const useMain = hasMain() && ids.includes('main') && isConnected();
  const poolId = ids.find((id) => id !== 'main' && isAccountConnected(id));
  if (!useMain && !poolId) return res.status(400).json({ error: 'That number is not connected' });

  // Official API numbers: free text only within 24 hours of the person's last message (Meta's rule).
  if (!useMain && accountKind(poolId) === 'cloud' && !(await replyWindowOpen(_id, phoneOfAccount(poolId)))) {
    return res.status(400).json({
      error: "It's been more than 24 hours since this person last wrote to this number, so WhatsApp only allows an approved template now. Send one from a campaign, or wait for them to write again.",
      window_closed: true,
    });
  }

  // Like WhatsApp: no posting in admins-only groups / community announcements unless admin.
  if (contact.is_group) {
    const { phone } = accountGroup(account);
    const flagged = phone && (contact.read_only_for || []).includes(phone);
    const allowed = !flagged && (useMain || (await canPostInGroup(poolId, contact.jid)));
    if (!allowed) return res.status(403).json({ error: 'Only admins can send messages to this group' });
  }

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
      account_phone: phoneOfAccount(useMain ? 'main' : poolId), // keeps it in this number's tab
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

// "Load older messages from your phone" (like WhatsApp Web): ask this number's phone for
// messages before the oldest one we have in this chat. They arrive as an ON_DEMAND history
// batch and are stored by the normal import; the UI then loads them as an older page.
conversations.post('/:contactId/older', async (req, res) => {
  const _id = oid(req.params.contactId);
  if (!_id) return res.status(400).json({ error: 'Bad id' });
  const account = req.body?.account || 'main';
  const contact = await db.contacts().findOne({ _id });
  if (!contact) return res.status(404).json({ error: 'Not found' });
  const oldest = (
    await db
      .messages()
      .find({ contact_id: String(_id), wa_message_id: { $nin: [null, ''] }, ...(await accountMatch(account)) })
      .sort({ created_at: 1, _id: 1 })
      .limit(1)
      .toArray()
  )[0];
  if (!oldest) return res.status(400).json({ error: 'No messages in this chat to load before yet' });
  const { ids } = accountGroup(account);
  const useMain = hasMain() && ids.includes('main') && isConnected();
  const poolId = ids.find((id) => id !== 'main' && isAccountConnected(id));
  if (!useMain && !poolId) return res.status(400).json({ error: 'That number is not connected' });
  // The chat id exactly as WhatsApp knows it (stored per message since this update; older
  // rows fall back to the contact's @lid / number / group jid).
  const chatJid = oldest.chat_jid || (contact.is_group ? contact.jid : contact.lid || contact.jid || `${contact.phone}@s.whatsapp.net`);
  try {
    await requestOlderMessages(useMain ? 'main' : poolId, {
      chatJid,
      msgId: oldest.wa_message_id,
      fromMe: oldest.direction === 'out',
      tsMs: Date.parse(oldest.created_at),
      count: 50,
    });
    res.json({ ok: true, before: oldest.created_at });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

conversations.post('/:contactId/resolve', async (req, res) => {
  const _id = oid(req.params.contactId);
  if (!_id) return res.status(400).json({ error: 'Bad id' });
  // resolves it on the number whose tab you're in (an older flag with no number: everywhere)
  await clearHandoff(_id, await tabPhone(req.body?.account || req.query.account || 'main'));
  audit('handoff', `Handoff resolved for contact ${req.params.contactId}`, { level: 'success' });
  emit('stats:dirty', {});
  res.json({ ok: true });
});
