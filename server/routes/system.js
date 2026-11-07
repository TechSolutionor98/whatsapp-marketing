import { Router } from 'express';
import { db, getAllSettings, setSetting, audit, pubList, dayKey } from '../db/mongo.js';
import {
  getWaState,
  connectWhatsApp,
  logoutWhatsApp,
  checkOnWhatsApp,
} from '../whatsapp/client.js';
import { runCycleNow, setPaused, isPaused } from '../worker/sender.js';

export const system = Router();

// ---- WhatsApp gateway ----
system.get('/wa/status', (_req, res) => {
  res.json({ ...getWaState(), workerPaused: isPaused() });
});
system.post('/wa/connect', (_req, res) => {
  connectWhatsApp();
  res.json({ ok: true });
});
system.post('/wa/logout', async (_req, res) => {
  await logoutWhatsApp();
  res.json({ ok: true });
});
system.get('/wa/check/:phone', async (req, res) => {
  res.json(await checkOnWhatsApp(req.params.phone));
});

// ---- Worker ----
system.post('/worker/cycle', async (_req, res) => {
  res.json(await runCycleNow());
});
system.post('/worker/pause', (req, res) => {
  setPaused(!!req.body.paused);
  audit('system', req.body.paused ? 'Worker paused globally' : 'Worker resumed');
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
system.get('/settings', (_req, res) => {
  res.json(getAllSettings());
});
system.put('/settings', async (req, res) => {
  const body = req.body || {};
  for (const [k, v] of Object.entries(body)) await setSetting(k, v);
  audit('system', 'Settings updated');
  res.json(getAllSettings());
});
