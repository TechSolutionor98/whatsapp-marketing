import { Router } from 'express';
import { db, audit, oid, pub, pubList, nowIso, dayKey } from '../db/mongo.js';
import { emit } from '../events.js';
import { sendText, sendToJid, isConnected, getWaState } from '../whatsapp/client.js';
import { poolState, sendFromTo, isAccountConnected, startPoolAccount, removePoolAccount } from '../whatsapp/pool.js';

export const conversations = Router();

// Match messages belonging to one account tab. 'main' includes legacy (untagged) rows.
function accountMatch(account) {
  if (!account || account === 'main') {
    return { $or: [{ account_id: 'main' }, { account_id: null }, { account_id: { $exists: false } }] };
  }
  return { account_id: account };
}

// The connected WhatsApp numbers that can own conversation tabs
// (main + campaign/warm-up numbers + conversation-only numbers).
conversations.get('/accounts', (_req, res) => {
  const wa = getWaState();
  const accounts = [
    { id: 'main', label: 'Main number', phone: wa.me?.phone || null, connected: wa.status === 'connected' },
  ];
  for (const a of poolState()) {
    if (a.status === 'connected' && a.me?.phone) {
      accounts.push({ id: a.id, label: a.label || '', phone: a.me.phone, connected: true, role: a.role });
    }
  }
  res.json(accounts);
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

conversations.delete('/accounts/:id', async (req, res) => {
  await removePoolAccount(req.params.id);
  await db.warmupAccounts().deleteOne({ _id: oid(req.params.id) });
  audit('connection', 'Conversation number removed');
  res.json({ ok: true });
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
  res.json(rows);
});

conversations.get('/:contactId', async (req, res) => {
  const _id = oid(req.params.contactId);
  if (!_id) return res.status(400).json({ error: 'Bad id' });
  const contact = await db.contacts().findOne({ _id });
  if (!contact) return res.status(404).json({ error: 'Not found' });
  const account = req.query.account || 'main';
  const messages = await db
    .messages()
    .find({ contact_id: String(_id), ...accountMatch(account) })
    .sort({ created_at: 1, _id: 1 })
    .limit(1000)
    .toArray();
  // Opening a thread marks it read.
  if (contact.unread) db.contacts().updateOne({ _id }, { $set: { unread: 0 } }).catch(() => {});
  res.json({ contact: pub({ ...contact, unread: 0 }), messages: pubList(messages) });
});

conversations.post('/:contactId/reply', async (req, res) => {
  const _id = oid(req.params.contactId);
  if (!_id) return res.status(400).json({ error: 'Bad id' });
  const { body } = req.body;
  const account = req.body.account || 'main';
  const contact = await db.contacts().findOne({ _id });
  if (!contact) return res.status(404).json({ error: 'Not found' });
  if (!body?.trim()) return res.status(400).json({ error: 'Message is empty' });

  const viaMain = account === 'main';
  if (viaMain && !isConnected()) return res.status(400).json({ error: 'Main WhatsApp is not connected' });
  if (!viaMain && !isAccountConnected(account)) return res.status(400).json({ error: 'That number is not connected' });

  try {
    let waId;
    if (viaMain) {
      waId = contact.is_group
        ? await sendToJid(contact.jid || `${contact.phone}@g.us`, body.trim())
        : await sendText(contact.phone, body.trim());
    } else {
      waId = await sendFromTo(account, contact.phone, body.trim());
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
