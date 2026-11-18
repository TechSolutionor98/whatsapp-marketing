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
const SYNC_EVERY_MS = 30 * 60 * 1000; // new/removed products; price + stock are also checked live per reply
const LIVE_TIMEOUT_MS = 2500;

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

// Price fields. A sale/offer price wins when it's a real discount (above 0, below the regular
// price) — e.g. grabatoz sends price 2276.67 + offerPrice 2049 (the price on the site), and
// offerPrice 0 when there's no offer.
const SALE_KEYS = ['sale_price', 'salePrice', 'special_price', 'specialPrice', 'final_price', 'finalPrice', 'offer_price', 'offerPrice', 'discount_price', 'discountPrice', 'discounted_price', 'discountedPrice'];
const PRICE_KEYS = ['price', 'regular_price', 'regularPrice', 'variants.0.price', 'price.amount', 'pricing.price', 'list_price', 'mrp'];
const WAS_KEYS = ['compare_at_price', 'variants.0.compare_at_price', 'old_price', 'oldPrice'];
function firstPositive(o, paths) {
  for (const k of paths) {
    const n = toNum(get(o, k));
    if (n != null && n > 0) return n;
  }
  return null;
}

// "Computers › Laptop › Gaming Laptops" from whichever category fields the feed has.
const CAT_KEYS = ['parentCategory', 'parent_category', 'category', 'category_name', 'categories', 'subCategory', 'subcategory', 'sub_category', 'subCategory2', 'subCategory3', 'subCategory4', 'product_type'];
function categoryOf(p) {
  const names = [];
  const add = (v) => {
    if (Array.isArray(v)) return v.slice(0, 6).forEach(add);
    const t = text(v, 60);
    if (!t || /^[0-9a-f]{24}$/i.test(t) || /^\d+$/.test(t)) return; // an unexpanded id, not a name
    if (!names.some((n) => n.toLowerCase() === t.toLowerCase())) names.push(t);
  };
  for (const k of CAT_KEYS) add(get(p, k));
  if (!names.length) add(p.type);
  return names.slice(0, 6).join(' › ').slice(0, 160);
}

// Extra words customers search by but that aren't in the name: tags, Arabic name, model, series.
function keywordsOf(p) {
  const out = [];
  const add = (v) => {
    if (Array.isArray(v)) return v.slice(0, 30).forEach(add);
    const t = text(v, 400);
    if (t) out.push(t);
  };
  for (const k of ['tags', 'keywords', 'nameAr', 'name_ar', 'model', 'series', 'subtitle', 'brand.nameAr', 'category.nameAr', 'subCategory.nameAr', 'subCategory2.nameAr', 'parentCategory.nameAr']) add(get(p, k));
  return out.join(' · ').slice(0, 1400);
}
// The Arabic words of a product, spelled the way searches compare them (أسوس → اسوس,
// للألعاب → العاب) — indexed so "اسوس" typed without the hamza still finds "أسوس".
function arabicKeys(s) {
  const words = String(s || '').match(/[\u0621-\u063a\u0641-\u064a\u0671-\u06d3\u064b-\u0652\u0640]+/g) || [];
  return [...new Set(words.map(normArabic))].join(' ').slice(0, 1400);
}

// Product page link from the catalog's pattern, e.g. https://shop.com/product/{slug}.
export function fillLink(pattern, fields) {
  if (!pattern || !/\{(slug|id|sku|handle)\}/.test(pattern)) return '';
  let missing = false;
  const url = pattern.replace(/\{(slug|id|sku|handle)\}/g, (_, k) => {
    const v = fields[k];
    if (v == null || v === '') missing = true;
    return encodeURIComponent(String(v ?? ''));
  });
  return missing ? '' : url;
}

export function normalizeProduct(p, sourceUrl = '', linkPattern = '') {
  if (!p || typeof p !== 'object') return null;
  const name = text(pick(p, ['name', 'title', 'product_name', 'productName']), 200);
  if (!name) return null;
  let price = null;
  let regular = null;
  let currency = '';
  if (p.prices?.price != null) {
    // WooCommerce Store API: prices in minor units ("12500" with currency_minor_unit 2 → 125.00)
    const minor = Number(p.prices.currency_minor_unit ?? 2);
    price = toNum(p.prices.sale_price || p.prices.price);
    if (price != null) price = price / 10 ** minor;
    regular = toNum(p.prices.regular_price);
    if (regular != null) regular = regular / 10 ** minor;
    currency = p.prices.currency_code || '';
  } else {
    regular = firstPositive(p, PRICE_KEYS);
    const sale = firstPositive(p, SALE_KEYS);
    if (sale != null && (regular == null || sale < regular)) price = sale;
    else {
      price = regular ?? sale;
      regular = firstPositive(p, WAS_KEYS); // Shopify "compare at" = the old price
    }
    currency = text(pick(p, ['currency', 'currency_code', 'price_currency', 'price.currency', 'pricing.currency']), 8);
  }
  let origin = '';
  try {
    origin = new URL(sourceUrl).origin;
  } catch {}
  const ext_id = String(pick(p, ['id', '_id', 'product_id', 'productId', 'sku']) ?? name);
  const sku = text(pick(p, ['sku', 'variants.0.sku', 'model', 'mpn']), 80);
  const slug = text(pick(p, ['slug', 'handle', 'url_key', 'urlKey']), 200);
  let url = text(pick(p, ['url', 'permalink', 'link', 'product_url', 'productUrl', 'online_store_url']), 500);
  if (!url && linkPattern) url = fillLink(linkPattern, { slug, id: ext_id, sku, handle: p.handle || slug });
  if (!url && p.handle && origin) url = `${origin}/products/${p.handle}`; // Shopify
  if (url && url.startsWith('/') && origin) url = origin + url;
  return {
    ext_id,
    name,
    price,
    regular_price: regular != null && price != null && regular > price ? regular : null,
    currency,
    url,
    slug,
    sku,
    brand: text(pick(p, ['brand', 'brand.name', 'brands.0.name', 'vendor', 'manufacturer']), 80),
    category: categoryOf(p),
    in_stock: stockOf(p),
    description: text(pick(p, ['short_description', 'shortDescription', 'description', 'body_html', 'summary', 'details'])),
    keywords: keywordsOf(p),
    keywords_ar: arabicKeys(`${name} ${keywordsOf(p)}`),
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
export async function fetchCatalog(feedUrl, headerSetting = '', linkPattern = '') {
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
      const p = normalizeProduct(raw, feedUrl, linkPattern);
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
// catalogs: { _id, name, type: 'api'|'manual', url, header, link (product page pattern), currency, status: {count, at, error} }
// products: { catalog_id, ext_id, name, price, regular_price, currency, url, slug, sku, brand, category, in_stock, description, keywords }
const inflight = new Map(); // catalogId -> sync promise
export function syncCatalog(catalogId, reason = 'manual') {
  const key = String(catalogId);
  if (inflight.has(key)) return inflight.get(key);
  const job = (async () => {
    const cat = await db.catalogs().findOne({ _id: new ObjectId(key) });
    if (!cat) return { error: 'Catalog not found' };
    if (cat.type !== 'api') return { count: await db.products().countDocuments({ catalog_id: key }) };
    try {
      const products = await fetchCatalog(cat.url, cat.header || '', cat.link || '');
      const at = nowIso();
      const ops = products.map((p) => ({
        updateOne: { filter: { catalog_id: key, ext_id: p.ext_id }, update: { $set: { ...p, catalog_id: key, synced_at: at } }, upsert: true },
      }));
      for (let i = 0; i < ops.length; i += 500) await db.products().bulkWrite(ops.slice(i, i + 500), { ordered: false });
      await db.products().deleteMany({ catalog_id: key, synced_at: { $ne: at } }); // removed from the store
      // Can we ask the API for one product (…/products/<id>)? Then price and stock are read live
      // right before the AI quotes a product, instead of from this copy.
      let live = { ok: false, at, error: null };
      const sample = products.find((p) => p.in_stock === true) || products[0];
      if (sample) {
        const r = await fetchLive(cat, sample).catch((e) => ({ error: e.message }));
        live = { ok: !!r.product, at, error: r.product ? null : r.gone ? 'no single-product address' : r.error || 'no answer' };
      }
      await db.catalogs().updateOne({ _id: cat._id }, { $set: { status: { count: products.length, at, error: null }, live } });
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
// Small words that never identify a product (English + Roman Urdu + a few Arabic), so they
// don't drown the real keyword ("muja pos ka bara ma batao" → "pos").
const STOP = new Set(
  ('a an the is are am was were be been do does did have has had i me my we our you your he she it they them this that these those ' +
    'to of in on at for from with about regarding and or but if so not no yes please pls plz can could would should will shall may might ' +
    'what which who whom whose when where why how any some much many more most need want help know tell show give send get price prices cost ' +
    'rate available avail availability stock hi hello hey hlo salam assalam asslamoalikum assalamualaikum thanks thank ok okay sir bhai bro ' +
    'u ur model models sure interested looking like also there here anything something one ones other options option ' +
    'good best better cheap cheaper cheapest expensive new latest buy purchase order ' +
    'under below above over less than lower within upto up between around approx approximately budget range max maximum min minimum least ' +
    'aed dhs dh dirham dirhams rs pkr sar usd qar omr kwd bhd ' +
    'muja mujhe mujy mujhy mujhay mera meri mere hum hamein aap ap apka apki ka ki ke ko kya kia kab kahan kaise kese kitne kitna kitni ' +
    'hai hain ha hy he ho hoon hun tha thi the hoga hogi raha rahi rha rhi bara baray barey bare baare mein me ma main se sy par pe ' +
    'batao bataye btao btaen bta bata dikhao chahiye chahye chahiay lena dena kar kr karo krdo kardo wala wali wale bhi aur ya yeh ye woh wo ' +
    'tak tk kam km zyada ziada zayada upar uper andar andr sasta sasti acha achi achha ' +
    'في من على هل عن ما لا نعم مع الى إلى او أو كم سعر اسعار عندكم عندك لديكم هذا هذه اريد ابغى ابي ممكن متوفر متوفرة بكم')
    .split(' ')
    .map((w) => normArabic(w))
);
// Words: Latin letters/digits and Arabic letters (not Arabic punctuation like ، ؟).
const WORD_RX = /[a-z0-9\u0621-\u063a\u0641-\u064a\u0660-\u0669\u0671-\u06d3]+/g;
// Arabic is written several ways: أسوس / اسوس / آسوس, للألعاب / ألعاب. Customers rarely type the
// hamza — so the store's words and theirs are compared without it and without the prefix ال/لل.
export function normArabic(w) {
  if (!/[\u0621-\u06d3]/.test(w)) return w;
  let t = w.replace(/[\u064b-\u0652\u0640]/g, ''); // vowel marks, tatweel
  const pre = t.match(/^(\u0648\u0627\u0644|\u0628\u0627\u0644|\u0643\u0627\u0644|\u0641\u0627\u0644|\u0644\u0644|\u0627\u0644)/);
  if (pre && t.length - pre[0].length >= 3) t = t.slice(pre[0].length);
  return t.replace(/[\u0623\u0625\u0622\u0671]/g, '\u0627').replace(/\u0649/g, '\u064a').replace(/\u0629/g, '\u0647').replace(/\u0624/g, '\u0648').replace(/\u0626/g, '\u064a');
}
const wordsOf = (s) => (String(s || '').toLowerCase().match(WORD_RX) || []).map(normArabic);
// laptops → laptop, cameras → camera; not asus, glass, lens
const singular = (w) => (w.length > 4 && w.endsWith('s') && !/(ss|us|is)$/.test(w) && !/\d/.test(w) ? w.slice(0, -1) : w);
export function searchTerms(text) {
  const words = wordsOf(text);
  const terms = [];
  for (const w of words) {
    if (w.length < 2 || STOP.has(w)) continue;
    if (/^\d+(aed|dhs?|rs|pkr|sar|usd)$/.test(w)) continue; // "2000aed" is a budget, not a product word
    terms.push(w);
    const one = singular(w);
    if (one !== w) terms.push(one); // cameras → camera
  }
  return [...new Set(terms)].slice(0, 10);
}

// A budget in the customer's words: "under 2000AED", "below aed 1,500", "2k tak", "2000 se kam",
// "between 1500 and 2500", "above 3000", "laptop for 2000 dhs". Numbers that are specs
// ("16gb", "15.6 inch", "4k") or model numbers ("vivobook 15") are not budgets.
const CUR_W = new Set(['aed', 'dhs', 'dh', 'dirham', 'dirhams', 'rs', 'pkr', 'sar', 'usd', '$', 'qar', 'omr', 'kwd', 'bhd']);
const UNIT_W = new Set(['gb', 'tb', 'mb', 'mp', 'hz', 'inch', 'inches', 'in', 'w', 'watt', 'mah', 'mm', 'cm', 'kg', 'gen', 'th', 'nd', 'rd', 'st', 'fps', 'ppm', 'dpi', 'pcs', 'pieces', 'piece', 'units', 'gbps', 'mbps', 'ghz']);
const MAX_KW = new Set(['under', 'below', 'less', 'lower', 'within', 'upto', 'up', 'max', 'maximum', 'budget', 'around', 'approx', 'approximately', 'till', 'until', 'beneath', 'cheaper', 'for', 'in']);
const MIN_KW = new Set(['above', 'over', 'more', 'min', 'minimum', 'least', 'atleast', 'starting']);
const SE = new Set(['se', 'sy', 'say']);
export function parseBudget(text) {
  const src = String(text || '')
    .toLowerCase()
    .replace(/(\d),(\d{3})\b/g, '$1$2')
    .replace(/(\d)\s*-\s*(\d)/g, '$1 to $2')
    .replace(/(\d)(aed|dhs?|dirhams?|rs|pkr|sar|usd)\b/g, '$1 $2')
    .replace(/\b(aed|dhs?|rs|pkr|sar|usd)(\d)/g, '$1 $2')
    .replace(/\$\s*(\d)/g, '$ $1')
    .replace(/[\u0660-\u0669]/g, (d) => String(d.charCodeAt(0) - 0x660)); // ٢٠٠٠ → 2000
  const tok = src.match(/\$|\d+(?:\.\d+)?k?|[a-z\u0600-\u06ff]+/g) || [];
  const isNum = (t) => /^\d+(?:\.\d+)?k?$/.test(t || '');
  const val = (t) => parseFloat(t) * (t.endsWith('k') ? 1000 : 1);
  const used = new Set();
  let min = null;
  let max = null;
  for (let i = 0; i < tok.length; i++) {
    if (!isNum(tok[i]) || used.has(i)) continue;
    const next = tok[i + 1];
    if (UNIT_W.has(next) && !CUR_W.has(tok[i - 1])) continue; // 16gb, 15.6 inch
    const n = val(tok[i]);
    if (!(n >= 10)) continue;
    const cur = CUR_W.has(next) || CUR_W.has(tok[i - 1]);
    let kw = null;
    for (let j = i - 1; j >= Math.max(0, i - 3) && !isNum(tok[j]); j--) {
      if (MAX_KW.has(tok[j]) && !(tok[j] === 'for' || tok[j] === 'in') ) { kw = 'max'; break; }
      if (MIN_KW.has(tok[j])) { kw = 'min'; break; }
      if ((tok[j] === 'for' || tok[j] === 'in') && cur) { kw = 'max'; break; }
      if (tok[j] === 'between' || tok[j] === 'from') { kw = 'from'; break; }
    }
    // after the number (skipping a currency word): "2000 tak", "2000 se kam", "2000 ke andar", "2000 se zyada", "1500 to 2500"
    let k = i + 1;
    if (CUR_W.has(tok[k])) k++;
    const a = tok[k];
    const b = tok[k + 1];
    if (a === 'tak' || a === 'tk' || (SE.has(a) && /^(kam|km|neeche|niche)$/.test(b || '')) || (/^(ke|k|ka)$/.test(a || '') && /^(andar|andr|under|budget)$/.test(b || ''))) kw = 'max';
    else if (SE.has(a) && /^(zyada|ziada|zayada|upar|uper|oper|ooper|oopar|above|more)$/.test(b || '')) kw = 'min';
    // a range: "1500 to 2500", "between 1500 and 2500 aed", "1500 se 2500 tak"
    if (/^(to|and|se|sy|till)$/.test(a || '') && isNum(tok[k + 1]) && !UNIT_W.has(tok[k + 2])) {
      const n2 = val(tok[k + 1]);
      if (n2 > n && (kw || cur || CUR_W.has(tok[k + 2]) || /^(tak|tk)$/.test(tok[k + 2] || '') || n >= 100)) {
        min = n;
        max = n2;
        used.add(i).add(k + 1);
        continue;
      }
    }
    if (kw === 'from') kw = 'min';
    if (!kw && cur) kw = 'max'; // "laptop for 2000 aed" → about that much
    if (!kw) continue; // "vivobook 15", "2000 series", "4k" — not a budget
    if (kw === 'max') max = n;
    else min = n;
    used.add(i);
  }
  if (min == null && max == null) return { min, max, rest: String(text || '') };
  // the message without the budget numbers (everything else as typed: "16gb" stays one word)
  let rest = src;
  for (const i of used) rest = rest.replace(new RegExp(`(^|[^\\d.])${tok[i].replace('.', '\\.')}(?![\\d.k])`), '$1 ');
  return { min, max, rest };
}

const stockRank = (p) => (p.in_stock === true ? 2 : p.in_stock == null ? 1 : 0);
const has = (words, base) => words.some((w) => w.startsWith(base));

// The catalog search behind AI replies. Their latest message counts double (an earlier
// "asus gaming laptop" + now "the one under 2000AED" → asus, gaming, laptop + budget 2000).
// Returns the best matches within budget (in stock first), and when those don't help: the
// nearest-priced matches outside the budget and other in-stock options inside it.
export async function searchCatalog({ latest = '', earlier = '', catalogIds = null, limit = 4, live = true } = {}) {
  const empty = { items: [], closest: [], related: [], budget: null, total: 0, inStock: 0, asked: '' };
  if (!isMongoUp()) return empty;
  if (Array.isArray(catalogIds) && !catalogIds.length) return empty;
  const b1 = parseBudget(latest);
  const b0 = parseBudget(earlier);
  const budget = b1.min != null || b1.max != null ? b1 : b0.min != null || b0.max != null ? b0 : null;
  const latestTerms = searchTerms(b1.rest);
  const earlierTerms = searchTerms(b0.rest);
  const terms = [...new Set([...latestTerms, ...earlierTerms])].slice(0, 10);
  if (!terms.length) return empty;
  const scope = Array.isArray(catalogIds) ? { catalog_id: { $in: catalogIds.map(String) } } : {};
  if (!(await db.products().countDocuments(scope, { limit: 1 }))) return empty;
  const proj = { ext_id: 1, slug: 1, name: 1, price: 1, regular_price: 1, currency: 1, url: 1, in_stock: 1, brand: 1, category: 1, sku: 1, description: 1, keywords: 1, catalog_id: 1 };
  let cands = await db
    .products()
    .find({ ...scope, $text: { $search: terms.join(' ') } }, { projection: { ...proj, score: { $meta: 'textScore' } } })
    .sort({ score: { $meta: 'textScore' } })
    .limit(400)
    .toArray()
    .catch(() => []);
  if (!cands.length) {
    // partial words ("4mp", "pos" inside names) when the word index finds nothing
    const rx = terms.map((t) => new RegExp(t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i'));
    cands = await db.products().find({ ...scope, $or: rx.flatMap((r) => [{ name: r }, { sku: r }, { brand: r }, { category: r }]) }, { projection: proj }).limit(200).toArray();
  }
  // How many of their words each product has (a plural and its singular count once).
  const bases = [...new Set(terms.map(singular))];
  const latestBases = new Set(latestTerms.map(singular));
  for (const p of cands) {
    p._words = wordsOf(`${p.name} ${p.brand} ${p.category} ${p.sku} ${p.keywords} ${p.description}`);
    const nameW = wordsOf(`${p.name} ${p.brand} ${p.sku}`);
    p._cov = bases.reduce((s, b) => s + (has(p._words, b) ? (latestBases.has(b) ? 2 : 1) : 0), 0);
    p._name = bases.filter((b) => has(nameW, b)).length; // words in the name itself rank higher than category-only hits
  }
  const best = Math.max(0, ...cands.map((p) => p._cov));
  if (!best) return empty;
  // what they asked for, in their order ("asus gaming laptop"), from the words products actually have
  const askedBases = [...new Set([...earlierTerms, ...latestTerms].map(singular))].filter((b) => cands.some((p) => has(p._words, b)));
  // the kind of product: the last of their words that products have ("asus gaming LAPTOP",
  // "hp PRINTER") — alternatives must be that kind (a Vivobook for "gaming laptop", not an ASUS
  // gaming mouse). Their latest message decides when it names one.
  const known = (list) => list.map(singular).filter((b) => askedBases.includes(b));
  const head = known(latestTerms).pop() || known(earlierTerms).pop() || '';
  // each product shown is told which of those words it lacks ("doesn't match: gaming"), so the
  // AI can't present a Vivobook as a gaming laptop
  const missing = (p) => askedBases.filter((b) => !has(p._words, b));
  const fits = (p) => !budget || (p.price != null && p.price > 0 && (budget.max == null || p.price <= budget.max) && (budget.min == null || p.price >= budget.min));
  const rank = (a, b) => stockRank(b) - stockRank(a) || b._name - a._name || (a.price ?? Infinity) - (b.price ?? Infinity);
  const select = () => {
    const pool = cands.filter((p) => p._live !== 'gone');
    const exact = pool.filter((p) => p._cov === best);
    const items = exact.filter(fits).sort(rank).slice(0, limit);
    let closest = [];
    let related = [];
    if (budget && items.filter((p) => p.in_stock !== false).length < 2) {
      const gap = (p) => (budget.max != null && p.price > budget.max ? p.price - budget.max : (budget.min ?? 0) - p.price);
      closest = exact.filter((p) => !fits(p) && p.in_stock === true && p.price > 0).sort((a, b) => gap(a) - gap(b)).slice(0, 2);
      related = pool
        .filter((p) => p._cov < best && (!head || has(p._words, head)) && fits(p) && p.in_stock === true)
        .sort((a, b) => b._cov - a._cov || b._name - a._name || (b.price ?? 0) - (a.price ?? 0))
        .slice(0, 3);
    }
    return { exact, items, closest, related };
  };
  // Price and stock of what we're about to show, read live from the store (when its API answers
  // for one product). A product that sold out or was removed since the last sync drops out, and
  // the choice is made again with the live numbers.
  let sel = select();
  for (let round = 0; live && round < 2; round++) {
    const unchecked = [...sel.items, ...sel.closest, ...sel.related].filter((p) => p._live === undefined);
    if (!unchecked.length) break;
    await refreshLive(unchecked);
    sel = select();
  }
  const { exact, items, closest, related } = sel;
  for (const p of [...items, ...closest, ...related]) {
    p.missing = missing(p);
    p.live = p._live === true;
    delete p._words;
  }
  return { items, closest, related, budget, total: exact.length, inStock: exact.filter((p) => p.in_stock === true).length, asked: askedBases.join(' ') };
}

// ---------- live price & stock ----------
// The address of ONE product in the store's API: Shopify …/products/<handle>.json, WooCommerce
// …/products/<id>, and the usual REST shape …/products/<id> (grabatoz: /api/products/<id>).
export function liveUrlOf(cat, p) {
  let u;
  try {
    u = new URL(cat.url);
  } catch {
    return null;
  }
  if (/\/products\.json$/.test(u.pathname)) return p.slug ? `${u.origin}${u.pathname.replace(/products\.json$/, '')}products/${encodeURIComponent(p.slug)}.json` : null;
  u.search = '';
  u.hash = '';
  return `${u.toString().replace(/\/+$/, '')}/${encodeURIComponent(p.ext_id)}`;
}
async function fetchLive(cat, p) {
  const url = liveUrlOf(cat, p);
  if (!url) return { error: 'no single-product address' };
  const resp = await fetch(url, { headers: headersFromSetting(cat.header), signal: AbortSignal.timeout(LIVE_TIMEOUT_MS) });
  if (resp.status === 404 || resp.status === 410) return { gone: true };
  if (!resp.ok) return { error: `HTTP ${resp.status}` };
  const body = await resp.json().catch(() => null);
  const one = (v) => v && typeof v === 'object' && !Array.isArray(v);
  const raw = one(body?.product) ? body.product : one(body?.data) ? body.data : body;
  const n = one(raw) ? normalizeProduct(raw, cat.url, cat.link || '') : null;
  if (!n || n.ext_id !== p.ext_id) return { error: 'the API answered with a different product' };
  return { product: n };
}
async function refreshLive(list) {
  const ids = [...new Set(list.map((p) => p.catalog_id))];
  const oids = ids.map((id) => { try { return new ObjectId(id); } catch { return null; } }).filter(Boolean);
  const cats = new Map((await db.catalogs().find({ _id: { $in: oids } }).toArray()).map((c) => [String(c._id), c]));
  const at = nowIso();
  await Promise.all(
    list.map(async (p) => {
      const cat = cats.get(String(p.catalog_id));
      if (cat?.type !== 'api' || !cat.live?.ok) return (p._live = null);
      try {
        const r = await fetchLive(cat, p);
        if (r.gone) return (p._live = 'gone'); // removed from the store since the last sync
        if (!r.product) return (p._live = null); // couldn't check — keep the synced numbers
        const n = r.product;
        Object.assign(p, { price: n.price, regular_price: n.regular_price, in_stock: n.in_stock }, n.url ? { url: n.url } : {});
        p._live = true;
        db.products().updateOne({ _id: p._id }, { $set: { price: n.price, regular_price: n.regular_price, in_stock: n.in_stock, live_at: at } }).catch(() => {});
      } catch {
        p._live = null;
      }
    })
  );
}

// Kept for callers that want a plain list (best matches, in stock first).
export async function findProducts(text, limit = 5, catalogIds = null) {
  return (await searchCatalog({ latest: text, catalogIds, limit, live: false })).items;
}

// What the AI is told about products for this message ('' = nothing in the catalog matched).
export async function productContext({ latest = '', earlier = '', catalogIds = null, limit = 4 } = {}) {
  const r = await searchCatalog({ latest, earlier, catalogIds, limit });
  if (!r.items.length && !r.closest.length && !r.related.length) return '';
  const cur = new Map((await db.catalogs().find({}, { projection: { currency: 1 } }).toArray()).map((c) => [String(c._id), c.currency || '']));
  for (const p of [...r.items, ...r.closest, ...r.related]) if (!p.currency) p.currency = cur.get(p.catalog_id) || '';
  const currency = [...r.items, ...r.closest, ...r.related].find((p) => p.currency)?.currency || '';
  const money = (n) => `${currency ? currency + ' ' : ''}${Number(n).toLocaleString('en-US', { maximumFractionDigits: 2 })}`;
  const parts = [];
  if (r.budget) {
    const { min, max } = r.budget;
    parts.push(`Their budget: ${min != null && max != null ? `${money(min)} – ${money(max)}` : max != null ? `up to ${money(max)}` : `from ${money(min)}`}.`);
  }
  const asked = r.asked ? `"${r.asked}"` : 'what they asked for';
  const count = `${r.total} product${r.total === 1 ? '' : 's'} match ${asked}, ${r.inStock} in stock`;
  if (r.items.length) parts.push(`${r.budget ? `Products matching ${asked} within their budget` : `Matching products (${count})`}:\n${productLines(r.items)}`);
  else if (r.budget) parts.push(`No product matching ${asked} is within their budget (${count}).`);
  if (r.closest.length) parts.push(`Nearest in-stock ${asked} outside their budget:\n${productLines(r.closest)}`);
  if (r.related.length) parts.push(`In stock within their budget, but NOT exactly ${asked} — only offer as alternatives and say how they differ:\n${productLines(r.related)}`);
  return parts.join('\n\n');
}

// One line per product for the AI prompt.
export function productLines(products, fallbackCurrency = '') {
  return products
    .map((p, i) => {
      const cur = p.currency || fallbackCurrency;
      const fmt = (n) => `${cur ? cur + ' ' : ''}${Number(n).toLocaleString('en-US', { maximumFractionDigits: 2 })}`;
      const price = p.price != null ? `${fmt(p.price)}${p.regular_price > p.price ? ` (was ${fmt(p.regular_price)})` : ''}` : 'price not listed';
      const stock = p.in_stock === true ? 'in stock' : p.in_stock === false ? 'OUT OF STOCK' : 'stock unknown';
      // kept short: the AI provider counts every word (Groq free tier: 8,000 tokens a minute)
      const name = p.name.length > 110 ? `${p.name.slice(0, 110).replace(/[\s,|–-]+\S*$/, '')}…` : p.name;
      const cat = String(p.category || '').split(' › ').slice(-2).join(' › ');
      const extra = [p.brand && !name.toLowerCase().includes(p.brand.toLowerCase()) ? p.brand : '', cat].filter(Boolean).join(', ');
      const lacks = p.missing?.length ? ` — doesn't match: ${p.missing.join(', ')}` : '';
      return `${i + 1}. ${name}${extra ? ` (${extra})` : ''} — ${price} — ${stock}${lacks}${p.url ? ` — ${p.url}` : ''}${p.description ? `\n   ${p.description.slice(0, 160)}` : ''}`;
    })
    .join('\n');
}
