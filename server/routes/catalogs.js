import { Router } from 'express';
import { ObjectId } from 'mongodb';
import { db, audit, nowIso, setSetting, getSetting } from '../db/mongo.js';
import { syncCatalog, searchCatalog, productContext, manualProduct } from '../catalog.js';

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
const pub = (c, count, noLink = 0) => ({ id: String(c._id), name: c.name, type: c.type, url: c.url || '', header: c.header || '', link: c.link || '', currency: c.currency || '', status: c.status || {}, live: c.live || null, count, no_link: noLink });

// Product page link for an API that sends no links: a pattern (https://shop.com/product/{slug}),
// or the link of any one product page — we find which product it is and turn it into the pattern.
async function linkPattern(input, catalogId) {
  const v = String(input || '').trim();
  if (!v) return '';
  let u;
  try {
    u = new URL(v);
  } catch {
    throw new Error('Product page link must be a web address (https://…)');
  }
  if (/\{(slug|id|sku|handle)\}/.test(v)) return v;
  const segs = u.pathname.split('/').filter(Boolean).map((x) => decodeURIComponent(x));
  for (let i = segs.length - 1; i >= 0; i--) {
    const seg = segs[i];
    const p = await db.products().findOne({ catalog_id: String(catalogId), $or: [{ slug: seg }, { ext_id: seg }, { sku: seg }] }, { projection: { slug: 1, ext_id: 1, sku: 1 } });
    if (!p) continue;
    const key = p.slug === seg ? 'slug' : p.ext_id === seg ? 'id' : 'sku';
    segs[i] = `{${key}}`;
    return `${u.origin}/${segs.join('/')}`;
  }
  throw new Error("Couldn't match that link to one of the synced products — open any product on your site and paste its link (or a pattern like https://your-shop.com/product/{slug})");
}

catalogs.get('/', async (_req, res) => {
  const list = await db.catalogs().find().sort({ created_at: 1 }).toArray();
  const rows = await db
    .products()
    .aggregate([{ $group: { _id: '$catalog_id', n: { $sum: 1 }, noLink: { $sum: { $cond: [{ $in: [{ $ifNull: ['$url', ''] }, ['']] }, 1, 0] } } } }])
    .toArray();
  const counts = new Map(rows.map((r) => [r._id, r]));
  res.json(list.map((c) => pub(c, counts.get(String(c._id))?.n || 0, counts.get(String(c._id))?.noLink || 0)));
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
  let linkError = null;
  if (type === 'api') {
    sync = await syncCatalog(r.insertedId, 'added');
    // a product page link can only be matched once the products are in
    if (String(b.link || '').trim() && !sync.error) {
      try {
        await db.catalogs().updateOne({ _id: r.insertedId }, { $set: { link: await linkPattern(b.link, r.insertedId) } });
        sync = await syncCatalog(r.insertedId, 'added');
      } catch (e) {
        linkError = e.message;
      }
    }
  }
  res.json({ id: String(r.insertedId), sync, linkError });
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
    if (b.url !== undefined && String(b.url).trim() !== (cat.url || '')) set.url = String(b.url).trim();
    if (b.header !== undefined && String(b.header).trim() !== (cat.header || '')) set.header = String(b.header).trim();
    if (b.link !== undefined && String(b.link).trim() !== (cat.link || '')) {
      try {
        set.link = await linkPattern(b.link, _id);
      } catch (e) {
        return res.status(400).json({ error: e.message });
      }
    }
  }
  await db.catalogs().updateOne({ _id }, { $set: set });
  const changed = set.url !== undefined || set.header !== undefined || set.link !== undefined;
  const sync = cat.type === 'api' && changed ? await syncCatalog(_id, 'updated') : null;
  res.json({ ok: true, sync, link: set.link });
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

// Try what the AI would find for a message in a catalog — the same text the AI is given.
catalogs.get('/:id/search', async (req, res) => {
  const q = String(req.query.q || '');
  const ids = [String(req.params.id)];
  const r = await searchCatalog({ latest: q, catalogIds: ids });
  res.json({ products: r.items, budget: r.budget, context: await productContext({ latest: q, catalogIds: ids }) });
});
