import { Router } from 'express';
import { db, audit, oid, pub, nowIso } from '../db/mongo.js';

export const lists = Router();

// All lists, each with a live member count (excludes warm-up / synced chats).
lists.get('/', async (_req, res) => {
  try {
    const all = await db.lists().find().sort({ name: 1 }).toArray();
    const counts = await db
      .contacts()
      .aggregate([
        { $match: { warmup: { $ne: 1 }, synced: { $ne: 1 }, list_ids: { $exists: true, $ne: [] } } },
        { $unwind: '$list_ids' },
        { $group: { _id: '$list_ids', c: { $sum: 1 } } },
      ])
      .toArray();
    const countMap = new Map(counts.map((r) => [String(r._id), r.c]));
    res.json(all.map((l) => ({ ...pub(l), count: countMap.get(String(l._id)) || 0 })));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

lists.post('/', async (req, res) => {
  const name = String(req.body.name || '').trim();
  if (!name) return res.status(400).json({ error: 'List name required' });
  try {
    const existing = await db.lists().findOne({ name: new RegExp(`^${esc(name)}$`, 'i') });
    if (existing) return res.json({ ...pub(existing), count: 0, existed: true });
    const doc = { name, created_at: nowIso() };
    const r = await db.lists().insertOne(doc);
    audit('system', `Contact list created: ${name}`);
    res.json({ ...pub({ _id: r.insertedId, ...doc }), count: 0 });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

lists.put('/:id', async (req, res) => {
  const _id = oid(req.params.id);
  if (!_id) return res.status(400).json({ error: 'Bad id' });
  const name = String(req.body.name || '').trim();
  if (!name) return res.status(400).json({ error: 'List name required' });
  const r = await db.lists().findOneAndUpdate({ _id }, { $set: { name } }, { returnDocument: 'after' });
  const doc = r.value || r;
  if (!doc) return res.status(404).json({ error: 'Not found' });
  res.json(pub(doc));
});

lists.delete('/:id', async (req, res) => {
  const _id = oid(req.params.id);
  if (!_id) return res.status(400).json({ error: 'Bad id' });
  await db.lists().deleteOne({ _id });
  // Remove the list from every contact that belonged to it (contacts themselves stay).
  await db.contacts().updateMany({ list_ids: String(_id) }, { $pull: { list_ids: String(_id) } });
  res.json({ ok: true });
});

// Add/remove a set of contacts to/from a list.
lists.post('/:id/members', async (req, res) => {
  const _id = oid(req.params.id);
  if (!_id) return res.status(400).json({ error: 'Bad id' });
  const list = await db.lists().findOne({ _id });
  if (!list) return res.status(404).json({ error: 'List not found' });
  const ids = (Array.isArray(req.body.contact_ids) ? req.body.contact_ids : [])
    .map(oid)
    .filter(Boolean);
  if (!ids.length) return res.status(400).json({ error: 'No contacts given' });
  const op = req.body.remove ? { $pull: { list_ids: String(_id) } } : { $addToSet: { list_ids: String(_id) } };
  const r = await db.contacts().updateMany({ _id: { $in: ids } }, op);
  res.json({ ok: true, modified: r.modifiedCount || 0 });
});

function esc(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
