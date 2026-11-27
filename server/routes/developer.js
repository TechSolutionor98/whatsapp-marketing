// Developer page (signed in): API keys, a test send, and the recent API requests.
import { Router } from 'express';
import { getLimits } from '../limits.js';
import { listNumbers } from '../numbers.js';
import { ApiError, listKeys, createKey, updateKey, revokeKey, listLogs, sendViaApi, usageToday, PER_MINUTE, MAX_KEYS, apiNumber, sendingSettings, saveSendingSettings, sendingBounds, apiAllowed, queueState, cancelQueued } from '../developer.js';
import { getSetting } from '../db/mongo.js';
import { db, audit, nowIso, oid } from '../db/mongo.js';
import { canLinkNumber } from '../limits.js';
import { startPoolAccount, removePoolAccount } from '../whatsapp/pool.js';

export const developer = Router();

const by = (req) => req.user?.email || '';
function sendError(res, e) {
  if (e instanceof ApiError) return res.status(e.status).json({ error: e.message, code: e.code });
  console.error('  [developer] error:', e?.stack || e);
  res.status(500).json({ error: e?.message || 'Something went wrong' });
}

developer.get('/', async (_req, res) => {
  try {
    const L = getLimits();
    const nums = await listNumbers();
    const q = await queueState();
    res.json({
      enabled: apiAllowed(),
      off_by: !L.allowApi ? 'platform' : getSetting('apiOff', false) ? 'workspace' : null, // who switched it off
      keys: await listKeys(),
      numbers: nums.map((n) => ({ phone: n.phone, label: n.label || '', name: n.name || '', kind: n.kind === 'cloud' ? 'cloud' : 'qr', connected: !!n.connected, default: !!n.default })),
      api_number: await apiNumber(),
      sending: sendingSettings(),
      sending_limits: sendingBounds(), // narrowed by the super admin's rules
      sending_rules: { per_batch: L.apiMaxPerBatch || 0, min_gap: L.apiMinGapSec || 0, max_queue: L.apiMaxQueue || 0 },
      queue: { total: q.total, next_at: q.items[0]?.estimated_send_at || null },
      limits: { perMinute: PER_MINUTE, qrPerDay: L.apiMaxPerNumberDay || 0, maxKeys: MAX_KEYS },
      today: await usageToday(),
    });
  } catch (e) {
    sendError(res, e);
  }
});

developer.post('/keys', async (req, res) => {
  try {
    if (!apiAllowed()) throw new ApiError(403, 'api_disabled', 'The admin has turned off the API.');
    res.json(await createKey(req.body || {}, by(req)));
  } catch (e) {
    sendError(res, e);
  }
});

developer.put('/keys/:id', async (req, res) => {
  try {
    res.json(await updateKey(req.params.id, req.body || {}));
  } catch (e) {
    sendError(res, e);
  }
});

developer.delete('/keys/:id', async (req, res) => {
  try {
    await revokeKey(req.params.id, by(req));
    res.json({ ok: true });
  } catch (e) {
    sendError(res, e);
  }
});

developer.get('/logs', async (req, res) => {
  try {
    res.json(await listLogs(req.query.limit));
  } catch (e) {
    sendError(res, e);
  }
});

// "Send a test message": the same path an API request takes, without needing the key.
developer.post('/test', async (req, res) => {
  try {
    if (!apiAllowed()) throw new ApiError(403, 'api_disabled', 'The admin has turned off the API.');
    const b = req.body || {};
    const key = { _id: 'test', name: 'Developer page test', sender_phone: b.sender && b.sender !== 'default' ? String(b.sender) : null };
    res.json(await sendViaApi(key, { to: b.to, text: b.text, name: b.name }));
  } catch (e) {
    sendError(res, e);
  }
});

// ---- The API number: linked here by QR code, used only for the API ----
developer.get('/number', async (_req, res) => {
  try {
    res.json(await apiNumber());
  } catch (e) {
    sendError(res, e);
  }
});
developer.post('/number', async (req, res) => {
  try {
    const cur = await apiNumber();
    if (cur?.phone) throw new ApiError(400, 'already_linked', `The API number +${cur.phone} is already linked. Unlink it first to use another number.`);
    if (cur) {
      // Linked before but never scanned (or logged out): show a fresh QR code.
      startPoolAccount(cur.id, cur.label, 'api');
      return res.json(await apiNumber());
    }
    const full = await canLinkNumber();
    if (full) throw new ApiError(400, 'limit', full);
    const label = String(req.body?.label || '').trim().slice(0, 40) || 'API number';
    const r = await db.warmupAccounts().insertOne({ label, role: 'api', phone: null, name: null, created_at: nowIso() });
    startPoolAccount(String(r.insertedId), label, 'api');
    audit('connection', `API number added on the Developer page by ${by(req) || 'someone'} — awaiting QR scan`);
    res.json(await apiNumber());
  } catch (e) {
    sendError(res, e);
  }
});
// Reconnect (after the phone was offline or logged out → a new QR code).
developer.post('/number/reconnect', async (_req, res) => {
  try {
    const cur = await apiNumber();
    if (!cur) throw new ApiError(404, 'not_found', 'No API number is linked.');
    startPoolAccount(cur.id, cur.label, 'api');
    res.json(await apiNumber());
  } catch (e) {
    sendError(res, e);
  }
});
developer.delete('/number', async (req, res) => {
  try {
    const cur = await apiNumber();
    if (!cur) return res.json({ ok: true });
    await removePoolAccount(cur.id);
    await db.warmupAccounts().deleteOne({ _id: oid(cur.id) });
    const dropped = cur.phone ? await cancelQueued(null, by(req), { phone: cur.phone }) : 0;
    audit('connection', `API number${cur.phone ? ` +${cur.phone}` : ''} unlinked by ${by(req) || 'someone'}${dropped ? ` — ${dropped} queued message${dropped === 1 ? '' : 's'} cancelled` : ''}`, { level: 'warn' });
    res.json({ ok: true });
  } catch (e) {
    sendError(res, e);
  }
});

// ---- Sending settings + the queue ----
developer.put('/settings', async (req, res) => {
  try {
    res.json(await saveSendingSettings(req.body || {}, by(req)));
  } catch (e) {
    sendError(res, e);
  }
});
developer.get('/queue', async (_req, res) => {
  try {
    res.json(await queueState());
  } catch (e) {
    sendError(res, e);
  }
});
developer.delete('/queue/:id', async (req, res) => {
  try {
    res.json({ ok: true, cancelled: await cancelQueued(req.params.id, by(req)) });
  } catch (e) {
    sendError(res, e);
  }
});
developer.delete('/queue', async (req, res) => {
  try {
    res.json({ ok: true, cancelled: await cancelQueued(null, by(req)) });
  } catch (e) {
    sendError(res, e);
  }
});
