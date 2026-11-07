import { Router } from 'express';
import { db, audit, oid, pub, pubList, nowIso, dayKey } from '../db/mongo.js';
import { emit } from '../events.js';
import { sendText, sendToJid, isConnected } from '../whatsapp/client.js';

export const conversations = Router();

// Thread list: one row per contact that has messages, newest activity first.
conversations.get('/', async (req, res) => {
  const { filter = '' } = req.query;
  // One row per contact, ordered by most recent message.
  const summaries = await db
    .messages()
    .aggregate([
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
  const messages = await db
    .messages()
    .find({ contact_id: String(_id) })
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
  const contact = await db.contacts().findOne({ _id });
  if (!contact) return res.status(404).json({ error: 'Not found' });
  if (!body?.trim()) return res.status(400).json({ error: 'Message is empty' });
  if (!isConnected()) return res.status(400).json({ error: 'WhatsApp is not connected' });

  try {
    const waId = contact.is_group
      ? await sendToJid(contact.jid || `${contact.phone}@g.us`, body.trim())
      : await sendText(contact.phone, body.trim());
    await db.messages().insertOne({
      contact_id: String(_id),
      campaign_id: null,
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
