import { Router } from 'express';
import { db, getAllSettings, setSetting, audit, pubList, dayKey } from '../db/mongo.js';
import {
  getWaState,
  connectWhatsApp,
  logoutWhatsApp,
  checkOnWhatsApp,
} from '../whatsapp/client.js';
import { checkOnWhatsAppVia } from '../whatsapp/pool.js';
import { runCycleNow, setPaused, isPaused } from '../worker/sender.js';
import { hasMain, listNumbers, defaultSenderId } from '../numbers.js';

export const system = Router();

// ---- WhatsApp gateway ----
// The default workspace: its original main number. Any other workspace: a summary of its own
// numbers (the default one first) — it never sees or controls the main number.
system.get('/wa/status', async (_req, res) => {
  if (hasMain()) return res.json({ ...getWaState(), main: true, workerPaused: isPaused() });
  const nums = await listNumbers();
  const def = nums.find((n) => n.default) || null;
  const shown = def?.connected ? def : nums.find((n) => n.connected) || def;
  res.json({
    status: shown?.connected ? 'connected' : nums.length ? 'connecting' : 'disconnected',
    qr: null,
    me: shown ? { phone: shown.phone, name: shown.label || shown.name || '' } : null,
    lastError: null,
    syncing: !!shown?.syncing,
    main: false,
    numbers: nums.length,
    workerPaused: isPaused(),
  });
});
const noMain = (res) => res.status(400).json({ error: 'Link your numbers under "Your WhatsApp numbers" on this page' });
system.post('/wa/connect', (_req, res) => {
  if (!hasMain()) return noMain(res);
  connectWhatsApp();
  res.json({ ok: true });
});
system.post('/wa/logout', async (_req, res) => {
  if (!hasMain()) return noMain(res);
  await logoutWhatsApp();
  res.json({ ok: true });
});
system.get('/wa/check/:phone', async (req, res) => {
  if (hasMain()) return res.json(await checkOnWhatsApp(req.params.phone));
  const id = await defaultSenderId();
  res.json(id ? await checkOnWhatsAppVia(id, req.params.phone) : { exists: false, reason: 'not_connected' });
});

// ---- Worker ----
system.post('/worker/cycle', async (_req, res) => {
  res.json(await runCycleNow());
});
system.post('/worker/pause', (req, res) => {
  setPaused(!!req.body.paused);
  audit('system', `${req.body.paused ? 'Campaign sending paused' : 'Campaign sending resumed'} by ${req.user?.email || 'unknown'}`);
  res.json({ paused: isPaused() });
});

// ---- Overview stats ----
system.get('/stats', async (_req, res) => {
  try {
    const C = db.contacts();
    const M = db.messages();
    const T = db.targets();
    const [
      totalLeads,
      messagesSent,
      handoffs,
      failed,
      bounced,
      replies,
      optedOut,
      queued,
      sentToday,
    ] = await Promise.all([
      C.countDocuments({ status: 'active', synced: { $ne: 1 }, warmup: { $ne: 1 } }),
      M.countDocuments({ direction: 'out' }),
      C.countDocuments({ handoff: 1 }),
      T.countDocuments({ status: 'failed' }),
      C.countDocuments({ status: 'bounced' }),
      M.countDocuments({ direction: 'in' }),
      C.countDocuments({ status: 'opted_out' }),
      T.countDocuments({ status: 'queued' }),
      M.countDocuments({ direction: 'out', day_key: dayKey() }),
    ]);
    res.json({
      totalLeads,
      messagesSent,
      handoffs,
      failedBounced: failed + bounced,
      replies,
      optedOut,
      queued,
      sentToday,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ---- Audit logs ----
system.get('/audit', async (req, res) => {
  const { type = '', level = '', limit = 200 } = req.query;
  const filter = {};
  if (type) filter.type = type;
  if (level) filter.level = level;
  const list = await db
    .auditLogs()
    .find(filter)
    .sort({ _id: -1 })
    .limit(Number(limit))
    .toArray();
  res.json(pubList(list));
});

// ---- Settings ----
// The product feed's login header is only for people who can open Settings.
function settingsFor(req) {
  const all = getAllSettings();
  if (req.user?.role !== 'owner' && !req.user?.pages?.includes('settings')) delete all.productFeedHeader;
  return all;
}
system.get('/settings', (req, res) => {
  res.json(settingsFor(req));
});
system.put('/settings', async (req, res) => {
  const body = req.body || {};
  // Values the server keeps for itself — the Settings page sends back everything it loaded,
  // so a stale tab must not overwrite them.
  const SERVER_MANAGED = new Set(['productFeedStatus', 'mainPhone', 'addressBookV2', 'namesV2', 'defaultConvPhone', 'mainConvLabel', 'mainCatalogId', 'sendingPaused', 'teamLocked', 'warmupActive']);
  for (const [k, v] of Object.entries(body)) if (!SERVER_MANAGED.has(k)) await setSetting(k, v);
  audit('system', `Settings updated by ${req.user?.email || 'unknown'}`);
  res.json(settingsFor(req));
});
