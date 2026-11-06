import { Router } from 'express';
import { db, audit, oid, pub, pubList, nowIso } from '../db/mongo.js';
import { normalizePhone } from '../utils.js';

export const contacts = Router();

function esc(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

contacts.get('/', async (req, res) => {
  try {
    const { q = '', status = '', tag = '' } = req.query;
    const filter = { warmup: { $ne: 1 } }; // warm-up contacts live in the Warmup page
    if (q) {
      const rx = new RegExp(esc(q), 'i');
      filter.$or = [{ name: rx }, { phone: rx }];
    }
    if (status) filter.status = status;
    if (tag) filter.tags = new RegExp(esc(tag), 'i');
    const list = await db.contacts().find(filter).sort({ _id: -1 }).limit(1000).toArray();
    res.json(pubList(list));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

contacts.post('/', async (req, res) => {
  const { name = '', phone, tags = '', notes = '' } = req.body;
  const p = normalizePhone(phone);
  if (!p) return res.status(400).json({ error: 'Valid phone number required' });
  try {
    const doc = {
      name,
      phone: p,
      tags,
      notes,
      status: 'active',
      handoff: 0,
      handoff_reason: '',
      last_inbound_at: null,
      last_outbound_at: null,
      created_at: nowIso(),
    };
    const r = await db.contacts().insertOne(doc);
    audit('system', `Contact added: ${name || p}`);
    res.json(pub({ _id: r.insertedId, ...doc }));
  } catch (e) {
    if (e.code === 11000)
      return res.status(409).json({ error: 'That phone number already exists' });
    res.status(500).json({ error: e.message });
  }
});

contacts.put('/:id', async (req, res) => {
  const _id = oid(req.params.id);
  if (!_id) return res.status(400).json({ error: 'Bad id' });
  const { name, tags, notes, status } = req.body;
  const set = {};
  if (name !== undefined) set.name = name;
  if (tags !== undefined) set.tags = tags;
  if (notes !== undefined) set.notes = notes;
  if (status !== undefined) set.status = status;
  const r = await db.contacts().findOneAndUpdate(
    { _id },
    { $set: set },
    { returnDocument: 'after' }
  );
  const doc = r.value || r; // driver version differences
  if (!doc) return res.status(404).json({ error: 'Not found' });
  res.json(pub(doc));
});

contacts.delete('/:id', async (req, res) => {
  const _id = oid(req.params.id);
  if (!_id) return res.status(400).json({ error: 'Bad id' });
  const idStr = String(_id);
  await db.contacts().deleteOne({ _id });
  await db.messages().deleteMany({ contact_id: idStr });
  await db.targets().deleteMany({ contact_id: idStr });
  res.json({ ok: true });
});

// Bulk import: { rows:[{name,phone,tags}] } or { text:"csv/lines", tags }.
contacts.post('/import', async (req, res) => {
  let { rows, text = '', tags = '' } = req.body;
  if (!rows && text) rows = parseText(text, tags);
  if (!Array.isArray(rows)) return res.status(400).json({ error: 'No rows to import' });

  const ops = [];
  let skipped = 0;
  for (const r of rows) {
    const p = normalizePhone(r.phone);
    if (!p) {
      skipped++;
      continue;
    }
    const name = r.name || '';
    const t = (r.tags || tags || '').trim();
    ops.push({
      updateOne: {
        filter: { phone: p },
        update: {
          $setOnInsert: {
            phone: p,
            status: 'active',
            handoff: 0,
            handoff_reason: '',
            last_inbound_at: null,
            last_outbound_at: null,
            created_at: nowIso(),
          },
          ...(name || t
            ? { $set: { ...(name ? { name } : {}), ...(t ? { tags: t } : {}) } }
            : {}),
        },
        upsert: true,
      },
    });
  }

  let added = 0;
  if (ops.length) {
    const r = await db.contacts().bulkWrite(ops, { ordered: false });
    added = (r.upsertedCount || 0) + (r.modifiedCount || 0);
  }
  audit('system', `Imported ${ops.length} contacts (${skipped} skipped)`, {
    level: 'success',
  });
  res.json({ added, skipped });
});

function parseText(text, tags) {
  const out = [];
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  for (const line of lines) {
    const parts = line.split(/[,;\t]/).map((s) => s.trim());
    if (parts.length === 1) {
      out.push({ name: '', phone: parts[0], tags });
    } else {
      const digitsA = (parts[0].match(/\d/g) || []).length;
      const digitsB = (parts[1].match(/\d/g) || []).length;
      if (digitsB >= digitsA) out.push({ name: parts[0], phone: parts[1], tags });
      else out.push({ name: parts[1], phone: parts[0], tags });
    }
  }
  return out;
}

contacts.get('/tags/all', async (_req, res) => {
  const list = await db.contacts().find({ tags: { $nin: ['', null] } }, { projection: { tags: 1 } }).toArray();
  const set = new Set();
  for (const r of list)
    (r.tags || '').split(',').forEach((t) => {
      const v = t.trim();
      if (v) set.add(v);
    });
  res.json([...set].sort());
});
