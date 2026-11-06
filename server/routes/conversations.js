import { Router } from 'express';
import { db, audit, oid, pub, pubList, nowIso, dayKey } from '../db/mongo.js';
import { emit } from '../events.js';
import { sendText, isConnected } from '../whatsapp/client.js';

export const conversations = Router();

// Thread list: one row per contact that has messages, newest activity first.
conversations.get('/', async (req, res) => {
  const { filter = '' } = req.query;
  const summaries = await db
    .messages()
    .aggregate([
      { $sort: { _id: 1 } },
      {
        $group: {
          _id: '$contact_id',
          last_message: { $last: '$body' },
          last_direction: { $last: '$direction' },
          last_at: { $last: '$created_at' },
        },
      },
    ])
    .toArray();
  const map = new Map(summaries.map((s) => [s._id, s]));

  const contactFilter = filter === 'handoff' ? { handoff: 1 } : {};
  const contactsList = await db.contacts().find(contactFilter).toArray();

  const rows = [];
  for (const c of contactsList) {
    const s = map.get(String(c._id));
    if (!s) continue;
    rows.push({
      id: String(c._id),
      name: c.name,
      phone: c.phone,
      status: c.status,
      handoff: c.handoff,
      handoff_reason: c.handoff_reason,
      last_inbound_at: c.last_inbound_at,
      last_outbound_at: c.last_outbound_at,
      last_message: s.last_message,
      last_direction: s.last_direction,
      last_at: s.last_at,
    });
  }
  rows.sort((a, b) => String(b.last_at || '').localeCompare(String(a.last_at || '')));
  res.json(rows.slice(0, 300));
});

conversations.get('/:contactId', async (req, res) => {
  const _id = oid(req.params.contactId);
  if (!_id) return res.status(400).json({ error: 'Bad id' });
  const contact = await db.contacts().findOne({ _id });
  if (!contact) return res.status(404).json({ error: 'Not found' });
  const messages = await db
    .messages()
    .find({ contact_id: String(_id) })
    .sort({ _id: 1 })
    .limit(500)
    .toArray();
  res.json({ contact: pub(contact), messages: pubList(messages) });
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
    const waId = await sendText(contact.phone, body.trim());
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
