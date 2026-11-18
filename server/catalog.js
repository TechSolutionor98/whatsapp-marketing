// Product catalog for AI auto-replies.
//
// The store owner pastes their product API / feed URL in Settings → AI. We sync it into the
// `products` collection (on save, every few hours, or "Sync now"), and when a customer writes,
// the replies module looks up matching products and hands them to the AI — so it can answer
// with real names, prices, stock and links instead of "I'll check and get back to you".
//
// Understands, without configuration:
//  - Shopify            …/products.json            (paged with ?limit=250&page=N)
//  - WooCommerce Store  …/wp-json/wc/store/v1/products (paged with ?per_page=100&page=N)
//  - WooCommerce REST   …/wp-json/wc/v3/products    (same paging; needs an API key header)
//  - any JSON list of products: [..] or {products|items|data|results|docs: [..]} (also nested),
//    following next/next_page_url/links.next/pagination.next links when present.
import { ObjectId } from 'mongodb';
import { db, getSetting, setSetting, audit, nowIso, isMongoUp } from './db/mongo.js';

const MAX_PRODUCTS = 5000;
const MAX_PAGES = 50;
const FETCH_TIMEOUT_MS = 20000;
const SYNC_EVERY_MS = 6 * 60 * 60 * 1000;

// ---------- normalizing one product from common shapes ----------
const get = (o, path) => path.split('.').reduce((v, k) => (v == null ? v : v[k]), o);
function pick(o, paths) {
  for (const p of paths) {
    const v = get(o, p);
    if (v !== undefined && v !== null && v !== '') return v;
  }
  return undefined;
}
function toNum(v) {
  if (v == null || v === '') return null;
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  const n = parseFloat(String(v).replace(/[^0-9.]/g, ''));
  return Number.isFinite(n) ? n : null;
}
function text(v, max = 300) {
  if (v == null) return '';
  if (typeof v === 'object') v = v.name || v.title || v.en || '';
  return String(v)
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;|&amp;|&#\d+;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
}
function stockOf(p) {
  const s = pick(p, ['in_stock', 'is_in_stock', 'inStock', 'available', 'variants.0.available', 'is_purchasable']);
  if (typeof s === 'boolean') return s;
  const status = String(pick(p, ['stock_status', 'availability', 'stockStatus']) || '').toLowerCase();
  if (status) return /in.?stock|available|instock/.test(status) && !/out/.test(status);
  const qty = toNum(pick(p, ['stock_quantity', 'quantity', 'stock', 'inventory_quantity', 'variants.0.inventory_quantity']));
  return qty == null ? null : qty > 0;
}

export function normalizeProduct(p, sourceUrl = '') {
  if (!p || typeof p !== 'object') return null;
  const name = text(pick(p, ['name', 'title', 'product_name', 'productName']), 200);
  if (!name) return null;
  let price = null;
  let currency = '';
  if (p.prices?.price != null) {
    // WooCommerce Store API: prices in minor units ("12500" with currency_minor_unit 2 → 125.00)
    const minor = Number(p.prices.currency_minor_unit ?? 2);
    price = toNum(p.prices.sale_price || p.prices.price);
    if (price != null) price = price / 10 ** minor;
    currency = p.prices.currency_code || '';
  } else {
    price = toNum(pick(p, ['sale_price', 'salePrice', 'special_price', 'final_price', 'offer_price', 'price', 'regular_price', 'variants.0.price', 'price.amount', 'pricing.price']));
    currency = text(pick(p, ['currency', 'currency_code', 'price_currency', 'price.currency', 'pricing.currency']), 8);
  }
  let origin = '';
  try {
    origin = new URL(sourceUrl).origin;
  } catch {}
  let url = text(pick(p, ['url', 'permalink', 'link', 'product_url', 'productUrl', 'online_store_url']), 500);
  if (!url && p.handle && origin) url = `${origin}/products/${p.handle}`; // Shopify
  if (url && url.startsWith('/') && origin) url = origin + url;
  return {
    ext_id: String(pick(p, ['id', '_id', 'product_id', 'productId', 'sku']) ?? name),
    name,
    price,
    currency,
    url,
    sku: text(pick(p, ['sku', 'variants.0.sku', 'model', 'mpn']), 80),
    brand: text(pick(p, ['brand', 'brand.name', 'brands.0.name', 'vendor', 'manufacturer']), 80),
    category: text(pick(p, ['category', 'category.name', 'categories.0.name', 'product_type', 'category_name', 'type']), 120),
    in_stock: stockOf(p),
    description: text(pick(p, ['short_description', 'shortDescription', 'description', 'body_html', 'summary', 'details'])),
  };
}

// ---------- reading a feed response ----------
const LIST_KEYS = ['products', 'items', 'data', 'results', 'docs', 'records', 'rows', 'list'];
export function productArray(body, depth = 0) {
  if (Array.isArray(body)) return body;
  if (!body || typeof body !== 'object' || depth > 3) return [];
  for (const k of LIST_KEYS) {
    if (Array.isArray(body[k])) return body[k];
    if (body[k] && typeof body[k] === 'object') {
      const inner = productArray(body[k], depth + 1);
      if (inner.length) return inner;
    }
  }
  for (const v of Object.values(body)) {
    if (Array.isArray(v) && v.length && typeof v[0] === 'object' && (v[0].name || v[0].title)) return v;
  }
  return [];
}
function nextLink(body) {
  const n = pick(body || {}, ['next', 'next_page_url', 'nextPageUrl', 'links.next', 'pagination.next', 'meta.next', 'paging.next']);
  return typeof n === 'string' && /^https?:\/\//.test(n) ? n : null;
}

// Header like "Authorization: Bearer abc" or "x-api-key: abc" (optional).
function headersFromSetting(raw) {
  const h = { Accept: 'application/json', 'User-Agent': 'TechWA-Catalog/1.0' };
  const line = String(raw || '').trim();
  const i = line.indexOf(':');
  if (i > 0) h[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  return h;
}

async function getJson(url, headers) {
  const resp = await fetch(url, { headers, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  if (!resp.ok) throw new Error(`HTTP ${resp.status} from ${new URL(url).host}`);
  const type = resp.headers.get('content-type') || '';
  const body = await resp.text();
  try {
    return JSON.parse(body);
  } catch {
    throw new Error(`${new URL(url).host} didn't return JSON (${type.split(';')[0] || 'unknown type'}) — paste the product API/feed URL, not the shop page`);
  }
}

// Walk every page of the feed and return normalized products.
export async function fetchCatalog(feedUrl, headerSetting = '') {
  let u;
  try {
    u = new URL(feedUrl);
  } catch {
    throw new Error('That product URL is not a valid web address');
  }
  if (!/^https?:$/.test(u.protocol)) throw new Error('Product URL must start with http:// or https://');
  const headers = headersFromSetting(headerSetting);
  const isShopify = /\/products\.json$/.test(u.pathname);
  const isWoo = /\/wp-json\/wc\//.test(u.pathname);
  const out = new Map();
  let pageUrl = u.toString();
  let page = Number(u.searchParams.get('page')) || 1;
  if (isShopify) {
    u.searchParams.set('limit', u.searchParams.get('limit') || '250');
    u.searchParams.set('page', String(page));
    pageUrl = u.toString();
  } else if (isWoo) {
    u.searchParams.set('per_page', u.searchParams.get('per_page') || '100');
    u.searchParams.set('page', String(page));
    pageUrl = u.toString();
  }
  const pagedByNumber = isShopify || isWoo || u.searchParams.has('page');
  for (let i = 0; i < MAX_PAGES && pageUrl && out.size < MAX_PRODUCTS; i++) {
    const body = await getJson(pageUrl, headers);
    const list = productArray(body);
    let added = 0;
    for (const raw of list) {
      const p = normalizeProduct(raw, feedUrl);
      if (p && !out.has(p.ext_id)) {
        out.set(p.ext_id, p);
        added++;
      }
    }
    if (i === 0 && !list.length) throw new Error('No products found in that response — check the URL points to a product list');
    const next = nextLink(body);
    if (next) pageUrl = next;
    else if (pagedByNumber && added > 0) {
      const nu = new URL(pageUrl);
      nu.searchParams.set('page', String(++page));
      pageUrl = nu.toString();
    } else pageUrl = null;
  }
  return [...out.values()].slice(0, MAX_PRODUCTS);
}

// ---------- catalogs: API (synced) or manual (typed in Settings) ----------
// catalogs: { _id, name, type: 'api'|'manual', url, header, currency, status: {count, at, error} }
// products: { catalog_id, ext_id, name, price, currency, url, sku, brand, category, in_stock, description }
const inflight = new Map(); // catalogId -> sync promise
export function syncCatalog(catalogId, reason = 'manual') {
  const key = String(catalogId);
  if (inflight.has(key)) return inflight.get(key);
  const job = (async () => {
    const cat = await db.catalogs().findOne({ _id: new ObjectId(key) });
    if (!cat) return { error: 'Catalog not found' };
    if (cat.type !== 'api') return { count: await db.products().countDocuments({ catalog_id: key }) };
    try {
      const products = await fetchCatalog(cat.url, cat.header || '');
      const at = nowIso();
      const ops = products.map((p) => ({
        updateOne: { filter: { catalog_id: key, ext_id: p.ext_id }, update: { $set: { ...p, catalog_id: key, synced_at: at } }, upsert: true },
      }));
      for (let i = 0; i < ops.length; i += 500) await db.products().bulkWrite(ops.slice(i, i + 500), { ordered: false });
      await db.products().deleteMany({ catalog_id: key, synced_at: { $ne: at } }); // removed from the store
      await db.catalogs().updateOne({ _id: cat._id }, { $set: { status: { count: products.length, at, error: null } } });
      audit('system', `Product catalog "${cat.name}" synced (${reason}): ${products.length} products`, { level: 'success' });
      return { count: products.length };
    } catch (e) {
      await db.catalogs().updateOne({ _id: cat._id }, { $set: { 'status.error': e.message, 'status.at': nowIso() } });
      audit('system', `Product catalog "${cat.name}" sync failed: ${e.message}`, { level: 'warn' });
      return { error: e.message };
    }
  })().finally(() => inflight.delete(key));
  inflight.set(key, job);
  return job;
}

export async function syncAllCatalogs(reason = 'scheduled') {
  for (const c of await db.catalogs().find({ type: 'api' }).toArray()) await syncCatalog(c._id, reason);
}

// One-time: the first version had a single feed URL in Settings — turn it into a catalog.
export async function migrateLegacyFeed() {
  const url = String(getSetting('productFeedUrl', '') || '').trim();
  if (!url || (await db.catalogs().countDocuments())) return;
  const r = await db.catalogs().insertOne({
    name: 'Store catalog',
    type: 'api',
    url,
    header: getSetting('productFeedHeader', '') || '',
    currency: getSetting('productCurrency', '') || '',
    status: getSetting('productFeedStatus', null) || {},
    created_at: nowIso(),
  });
  await db.products().updateMany({ catalog_id: { $exists: false } }, { $set: { catalog_id: String(r.insertedId) } });
  await setSetting('productFeedUrl', '');
}

export function startCatalogSync() {
  const tick = async () => {
    if (!isMongoUp()) return setTimeout(tick, 5000);
    try {
      await migrateLegacyFeed();
      await syncAllCatalogs('scheduled');
    } catch {}
  };
  setTimeout(tick, 15000);
  setInterval(tick, SYNC_EVERY_MS);
}

// Which catalogs a WhatsApp number's AI uses. Set per number in Conversations → AI settings:
// a catalog id, or 'none'. Not chosen yet → the only catalog if there's exactly one.
export async function catalogIdsForAccount(accountId) {
  let chosen = null;
  if (accountId === 'main') chosen = getSetting('mainCatalogId', null);
  else {
    try {
      chosen = (await db.warmupAccounts().findOne({ _id: new ObjectId(String(accountId)) }, { projection: { catalog_id: 1 } }))?.catalog_id ?? null;
    } catch {}
  }
  if (chosen === 'none') return [];
  if (chosen) return [String(chosen)];
  const all = await db.catalogs().find({}, { projection: { _id: 1 } }).limit(2).toArray();
  return all.length === 1 ? [String(all[0]._id)] : [];
}

// A product typed in by hand (Settings → catalog → Add product).
export function manualProduct(b = {}) {
  const name = text(b.name, 200);
  if (!name) throw new Error('Product title is required');
  const price = b.price === '' || b.price == null ? null : toNum(b.price);
  return {
    name,
    price,
    currency: text(b.currency, 8).toUpperCase(),
    url: text(b.url, 500),
    sku: text(b.sku, 80),
    brand: text(b.brand, 80),
    category: text(b.category, 120),
    in_stock: b.in_stock === undefined || b.in_stock === null ? null : !!b.in_stock,
    description: text(b.description, 600),
  };
}

// ---------- finding products for a customer's message ----------
// Small words that never identify a product (English + Roman Urdu), so they don't drown
// the real keyword ("muja pos ka bara ma batao" → "pos").
const STOP = new Set(
  ('a an the is are am was were be been do does did have has had i me my we our you your he she it they them this that these those ' +
    'to of in on at for from with about regarding and or but if so not no yes please pls plz can could would should will shall may might ' +
    'what which who whom whose when where why how any some much many more most need want help know tell show give send get price cost ' +
    'rate available stock hi hello hey salam assalam asslamoalikum assalamualaikum thanks thank ok okay sir bhai bro ' +
    'muja mujhe mujy mujhy mujhay mera meri mere hum hamein aap ap apka apki ka ki ke ko kya kia kab kahan kaise kese kitne kitna kitni ' +
    'hai hain ha hy he ho hoon hun tha thi the hoga hogi raha rahi rha rhi bara baray barey bare baare mein me ma main se sy par pe ' +
    'batao bataye btao btaen bta bata dikhao chahiye chahye chahiay lena dena kar kr karo krdo kardo wala wali wale bhi aur ya yeh ye woh wo')
    .split(' ')
);
export function searchTerms(text) {
  const words = String(text || '').toLowerCase().match(/[a-z0-9]+/g) || [];
  const terms = [];
  for (const w of words) {
    if (w.length < 2 || STOP.has(w)) continue;
    terms.push(w);
    if (w.length > 3 && w.endsWith('s')) terms.push(w.slice(0, -1)); // cameras → camera
  }
  return [...new Set(terms)].slice(0, 8);
}

export async function findProducts(text, limit = 5, catalogIds = null) {
  if (!isMongoUp()) return [];
  const terms = searchTerms(text);
  if (!terms.length) return [];
  if (Array.isArray(catalogIds) && !catalogIds.length) return [];
  const scope = Array.isArray(catalogIds) ? { catalog_id: { $in: catalogIds.map(String) } } : {};
  if (!(await db.products().countDocuments(scope, { limit: 1 }))) return [];
  const proj = { name: 1, price: 1, currency: 1, url: 1, in_stock: 1, brand: 1, category: 1, sku: 1, description: 1, catalog_id: 1 };
  let found = await db
    .products()
    .find({ ...scope, $text: { $search: terms.join(' ') } }, { projection: { ...proj, score: { $meta: 'textScore' } } })
    .sort({ score: { $meta: 'textScore' } })
    .limit(limit)
    .toArray()
    .catch(() => []);
  if (!found.length) {
    // partial words ("4mp", "pos" inside names) when the word index finds nothing
    const rx = terms.map((t) => new RegExp(t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i'));
    found = await db.products().find({ ...scope, $or: rx.flatMap((r) => [{ name: r }, { sku: r }, { brand: r }]) }, { projection: proj }).limit(limit).toArray();
  }
  return found;
}

// One line per product for the AI prompt.
export function productLines(products, fallbackCurrency = '') {
  return products
    .map((p, i) => {
      const cur = p.currency || fallbackCurrency;
      const price = p.price != null ? `${cur ? cur + ' ' : ''}${Number(p.price).toLocaleString('en-US', { maximumFractionDigits: 2 })}` : 'price not listed';
      const stock = p.in_stock === true ? 'in stock' : p.in_stock === false ? 'OUT OF STOCK' : 'stock unknown';
      const extra = [p.brand, p.category].filter(Boolean).join(', ');
      return `${i + 1}. ${p.name}${extra ? ` (${extra})` : ''} — ${price} — ${stock}${p.url ? ` — ${p.url}` : ''}${p.description ? `\n   ${p.description.slice(0, 160)}` : ''}`;
    })
    .join('\n');
}
