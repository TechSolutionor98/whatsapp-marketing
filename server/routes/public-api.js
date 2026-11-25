// The public Developer API (/api/v1): software sends with an API key from the Developer page,
// never with a signed-in session. Every answer is JSON; errors are
// { "error": { "code": "…", "message": "…" } } with a matching HTTP status.
import express, { Router } from 'express';
import { isMongoUp, workspaceOf } from '../db/mongo.js';
import { runInWs } from '../tenant.js';
import { getLimits } from '../limits.js';
import { ApiError, findKey, rateLimited, touchKey, logRequest, sendViaApi, messageById, messageByReference, resolveSender, sendingSettings, PER_MINUTE } from '../developer.js';
import { normalizePhone } from '../utils.js';

export const publicApi = Router();

function sendError(res, e) {
  const status = e instanceof ApiError ? e.status : 500;
  const code = e instanceof ApiError ? e.code : 'server_error';
  const message = e instanceof ApiError ? e.message : 'Something went wrong on our side. Try again in a moment.';
  if (!(e instanceof ApiError)) console.error('  [api] error:', e?.stack || e);
  res.status(status).json({ error: { code, message, ...(e?.extra || {}) } });
  return { status, code, message };
}

// The key → its workspace. Everything after this runs inside that workspace.
publicApi.use(async (req, res, next) => {
  res.set('Cache-Control', 'no-store');
  const started = Date.now();
  const deny = (status, code, message, headers) => {
    if (headers) res.set(headers);
    sendError(res, new ApiError(status, code, message));
  };
  if (!isMongoUp()) return deny(503, 'unavailable', 'The service is starting up. Try again in a moment.');
  const h = String(req.get('authorization') || '');
  const raw = h.toLowerCase().startsWith('bearer ') ? h.slice(7).trim() : String(req.get('x-api-key') || '').trim();
  if (!raw) return deny(401, 'missing_api_key', 'Add your API key in the Authorization header: "Authorization: Bearer twa_live_…". Create a key on the Developer page.');
  let key;
  try {
    key = await findKey(raw);
  } catch {
    return deny(503, 'unavailable', 'The service is busy. Try again in a moment.');
  }
  if (!key) return deny(401, 'invalid_api_key', "This API key isn't valid. It may have been deleted. Create a new one on the Developer page.");
  const w = workspaceOf(key.ws);
  if (!w) return deny(401, 'invalid_api_key', "This API key isn't valid any more.");
  if (w.pending) return deny(403, 'workspace_pending', `${w.name} is waiting for approval. The API works once it's approved.`);
  if (w.suspended) return deny(403, 'workspace_suspended', `${w.name} is suspended, so the API can't send. Contact the platform admin.`);
  if (!getLimits().allowApi) return deny(403, 'api_disabled', 'The Developer API is switched off by the platform admin.');
  const wait = rateLimited(key._id);
  if (wait) return deny(429, 'rate_limited', `Too many requests: a key can make ${PER_MINUTE} a minute. Try again in ${wait} seconds.`, { 'Retry-After': String(wait) });
  touchKey(key);
  req.apiKey = key;
  req.started = started;
  runInWs(key.ws, next);
});

// The body is read only after the key checks out: JSON (25 MB leaves room for a base64 PDF) or
// a plain form post.
publicApi.use(express.json({ limit: '25mb', type: ['application/json', 'application/*+json', 'text/plain'] }));
publicApi.use(express.urlencoded({ extended: true, limit: '25mb' }));

// Log what happened (POSTs always; reads only when they fail, so polling doesn't flood the log).
function log(req, http, extra = {}) {
  if (req.method === 'GET' && http < 400) return;
  logRequest({
    key_id: String(req.apiKey._id),
    key_name: req.apiKey.name,
    method: req.method,
    path: req.originalUrl.split('?')[0].slice(0, 120),
    http,
    ms: Date.now() - req.started,
    ...extra,
  });
}

// Is the key working, and which number will it send from?
publicApi.get('/me', async (req, res) => {
  try {
    const w = workspaceOf(req.apiKey.ws);
    const n = await resolveSender(req.apiKey.sender_phone || null, { soft: true });
    const L = getLimits();
    res.json({
      workspace: w?.name || '',
      key: { name: req.apiKey.name, prefix: req.apiKey.prefix },
      number: n ? { phone: n.phone, label: n.label, type: n.kind === 'cloud' ? 'official' : 'qr', connected: n.connected, api_only: !!n.api } : null,
      limits: { requests_per_minute: PER_MINUTE, messages_per_day: n?.kind === 'qr' && L.apiMaxPerNumberDay > 0 ? L.apiMaxPerNumberDay : null },
      sending: (({ per_batch, gap_seconds, max_queue }) => ({ messages_per_batch: per_batch, seconds_between_batches: gap_seconds, max_queue }))(sendingSettings()),
    });
  } catch (e) {
    const r = sendError(res, e);
    log(req, r.status, { code: r.code, message: r.message });
  }
});

// Send a message: text, a document (PDF receipt) or an image, or an approved template.
publicApi.post('/messages', async (req, res) => {
  const b = req.body && typeof req.body === 'object' ? req.body : {};
  const to = normalizePhone(b.to ?? b.phone) || null;
  const type = b.template ? 'template' : b.document ? 'document' : b.image ? 'image' : 'text';
  const reference = b.reference != null ? String(b.reference).slice(0, 100) : null;
  try {
    const m = await sendViaApi(req.apiKey, b);
    // 201 sent · 202 accepted and waiting in the queue (sending settings) · 200 a duplicate
    const http = m.duplicate ? 200 : m.status === 'queued' ? 202 : 201;
    res.status(http).json(m);
    log(req, http, { code: m.duplicate ? 'duplicate' : m.status === 'queued' ? 'queued' : 'ok', to, type: m.type, reference, message_id: m.id });
  } catch (e) {
    const r = sendError(res, e);
    log(req, r.status, { code: r.code, message: r.message, to, type, reference });
  }
});

// A message's delivery status: by id, or ?reference=<your receipt number>.
publicApi.get('/messages', async (req, res) => {
  try {
    const ref = String(req.query.reference || '').trim();
    if (!ref) throw new ApiError(400, 'missing_reference', 'Add ?reference=<the reference you sent>, or use /messages/<id>.');
    const m = await messageByReference(ref);
    if (!m) throw new ApiError(404, 'not_found', `No message was sent with the reference "${ref}".`);
    res.json(m);
  } catch (e) {
    const r = sendError(res, e);
    log(req, r.status, { code: r.code, message: r.message });
  }
});
publicApi.get('/messages/:id', async (req, res) => {
  try {
    const m = await messageById(req.params.id);
    if (!m) throw new ApiError(404, 'not_found', 'No message with that id was sent through the API in this workspace.');
    res.json(m);
  } catch (e) {
    const r = sendError(res, e);
    log(req, r.status, { code: r.code, message: r.message });
  }
});

publicApi.use((req, res) => {
  sendError(res, new ApiError(404, 'not_found', `There's no ${req.method} ${req.originalUrl.split('?')[0]}. See the API reference on the Developer page.`));
});

// Bad JSON, a body that's too big, …
// eslint-disable-next-line no-unused-vars
publicApi.use((err, req, res, _next) => {
  if (err?.type === 'entity.too.large') return sendError(res, new ApiError(413, 'file_too_large', 'The request is larger than 25 MB. Send big files as a link ("url") instead of base64.'));
  if (err?.type === 'entity.parse.failed') return sendError(res, new ApiError(400, 'invalid_json', "The body isn't valid JSON. Check quotes and commas, and send Content-Type: application/json."));
  sendError(res, err);
});
