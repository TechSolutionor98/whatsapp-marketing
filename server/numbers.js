// The WhatsApp numbers of the current workspace — the list the Gateway page, Conversations tabs,
// campaign "Send from" and the Super Admin page show. The default workspace also has the
// original main number ('main', client.js); every other workspace links its numbers as
// conversation numbers (pool.js) and one of them is its default.
import { db, oid, getSetting } from './db/mongo.js';
import { getWaState } from './whatsapp/client.js';
import { poolState, isAccountConnected } from './whatsapp/pool.js';
import { DEFAULT_WS, currentWs } from './tenant.js';

// Does this workspace have the original main number?
export const hasMain = () => (currentWs() || DEFAULT_WS) === DEFAULT_WS;

// All stored account_ids that belong to the same physical phone as this tab
// (the same WhatsApp number can be linked more than once — main + warm-up, etc.).
export function accountGroup(account) {
  const main = hasMain();
  if (account === 'main' && !main) return { ids: [], includeLegacy: false, phone: null };
  const wa = main ? getWaState() : { me: null };
  const pool = poolState().filter((a) => a.me?.phone); // this workspace's numbers only
  const phoneById = new Map(pool.map((a) => [a.id, a.me.phone]));
  const phone = account === 'main' ? wa.me?.phone || null : phoneById.get(account) || null;

  const ids = new Set([account]);
  let includeLegacy = account === 'main';
  if (phone) {
    if (wa.me?.phone === phone) { ids.add('main'); includeLegacy = true; }
    for (const a of pool) if (a.me.phone === phone) ids.add(a.id);
  }
  return { ids: [...ids], includeLegacy, phone };
}

// The phone a tab belongs to — live if connected, else the last known one (so the tab
// doesn't go blank while a number reconnects after a restart).
export async function tabPhone(account) {
  const { phone } = accountGroup(account);
  if (phone) return phone;
  if (account === 'main') return hasMain() ? getSetting('mainPhone', null) || null : null;
  const _id = oid(account);
  return _id ? (await db.warmupAccounts().findOne({ _id }, { projection: { phone: 1 } }))?.phone || null : null;
}

// The WhatsApp numbers that own conversation tabs — one per unique phone. Built from saved
// accounts so a number shows immediately (as "connecting") after a restart, instead of popping
// in only once its session finishes reconnecting.
export async function listNumbers() {
  const main = hasMain();
  const wa = getWaState();
  const live = new Map(poolState().map((a) => [a.id, a]));
  let docs = [];
  try {
    docs = await db.warmupAccounts().find().toArray();
  } catch {}

  const raw = main
    ? [
        {
          id: 'main',
          label: getSetting('mainConvLabel', '') || 'Main number',
          phone: wa.me?.phone || getSetting('mainPhone', null) || null,
          name: wa.me?.name || '',
          connected: wa.status === 'connected',
          role: 'main',
          auto_reply: !!getSetting('autoReplyEnabled', false),
          catalog_id: getSetting('mainCatalogId', null),
          syncing: !!wa.syncing,
        },
      ]
    : [];
  for (const d of docs) {
    const id = String(d._id);
    const a = live.get(id);
    const role = a?.role || d.role || 'warmup';
    if (role === 'warmup') continue; // warm-up numbers live only in the Warmup page
    const phone = a?.me?.phone || d.phone || null;
    if (!phone) continue; // not linked yet (awaiting first QR scan)
    raw.push({
      id,
      label: a?.label ?? d.label ?? '',
      phone,
      name: a?.me?.name || d.name || '',
      connected: a?.status === 'connected',
      role,
      auto_reply: a ? !!a.auto_reply : !!d.auto_reply,
      catalog_id: d.catalog_id ?? null,
      syncing: !!a?.syncing,
    });
  }

  // Collapse duplicate links of the same number into one tab (prefer main, then a connected/named one).
  const byPhone = new Map();
  for (const acc of raw) {
    const key = acc.phone || acc.id;
    const cur = byPhone.get(key);
    if (!cur) { byPhone.set(key, acc); continue; }
    const merged = {
      auto_reply: cur.auto_reply || acc.auto_reply,
      syncing: cur.syncing || acc.syncing,
      connected: cur.connected || acc.connected,
    };
    let rep = cur;
    if (acc.id === 'main') rep = acc;
    else if (!cur.connected && acc.connected) rep = acc;
    else if (!cur.label && acc.label) rep = { ...cur, label: acc.label };
    byPhone.set(key, { ...rep, ...merged });
  }
  // The default number (picked on the Gateway page) — Conversations opens on it. The first
  // number (main, in the default workspace) if none is picked or that number is gone.
  const list = [...byPhone.values()];
  const defPhone = getSetting('defaultConvPhone', null);
  const def = list.find((a) => defPhone && a.phone === defPhone) || list[0];
  return list.map((a) => ({ ...a, default: a === def }));
}

// The linked session a workspace without a main number sends from when nothing else is
// chosen: its default number if connected, else any connected number (null = none).
export async function defaultSenderId() {
  const list = await listNumbers();
  const order = [...list.filter((n) => n.default), ...list.filter((n) => !n.default)];
  for (const n of order) {
    const id = accountGroup(n.id).ids.find((x) => x !== 'main' && isAccountConnected(x));
    if (id) return id;
  }
  return null;
}
