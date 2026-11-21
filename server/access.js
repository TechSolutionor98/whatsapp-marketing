// Who may do what. The super admin (role 'owner') can do everything. Everyone else gets the
// pages the super admin gave them (user.pages; missing = every page), checked here on the
// server for every /api request, so hiding a menu item is never the only protection.
import { ObjectId } from 'mongodb';
import { users } from './db/mongo.js';

export const PAGES = ['overview', 'contacts', 'templates', 'campaigns', 'warmup', 'conversations', 'gateway', 'developer', 'audit', 'settings'];
const PAGE_NAMES = {
  overview: 'Overview',
  contacts: 'Contacts & Leads',
  templates: 'Templates',
  campaigns: 'Campaigns',
  warmup: 'Warmup',
  conversations: 'Conversations',
  gateway: 'WhatsApp Gateway',
  developer: 'Developer',
  audit: 'Audit Logs',
  settings: 'Settings',
};

export const isOwner = (u) => u?.role === 'owner';

// The pages a user may open.
export function pagesOf(u) {
  if (!u) return [];
  if (isOwner(u) || !Array.isArray(u.pages)) return [...PAGES];
  return PAGES.filter((p) => u.pages.includes(p));
}

// A page list from the browser → only real page ids; null means "every page".
export function cleanPages(v) {
  if (v === null || v === undefined || v === 'all') return null;
  if (!Array.isArray(v)) return null;
  const set = new Set(v.map(String));
  const out = PAGES.filter((p) => set.has(p));
  return out.length === PAGES.length ? null : out;
}

// Users are read on every request (so a suspension, sign-out or access change applies at
// once); a short cache keeps that cheap. Anything that changes a user calls forgetUser().
const cache = new Map();
const TTL_MS = 5000;
export async function loadUser(uid) {
  const key = String(uid || '');
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.u;
  if (!ObjectId.isValid(key)) return null;
  const u = await users().findOne({ _id: new ObjectId(key) });
  cache.set(key, { u, at: Date.now() });
  return u;
}
export function forgetUser(uid) {
  if (uid) cache.delete(String(uid));
  else cache.clear();
}

// Which pages an /api request belongs to (path is relative to /api). First match wins.
// Shared reads are open to every page that shows that data (e.g. Campaigns lists templates).
const ANY = '*';
const ADMINS = 'admins'; // the Team page: admins of the workspace (the route checks the rest)
const RULES = [
  [ANY, /^\/team(\/|$)/, ADMINS],
  ['GET', /^\/(events|stats|wa\/status|ai\/status|uploads\/)/, ANY],
  ['GET', /^\/overview$/, ['overview']], // sections outside the person's pages are left out
  [ANY, /^\/settings\/ai-key$/, ['settings']], // a workspace's own AI key
  ['GET', /^\/settings$/, ['settings', 'campaigns', 'conversations', 'warmup']],
  ['PUT', /^\/settings$/, ['settings', 'conversations', 'warmup']], // keys checked in settingsKeysAllowed
  ['GET', /^\/(contacts|lists)(\/|$)/, ['contacts', 'campaigns']],
  [ANY, /^\/(contacts|lists)(\/|$)/, ['contacts']],
  ['GET', /^\/templates(\/|$)/, ['templates', 'campaigns']],
  [ANY, /^\/(templates|uploads)(\/|$)/, ['templates']],
  ['POST', /^\/ai\/(draft|rewrite)$/, ['templates', 'settings']],
  ['GET', /^\/campaigns(\/|$)/, ['campaigns', 'overview']],
  [ANY, /^\/(campaigns|worker)(\/|$)/, ['campaigns']],
  ['GET', /^\/conversations\/accounts$/, ['conversations', 'gateway', 'campaigns']],
  [ANY, /^\/conversations\/accounts\/[^/]+\/label$/, ['conversations', 'gateway']],
  [ANY, /^\/conversations\/accounts\/[^/]+\/(autoreply|catalog)$/, ['conversations']],
  ['GET', /^\/conversations\/accounts\/[^/]+\/templates$/, ['campaigns', 'gateway']], // an official number's approved templates
  [ANY, /^\/conversations\/accounts(\/|$)/, ['gateway']], // link, unlink, default, QR
  [ANY, /^\/conversations(\/|$)/, ['conversations']],
  [ANY, /^\/wa\/check\//, ['gateway', 'campaigns', 'contacts']],
  [ANY, /^\/wa\//, ['gateway']],
  ['GET', /^\/catalogs(\/|$)/, ['settings', 'conversations']],
  [ANY, /^\/catalogs(\/|$)/, ['settings']],
  [ANY, /^\/warmup(\/|$)/, ['warmup']],
  ['GET', /^\/audit(\/|$)/, ['audit', 'overview']],
  [ANY, /^\/developer(\/|$)/, ['developer']], // API keys for a POS / website, and the API guide
];

export function pagesFor(method, path) {
  for (const [m, re, pages] of RULES) if ((m === ANY || m === method) && re.test(path)) return pages;
  return null; // not listed → super admin only
}

// Settings a user may change without the Settings page: their own page's settings only.
const PAGE_SETTING_KEYS = {
  warmup: ['warmupDailyStart', 'warmupDailyStep', 'warmupDailyMax', 'warmupMinGap', 'warmupMaxGap', 'warmupWindowStart', 'warmupWindowEnd', 'warmupUseAi'],
  conversations: ['autoReplyMinSec', 'autoReplyMaxSec', 'autoReplyInstructions'],
};
export function settingsKeysAllowed(user, keys) {
  if (isOwner(user) || user.pages?.includes('settings')) return true;
  const ok = new Set(Object.entries(PAGE_SETTING_KEYS).flatMap(([p, k]) => (user.pages?.includes(p) ? k : [])));
  return keys.every((k) => ok.has(k));
}

// Express middleware (after requireAuth): block requests outside the user's pages.
export function checkAccess(req, res, next) {
  const u = req.user;
  if (isOwner(u)) return next();
  if (!Array.isArray(u?.pages)) return res.status(503).json({ error: 'Database unavailable — try again in a moment' });
  if (req.path.startsWith('/admin')) return res.status(403).json({ error: 'Only the super admin can do this', noAccess: true });
  const need = pagesFor(req.method, req.path);
  if (need === ADMINS) {
    if (u.role === 'admin') return next();
    return res.status(403).json({ error: 'Only an admin can manage the team. Ask your admin.', noAccess: true });
  }
  const allowed = need === ANY || (Array.isArray(need) && need.some((p) => u.pages.includes(p)));
  if (!allowed) {
    const page = Array.isArray(need) ? PAGE_NAMES[need[0]] : null;
    return res.status(403).json({ error: page ? `You don't have access to ${page}. Ask the super admin.` : 'Only the super admin can do this', noAccess: true });
  }
  if (req.method === 'PUT' && req.path === '/settings' && !settingsKeysAllowed(u, Object.keys(req.body || {}))) {
    return res.status(403).json({ error: "You don't have access to Settings. Ask the super admin.", noAccess: true });
  }
  next();
}
