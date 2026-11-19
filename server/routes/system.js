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
import { clampSettings } from '../limits.js';
import { testAiKey } from '../ai.js';

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
// The product feed's login header is only for people who can open Settings. AI keys never leave
// the server: the page only learns whether one is saved and its last 4 characters.
const AI_KEY_PROVIDERS = ['gemini', 'groq', 'custom'];
function keyStatus(keys) {
  return Object.fromEntries(AI_KEY_PROVIDERS.map((p) => {
    const k = typeof keys?.[p] === 'string' ? keys[p] : '';
    return [p, { set: !!k, last4: k ? k.slice(-4) : '' }];
  }));
}
function settingsFor(req) {
  const all = getAllSettings();
  if (req.user?.role !== 'owner' && !req.user?.pages?.includes('settings')) delete all.productFeedHeader;
  all.aiKeyStatus = keyStatus(all.aiKeys);
  delete all.aiKeys;
  return all;
}

// Save (tested first) or remove this workspace's own API key for an AI provider.
system.put('/settings/ai-key', async (req, res) => {
  const provider = String(req.body?.provider || '');
  if (!AI_KEY_PROVIDERS.includes(provider)) return res.status(400).json({ error: 'Pick Gemini, Groq or a custom endpoint' });
  const key = String(req.body?.key ?? '').trim();
  const name = { gemini: 'Gemini', groq: 'Groq', custom: 'the custom endpoint' }[provider];
  const keys = { ...(getAllSettings().aiKeys || {}) };
  if (!key) {
    delete keys[provider];
    await setSetting('aiKeys', keys);
    audit('system', `AI key for ${name} removed by ${req.user?.email || 'unknown'}`);
    return res.json({ ok: true, aiKeyStatus: keyStatus(keys) });
  }
  if (/\s/.test(key) || key.length < 10 || key.length > 400) return res.status(400).json({ error: "That doesn't look like an API key — paste the whole key, without spaces" });
  let test;
  try {
    test = await testAiKey(provider, key);
  } catch (e) {
    return res.status(400).json({ error: `${name[0].toUpperCase() + name.slice(1)} refused this key: ${e.message.replace(/^AI error /, '').slice(0, 200)}` });
  }
  keys[provider] = key;
  await setSetting('aiKeys', keys);
  audit('system', `AI key for ${name} saved by ${req.user?.email || 'unknown'} (…${key.slice(-4)})${test.ok ? ', tested OK' : ' — provider was busy, key not tested'}`);
  res.json({ ok: true, tested: !!test.ok, aiKeyStatus: keyStatus(keys) });
});
system.get('/settings', (req, res) => {
  res.json(settingsFor(req));
});
system.put('/settings', async (req, res) => {
  const body = req.body || {};
  // Values the server keeps for itself — the Settings page sends back everything it loaded,
  // so a stale tab must not overwrite them.
  const SERVER_MANAGED = new Set(['productFeedStatus', 'mainPhone', 'addressBookV2', 'namesV2', 'defaultConvPhone', 'mainConvLabel', 'mainCatalogId', 'sendingPaused', 'teamLocked', 'warmupActive', 'aiKeys', 'aiKeyStatus']);
  const wanted = Object.fromEntries(Object.entries(body).filter(([k]) => !SERVER_MANAGED.has(k) && !k.startsWith('_')));
  // Values outside the super admin's rules are brought inside them (and the page is told why).
  const { settings, notes } = clampSettings(wanted);
  for (const [k, v] of Object.entries(settings)) await setSetting(k, v);
  audit('system', `Settings updated by ${req.user?.email || 'unknown'}${notes.length ? ` (adjusted to the super admin's rules: ${notes.join('; ')})` : ''}`);
  res.json({ ...settingsFor(req), _adjusted: notes });
});
