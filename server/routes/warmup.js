import { Router } from 'express';
import { db, audit, setSetting, oid, nowIso, pubList } from '../db/mongo.js';
import { poolState, startPoolAccount, removePoolAccount } from '../whatsapp/pool.js';
import { warmupStatus, runWarmupNow } from '../worker/warmup.js';

export const warmup = Router();

warmup.get('/status', async (_req, res) => {
  const status = await warmupStatus();
  // Conversation-only numbers live in the Conversations tab, not here.
  res.json({ ...status, accounts: poolState().filter((a) => a.role !== 'conversation') });
});

// Add a new number slot — starts a WhatsApp session; the UI then shows its QR to scan.
warmup.post('/accounts', async (req, res) => {
  const label = (req.body?.label || '').trim();
  const r = await db.warmupAccounts().insertOne({
    label,
    phone: null,
    name: null,
    created_at: nowIso(),
  });
  const id = String(r.insertedId);
  startPoolAccount(id, label);
  audit('warmup', 'New warm-up number added — awaiting QR scan');
  res.json({ id, label });
});

warmup.post('/accounts/:id/reconnect', async (req, res) => {
  const doc = await db.warmupAccounts().findOne({ _id: oid(req.params.id) });
  if (!doc) return res.status(404).json({ error: 'Not found' });
  startPoolAccount(req.params.id, doc.label || '');
  res.json({ ok: true });
});

warmup.delete('/accounts/:id', async (req, res) => {
  await removePoolAccount(req.params.id);
  await db.warmupAccounts().deleteOne({ _id: oid(req.params.id) });
  audit('warmup', 'Warm-up number removed');
  res.json({ ok: true });
});

warmup.post('/start', async (_req, res) => {
  const n = await db.warmupAccounts().countDocuments({ role: { $ne: 'conversation' } });
  if (n < 2) return res.status(400).json({ error: 'Link at least 2 numbers for mutual warm-up' });
  await setSetting('warmupActive', true);
  audit('warmup', 'Mutual warm-up started', { level: 'success' });
  res.json({ ok: true });
});

warmup.post('/stop', async (_req, res) => {
  await setSetting('warmupActive', false);
  audit('warmup', 'Warm-up paused');
  res.json({ ok: true });
});

warmup.post('/run', async (_req, res) => {
  res.json(await runWarmupNow());
});

// Recent warm-up conversation entries (for the activity feed).
warmup.get('/log', async (_req, res) => {
  const list = await db.warmupLog().find().sort({ _id: -1 }).limit(40).toArray();
  res.json(pubList(list));
});
