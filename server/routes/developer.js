// Developer page (signed in): API keys, a test send, and the recent API requests.
import { Router } from 'express';
import { getLimits } from '../limits.js';
import { listNumbers } from '../numbers.js';
import { ApiError, listKeys, createKey, updateKey, revokeKey, listLogs, sendViaApi, usageToday, PER_MINUTE, MAX_KEYS } from '../developer.js';

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
    res.json({
      enabled: !!L.allowApi,
      keys: await listKeys(),
      numbers: nums.map((n) => ({ phone: n.phone, label: n.label || '', name: n.name || '', kind: n.kind === 'cloud' ? 'cloud' : 'qr', connected: !!n.connected, default: !!n.default })),
      limits: { perMinute: PER_MINUTE, qrPerDay: L.apiMaxPerNumberDay || 0, maxKeys: MAX_KEYS },
      today: await usageToday(),
    });
  } catch (e) {
    sendError(res, e);
  }
});

developer.post('/keys', async (req, res) => {
  try {
    if (!getLimits().allowApi) throw new ApiError(403, 'api_disabled', 'The Developer API is switched off by the super admin.');
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
    if (!getLimits().allowApi) throw new ApiError(403, 'api_disabled', 'The Developer API is switched off by the super admin.');
    const b = req.body || {};
    const key = { _id: 'test', name: 'Developer page test', sender_phone: b.sender && b.sender !== 'default' ? String(b.sender) : null };
    res.json(await sendViaApi(key, { to: b.to, text: b.text, name: b.name }));
  } catch (e) {
    sendError(res, e);
  }
});
