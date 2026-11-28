// AI Agents: an AI chat assistant a business puts on its own website (one line of code, see
// web/public/widget.js). It answers visitors from the workspace's product catalogs (every
// catalog by default: API-synced and typed-in) and the business info written on the agent, and
// when only a person can help it offers the business's WhatsApp number.
//
// Agents live in the tenant collection `agents`; website chats in `agent_chats` (kept 90 days).
// The public side (no sign-in) is server/routes/agent-public.js; the AI Agents page talks to
// server/routes/agents.js.
import crypto from 'node:crypto';
import { db, nowIso, dayKey, getSetting } from './db/mongo.js';
import { aiAvailable, websiteReply } from './ai.js';
import { productContext } from './catalog.js';
import { listNumbers } from './numbers.js';
import { currentWs } from './tenant.js';
import { normalizePhone } from './utils.js';

export const MAX_AGENTS = 10; // agents one workspace may have
export const PER_AGENT_DAY = 1000; // AI answers one agent gives a day (each costs an AI call)
export const MAX_MESSAGE = 1000; // characters in one visitor message
export const MAX_SESSION = 40; // visitor messages in one chat; then a new chat (or WhatsApp)
export const KEEP_DAYS = 90; // website chats are removed after this many days without a message
// Messages to one agent: one chat (a visitor) 8 a minute / 60 an hour; one IP address — maybe a
// whole office, or every visitor if a proxy hides their addresses — 30 a minute / 300 an hour.
const CHAT_LIMITS = [8, 60];
const IP_LIMITS = [30, 300];

export class AgentError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}
const fail = (status, code, message) => {
  throw new AgentError(status, code, message);
};

// ---- Settings of one agent ----

const COLORS = ['#16a34a', '#2563eb', '#7c3aed', '#db2777', '#ea580c', '#0f766e', '#111827'];
const TONES = ['friendly', 'professional', 'casual', 'enthusiastic'];
const str = (v, max) => String(v ?? '').replace(/\r\n/g, '\n').trim().slice(0, max);
const newPubId = () => `ag_${crypto.randomBytes(10).toString('hex')}`;

// "https://www.shop.com/path" / "shop.com" / "*.shop.com" → "shop.com" (subdomains are allowed too).
export function cleanDomain(v) {
  let s = String(v || '').trim().toLowerCase();
  if (!s) return '';
  s = s.replace(/^\*\./, '');
  try {
    s = new URL(/^[a-z]+:\/\//.test(s) ? s : `https://${s}`).hostname;
  } catch {
    return '';
  }
  s = s.replace(/^www\./, '');
  return /^[a-z0-9.-]+$/.test(s) && (s.includes('.') || s === 'localhost') ? s : '';
}

// The line under the agent's name in the chat. The first default said "AI assistant"; the chat
// doesn't call itself that (see websiteReply), so agents still on that default show the new one.
export const DEFAULT_SUBTITLE = 'Replies instantly';
const OLD_SUBTITLE = 'AI assistant · replies instantly';
export const subtitleOf = (a) => (!a?.subtitle || a.subtitle === OLD_SUBTITLE ? DEFAULT_SUBTITLE : a.subtitle);

// What the AI Agents page sent → a clean agent (only known fields, within limits).
export function cleanAgent(b = {}, cur = {}) {
  const has = (k) => Object.prototype.hasOwnProperty.call(b, k);
  const out = {};
  if (has('name') || !cur.name) out.name = str(b.name, 60) || 'Shop assistant';
  if (has('greeting') || cur.greeting == null) out.greeting = str(b.greeting, 400) || 'Hi! 👋 How can I help you today?';
  if (has('subtitle') || cur.subtitle == null) out.subtitle = subtitleOf({ subtitle: str(b.subtitle, 60) });
  if (has('color') || !cur.color) out.color = /^#[0-9a-f]{6}$/i.test(String(b.color || '')) ? String(b.color).toLowerCase() : COLORS[0];
  if (has('position') || !cur.position) out.position = b.position === 'left' ? 'left' : 'right';
  if (has('enabled') || cur.enabled == null) out.enabled = b.enabled === undefined ? true : !!b.enabled;
  if (has('info')) out.info = str(b.info, 6000);
  if (has('tone') || !cur.tone) out.tone = TONES.includes(b.tone) ? b.tone : 'friendly';
  if (has('catalogs') || cur.catalogs == null) {
    // 'all' (every catalog, now and later), 'none', or a list of catalog ids
    const c = b.catalogs;
    out.catalogs = c === 'none' ? 'none' : Array.isArray(c) ? [...new Set(c.map(String).filter((x) => /^[a-f0-9]{24}$/.test(x)))].slice(0, 50) : 'all';
    if (Array.isArray(out.catalogs) && !out.catalogs.length) out.catalogs = 'none';
  }
  if (has('suggestions') || !cur.suggestions) {
    out.suggestions = (Array.isArray(b.suggestions) ? b.suggestions : []).map((s) => str(s, 80)).filter(Boolean).slice(0, 4);
  }
  if (has('domains') || !cur.domains) {
    const list = Array.isArray(b.domains) ? b.domains : String(b.domains || '').split(/[\s,]+/);
    out.domains = [...new Set(list.map(cleanDomain).filter(Boolean))].slice(0, 20);
  }
  if (has('handoff') || !cur.handoff) {
    // 'default' = the workspace's default WhatsApp number, 'number' = the phone typed here, 'none'
    const h = b.handoff || {};
    const mode = ['default', 'number', 'none'].includes(h.mode) ? h.mode : 'default';
    const phone = mode === 'number' ? normalizePhone(h.phone) : '';
    if (mode === 'number' && !/^\d{8,15}$/.test(phone || '')) fail(400, 'bad_phone', 'WhatsApp button: type the number with the country code, e.g. 971501234567');
    out.handoff = { mode, phone: phone || '' };
  }
  return out;
}

export function newAgentDoc(b, user) {
  return {
    ...cleanAgent(b),
    info: str(b.info, 6000),
    pub_id: newPubId(),
    created_at: nowIso(),
    updated_at: nowIso(),
    created_by: user?.name || user?.email || null,
    total_replies: 0,
    day_key: null,
    day_count: 0,
  };
}

// ---- What the agent knows ----

// Which catalogs to search: null = every catalog of the workspace, [] = none.
export const catalogScope = (agent) => (agent.catalogs === 'none' ? [] : Array.isArray(agent.catalogs) ? agent.catalogs : null);

// A short picture of the whole range, so "what do you sell?" gets a real answer (a product
// search needs a product word). Cached a few minutes per workspace and catalog choice.
const overviewCache = new Map();
const OVERVIEW_TTL_MS = 10 * 60 * 1000;
export async function catalogOverview(catalogIds) {
  if (Array.isArray(catalogIds) && !catalogIds.length) return '';
  const key = `${currentWs()}:${catalogIds ? [...catalogIds].sort().join(',') : 'all'}`;
  const hit = overviewCache.get(key);
  if (hit && Date.now() - hit.at < OVERVIEW_TTL_MS) return hit.text;
  const scope = catalogIds ? { catalog_id: { $in: catalogIds.map(String) } } : {};
  const [row] = await db
    .products()
    .aggregate([
      { $match: scope },
      {
        $facet: {
          total: [{ $group: { _id: null, n: { $sum: 1 }, inStock: { $sum: { $cond: [{ $eq: ['$in_stock', false] }, 0, 1] } }, min: { $min: '$price' }, max: { $max: '$price' } } }],
          cats: [{ $match: { category: { $nin: [null, ''] } } }, { $group: { _id: '$category', n: { $sum: 1 } } }, { $sort: { n: -1 } }, { $limit: 40 }],
          brands: [{ $match: { brand: { $nin: [null, ''] } } }, { $group: { _id: '$brand', n: { $sum: 1 } } }, { $sort: { n: -1 } }, { $limit: 15 }],
          cur: [{ $match: { currency: { $nin: [null, ''] } } }, { $group: { _id: '$currency', n: { $sum: 1 } } }, { $sort: { n: -1 } }, { $limit: 1 }],
        },
      },
    ])
    .toArray();
  const t = row?.total?.[0];
  let text = '';
  if (t?.n) {
    let currency = row.cur?.[0]?._id || '';
    if (!currency) currency = (await db.catalogs().findOne({ currency: { $nin: [null, ''] } }, { projection: { currency: 1 } }))?.currency || '';
    // "Computers › Laptops › Gaming" → count by the last two levels, the useful part
    const cats = new Map();
    for (const c of row.cats || []) {
      const name = String(c._id).split(' › ').slice(-2).join(' › ').slice(0, 60);
      cats.set(name, (cats.get(name) || 0) + c.n);
    }
    const topCats = [...cats.entries()].sort((a, b) => b[1] - a[1]).slice(0, 15).map(([n, c]) => `${n} (${c})`);
    const brands = (row.brands || []).map((b) => String(b._id).slice(0, 40));
    const money = (n) => `${currency ? currency + ' ' : ''}${Number(n).toLocaleString('en-US', { maximumFractionDigits: 0 })}`;
    text = [
      `${t.n.toLocaleString('en-US')} products${t.inStock < t.n ? `, about ${t.inStock.toLocaleString('en-US')} in stock` : ''}.`,
      t.min != null && t.max != null ? `Prices from ${money(t.min)} to ${money(t.max)}.` : '',
      topCats.length ? `Main categories: ${topCats.join(', ')}.` : '',
      brands.length ? `Brands include: ${brands.join(', ')}.` : '',
    ]
      .filter(Boolean)
      .join('\n');
  }
  overviewCache.set(key, { at: Date.now(), text });
  return text;
}

// The WhatsApp number behind the "Chat on WhatsApp" button (null = no button).
export async function handoffPhone(agent) {
  const h = agent.handoff || { mode: 'default' };
  if (h.mode === 'none') return null;
  if (h.mode === 'number') return h.phone || null;
  try {
    const list = await listNumbers();
    return (list.find((n) => n.default) || list[0])?.phone || null;
  } catch {
    return null;
  }
}
export const waLink = (phone) => (phone ? `https://wa.me/${phone}` : null);

// ---- One answer ----

// history: [{ role: 'visitor' | 'agent', text }] ending with the visitor's new message.
export async function answer(agent, history) {
  if (!aiAvailable()) fail(503, 'ai_off', "The assistant can't answer right now.");
  const scope = catalogScope(agent);
  let lastAgent = history.length - 1;
  while (lastAgent >= 0 && history[lastAgent].role !== 'agent') lastAgent--;
  // the same split as WhatsApp replies: their new message(s) count most, earlier ones fill in
  const fresh = history.slice(lastAgent + 1).filter((m) => m.role === 'visitor').slice(-3).map((m) => m.text);
  const earlier = history.slice(0, lastAgent + 1).filter((m) => m.role === 'visitor').slice(-2).map((m) => m.text);
  const ours = lastAgent >= 0 ? history[lastAgent].text || '' : '';
  const [products, overview, phone] = await Promise.all([
    scope && !scope.length ? Promise.resolve(null) : productContext({ latest: fresh.join('\n'), earlier: earlier.join('\n'), ours, catalogIds: scope, limit: 5 }).catch(() => ''),
    catalogOverview(scope).catch(() => ''),
    handoffPhone(agent),
  ]);
  // no business name: the workspace's name isn't always the website's brand (see websiteReply)
  const r = await websiteReply(history, { name: agent.name, info: agent.info, tone: agent.tone, products, overview, whatsapp: phone });
  return { ...r, whatsapp: r.handoff ? waLink(phone) : null };
}

// ---- Limits ----

const hits = new Map(); // bucket → recent timestamps
// Seconds to wait if this bucket is full (0 = fine); records the hit only when `take`.
function bucketWait(key, [perMin, perHour], now, take) {
  const recent = (hits.get(key) || []).filter((t) => now - t < 3600000);
  const lastMin = recent.filter((t) => now - t < 60000);
  hits.set(key, recent);
  if (lastMin.length >= perMin) return Math.max(1, Math.ceil((lastMin[0] + 60000 - now) / 1000));
  if (recent.length >= perHour) return Math.max(1, Math.ceil((recent[0] + 3600000 - now) / 1000));
  if (take) recent.push(now);
  return 0;
}
// A chat that sends no session yet (its first message) counts by IP address.
export function visitorLimited(agentId, ip, session = '', now = Date.now()) {
  const chatKey = `${agentId}:c:${session ? String(session).slice(0, 100) : `ip:${ip}`}`;
  const ipKey = `${agentId}:ip:${ip}`;
  const wait = Math.max(bucketWait(chatKey, CHAT_LIMITS, now, false), bucketWait(ipKey, IP_LIMITS, now, false));
  if (wait) return wait;
  bucketWait(chatKey, CHAT_LIMITS, now, true);
  bucketWait(ipKey, IP_LIMITS, now, true);
  if (hits.size > 50000) for (const [key, list] of hits) if (!list.some((t) => now - t < 3600000)) hits.delete(key);
  return 0;
}

// Count one answer for today; false when the agent has given its daily number already.
export async function takeDailySlot(agent) {
  const today = dayKey();
  const r = await db.agents().updateOne({ _id: agent._id, day_key: today, day_count: { $lt: PER_AGENT_DAY } }, { $inc: { day_count: 1, total_replies: 1 } });
  if (r.modifiedCount) return true;
  const fresh = await db.agents().updateOne({ _id: agent._id, day_key: { $ne: today } }, { $set: { day_key: today, day_count: 1 }, $inc: { total_replies: 1 } });
  return fresh.modifiedCount > 0;
}

// ---- Website chats ----

const hashSession = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');
export const newSession = () => crypto.randomBytes(24).toString('base64url');
const expiry = () => new Date(Date.now() + KEEP_DAYS * 24 * 3600 * 1000);

export async function findChat(agent, session) {
  if (!session || typeof session !== 'string' || session.length > 100) return null;
  return db.agentChats().findOne({ agent_id: String(agent._id), session_hash: hashSession(session) });
}

export async function saveTurn(agent, { chat, session, page, visitorText, reply }) {
  const at = nowIso();
  const msgs = [
    { role: 'visitor', text: visitorText, at },
    { role: 'agent', text: reply.text, at: nowIso(), ...(reply.handoff ? { handoff: true } : {}), ...(reply.failed ? { failed: true } : {}) },
  ];
  const set = { last_at: at, expire_at: expiry(), last_text: visitorText.slice(0, 160) };
  if (reply.handoff) set.handoff = true;
  if (chat) {
    await db.agentChats().updateOne({ _id: chat._id }, { $push: { messages: { $each: msgs, $slice: -200 } }, $set: set, $inc: { visitor_msgs: 1 } });
    return chat._id;
  }
  const doc = {
    agent_id: String(agent._id),
    session_hash: hashSession(session),
    page: str(page, 300),
    first_text: visitorText.slice(0, 160),
    started_at: at,
    day_key: dayKey(),
    visitor_msgs: 1,
    handoff: !!reply.handoff,
    messages: msgs,
    ...set,
  };
  const r = await db.agentChats().insertOne(doc);
  return r.insertedId;
}

// Origin checks: an agent with "Websites" set only answers on those sites (and their
// subdomains) — plus this platform's own pages (the preview). A browser always sends Origin on
// a cross-site request; software can fake it, so this keeps the chat off other sites, it isn't
// a password (the daily limit protects the AI bill).
export function originAllowed(agent, req) {
  const list = agent.domains || [];
  if (!list.length) return true;
  const src = req.get('origin') || req.get('referer') || '';
  let host = '';
  try {
    host = new URL(src).hostname.toLowerCase().replace(/^www\./, '');
  } catch {
    return false;
  }
  // (the Host header only: X-Forwarded-Host is a header any web page can add to its request)
  const self = String(req.get('host') || '').split(':')[0].toLowerCase().replace(/^www\./, '');
  if (host && host === self) return true;
  return list.some((d) => host === d || host.endsWith(`.${d}`));
}

// The visitor's address for the per-visitor limit. Behind nginx the last X-Forwarded-For entry
// is the one nginx added (earlier entries come from the browser and can be anything).
export function clientIp(req) {
  const xff = String(req.get('x-forwarded-for') || '').split(',').map((s) => s.trim()).filter(Boolean);
  return xff[xff.length - 1] || req.socket?.remoteAddress || 'unknown';
}

// What the widget needs to draw itself (public: nothing private in here).
export async function publicConfig(agent) {
  const phone = await handoffPhone(agent);
  return {
    id: agent.pub_id,
    name: agent.name,
    subtitle: subtitleOf(agent),
    greeting: agent.greeting,
    color: agent.color,
    position: agent.position,
    suggestions: agent.suggestions || [],
    whatsapp: waLink(phone),
    max_message: MAX_MESSAGE,
  };
}

// The AI Agents page's view of an agent.
export function agentPublic(a, stats = {}) {
  return {
    id: String(a._id),
    pub_id: a.pub_id,
    name: a.name,
    subtitle: subtitleOf(a),
    greeting: a.greeting,
    color: a.color,
    position: a.position,
    enabled: !!a.enabled,
    info: a.info || '',
    tone: a.tone || 'friendly',
    catalogs: a.catalogs ?? 'all',
    suggestions: a.suggestions || [],
    domains: a.domains || [],
    handoff: a.handoff || { mode: 'default', phone: '' },
    created_at: a.created_at,
    created_by: a.created_by || null,
    total_replies: a.total_replies || 0,
    today_replies: a.day_key === dayKey() ? a.day_count || 0 : 0,
    chats: stats.chats || 0,
    chats_today: stats.today || 0,
  };
}

export const businessInfoFromSettings = () => (getSetting('autoReplyInstructions', '') || getSetting('aiInstructions', '') || '').trim();
