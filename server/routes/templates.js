import { Router } from 'express';
import { db, audit, oid, pub, pubList, nowIso } from '../db/mongo.js';
import { renderTemplate } from '../utils.js';

export const templates = Router();

templates.get('/', async (_req, res) => {
  const list = await db.templates().find().sort({ _id: -1 }).toArray();
  res.json(pubList(list));
});

templates.post('/', async (req, res) => {
  const { name, body = '', category = 'general', blocks = null, media_url = null } = req.body;
  if (!name || (!body && !media_url))
    return res.status(400).json({ error: 'Add a message or an image' });
  const doc = { name, body, category, blocks, media_url, created_at: nowIso() };
  const r = await db.templates().insertOne(doc);
  audit('system', `Template created: ${name}`);
  res.json(pub({ _id: r.insertedId, ...doc }));
});

templates.put('/:id', async (req, res) => {
  const _id = oid(req.params.id);
  if (!_id) return res.status(400).json({ error: 'Bad id' });
  const { name, body, category, blocks, media_url } = req.body;
  const set = {};
  if (name !== undefined) set.name = name;
  if (body !== undefined) set.body = body;
  if (category !== undefined) set.category = category;
  if (blocks !== undefined) set.blocks = blocks;
  if (media_url !== undefined) set.media_url = media_url;
  const r = await db.templates().findOneAndUpdate({ _id }, { $set: set }, { returnDocument: 'after' });
  const doc = r.value || r;
  if (!doc) return res.status(404).json({ error: 'Not found' });
  res.json(pub(doc));
});

templates.delete('/:id', async (req, res) => {
  const _id = oid(req.params.id);
  if (!_id) return res.status(400).json({ error: 'Bad id' });
  await db.templates().deleteOne({ _id });
  res.json({ ok: true });
});

templates.post('/preview', (req, res) => {
  const { body = '' } = req.body;
  const sample = { name: 'Ayesha Khan', phone: '923001234567' };
  res.json({
    samples: [
      renderTemplate(body, sample),
      renderTemplate(body, sample),
      renderTemplate(body, sample),
    ],
  });
});
