import { Router } from 'express';
import { ObjectId } from 'mongodb';
import { db, audit, nowIso, setSetting, getSetting } from '../db/mongo.js';
import { syncCatalog, findProducts, manualProduct } from '../catalog.js';

// Product catalogs for AI replies: API catalogs (a product URL, synced) and manual catalogs
// (products typed in Settings). Each WhatsApp number picks one in Conversations → AI settings.
export const catalogs = Router();
const idOf = (v) => {
  try {
    return new ObjectId(String(v));
  } catch {
    return null;
  }
};
const pub = (c, count) => ({ id: String(c._id), name: c.name, type: c.type, url: c.url || '', header: c.header || '', currency: c.currency || '', status: c.status || {}, count });

catalogs.get('/', async (_req, res) => {
  const list = await db.catalogs().find().sort({ created_at: 1 }).toArray();
  const counts = new Map((await db.products().aggregate([{ $group: { _id: '$catalog_id', n: { $sum: 1 } } }]).toArray()).map((r) => [r._id, r.n]));
  res.json(list.map((c) => pub(c, counts.get(String(c._id)) || 0)));
});

catalogs.post('/', async (req, res) => {
  const b = req.body || {};
  const type = b.type === 'api' ? 'api' : 'manual';
  const name = String(b.name || '').trim() || (type === 'api' ? 'Store catalog' : 'My products');
  if (type === 'api' && !/^https?:\/\//.test(String(b.url || '').trim())) return res.status(400).json({ error: 'Paste the product API URL (starting with https://)' });
  const doc = { name, type, url: type === 'api' ? String(b.url).trim() : '', header: String(b.header || '').trim(), currency: String(b.currency || '').trim().toUpperCase(), status: {}, created_at: nowIso() };
  const r = await db.catalogs().insertOne(doc);
  audit('system', `Product catalog "${name}" added (${type})`);
  let sync = null;
  if (type === 'api') sync = await syncCatalog(r.insertedId, 'added');
  res.json({ id: String(r.insertedId), sync });
});

catalogs.put('/:id', async (req, res) => {
  const _id = idOf(req.params.id);
  const cat = _id && (await db.catalogs().findOne({ _id }));
  if (!cat) return res.status(404).json({ error: 'Not found' });
  const b = req.body || {};
  const set = {};
  if (b.name !== undefined) set.name = String(b.name).trim() || cat.name;
  if (b.currency !== undefined) set.currency = String(b.currency).trim().toUpperCase();
  if (cat.type === 'api') {
    if (b.url !== undefined) set.url = String(b.url).trim();
    if (b.header !== undefined) set.header = String(b.header).trim();
  }
  await db.catalogs().updateOne({ _id }, { $set: set });
  const sync = cat.type === 'api' && (set.url !== undefined || set.header !== undefined) ? await syncCatalog(_id, 'updated') : null;
  res.json({ ok: true, sync });
});

catalogs.delete('/:id', async (req, res) => {
  const _id = idOf(req.params.id);
  if (!_id) return res.status(400).json({ error: 'Bad id' });
  const id = String(_id);
  await db.products().deleteMany({ catalog_id: id });
  await db.catalogs().deleteOne({ _id });
  // numbers that used it go back to "not chosen"
  await db.warmupAccounts().updateMany({ catalog_id: id }, { $unset: { catalog_id: '' } });
  if (getSetting('mainCatalogId', null) === id) await setSetting('mainCatalogId', null);
  res.json({ ok: true });
});

catalogs.post('/:id/sync', async (req, res) => {
  const r = await syncCatalog(req.params.id, 'manual');
  if (r.error) return res.status(400).json({ error: r.error });
  res.json(r);
});

// Products in a catalog (search + paging) — manual catalogs are edited here.
catalogs.get('/:id/products', async (req, res) => {
  const q = String(req.query.q || '').trim();
  const filter = { catalog_id: String(req.params.id) };
  if (q) filter.$or = [{ name: new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i') }, { sku: q }, { brand: new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i') }];
  const list = await db.products().find(filter).sort({ name: 1 }).limit(Math.min(Number(req.query.limit) || 200, 500)).toArray();
  res.json(list.map(({ _id, ...p }) => ({ id: String(_id), ...p })));
});

catalogs.post('/:id/products', async (req, res) => {
  const cat = await db.catalogs().findOne({ _id: idOf(req.params.id) });
  if (!cat) return res.status(404).json({ error: 'Not found' });
  if (cat.type !== 'manual') return res.status(400).json({ error: "This catalog syncs from an API — add products there" });
  try {
    const p = manualProduct(req.body);
    const ext_id = String(new ObjectId());
    await db.products().insertOne({ ...p, catalog_id: String(cat._id), ext_id, created_at: nowIso() });
    res.json({ ok: true });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

catalogs.put('/:id/products/:pid', async (req, res) => {
  const cat = await db.catalogs().findOne({ _id: idOf(req.params.id) });
  if (!cat || cat.type !== 'manual') return res.status(400).json({ error: 'Only manual catalogs can be edited here' });
  try {
    const r = await db.products().updateOne({ _id: idOf(req.params.pid), catalog_id: String(cat._id) }, { $set: manualProduct(req.body) });
    if (!r.matchedCount) return res.status(404).json({ error: 'Product not found' });
    res.json({ ok: true });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

catalogs.delete('/:id/products/:pid', async (req, res) => {
  const cat = await db.catalogs().findOne({ _id: idOf(req.params.id) });
  if (!cat || cat.type !== 'manual') return res.status(400).json({ error: 'Only manual catalogs can be edited here' });
  await db.products().deleteOne({ _id: idOf(req.params.pid), catalog_id: String(cat._id) });
  res.json({ ok: true });
});

// Try what the AI would find for a message in a catalog.
catalogs.get('/:id/search', async (req, res) => {
  res.json(await findProducts(String(req.query.q || ''), 5, [String(req.params.id)]));
});
