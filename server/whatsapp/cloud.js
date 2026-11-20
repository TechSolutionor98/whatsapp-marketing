// Official WhatsApp numbers (Meta WhatsApp Cloud API): connecting one, Meta's webhook (messages
// people send + delivery/read receipts), approved templates, and the 24-hour reply window.
// Incoming messages go through the same pipeline as QR-linked numbers (pool.js ingest):
// contact, chat, opt-out words, AI auto-reply, hand-off to a person.
import crypto from 'node:crypto';
import { col, db, audit, nowIso, isMongoUp, oid } from '../db/mongo.js';
import { DEFAULT_WS, currentWs, runInWs } from '../tenant.js';
import { emit } from '../events.js';
import { applyReceipt } from '../receipts.js';
import { renderTemplate } from '../utils.js';
import { accountByPhoneNumberId, ingestCloud, registerCloudAccount, cloudAccountOf } from './pool.js';
import { verifyCloudNumber, listCloudTemplates, downloadCloudMedia, explainMetaError } from './cloud-api.js';

const digits = (v) => String(v || '').replace(/\D/g, '');

// ---- Connecting a number ----

function cleanInput(b = {}) {
  const out = {
    label: String(b.label || '').trim().slice(0, 60),
    phoneNumberId: digits(b.phoneNumberId),
    wabaId: digits(b.wabaId),
    token: String(b.token || '').trim(),
    appSecret: String(b.appSecret || '').trim(),
  };
  return out;
}

// What the Gateway page may show about an official number (never the token or app secret).
export function cloudPublic(d) {
  const c = d?.cloud || {};
  return {
    phone_number_id: c.phone_number_id || '',
    waba_id: c.waba_id || '',
    display_phone: c.display_phone || '',
    verified_name: c.verified_name || '',
    quality: c.quality || '',
    subscribed: c.subscribed !== false,
    subscribe_error: c.subscribe_error || '',
    webhook_verified_at: c.webhook_verified_at || null,
    last_event_at: c.last_event_at || null,
    checked_at: c.checked_at || null,
    error: c.error || '',
    token_last4: c.token ? String(c.token).slice(-4) : '',
  };
}

export async function connectCloudNumber(body) {
  const b = cleanInput(body);
  if (!b.phoneNumberId) throw new Error('Enter the Phone number ID (Meta → WhatsApp → API Setup)');
  if (!b.wabaId) throw new Error('Enter the WhatsApp Business Account ID (Meta → WhatsApp → API Setup)');
  if (b.token.length < 20) throw new Error('Paste the access token');
  if (b.appSecret.length < 16) throw new Error('Paste the App secret (Meta → App settings → Basic). It proves incoming messages really come from Meta.');
  const taken = await col('warmup_accounts').findOne({ kind: 'cloud', 'cloud.phone_number_id': b.phoneNumberId }, { projection: { _id: 1 } });
  if (taken) throw new Error('This official number is already connected (here or in another workspace).');

  const info = await verifyCloudNumber({ phoneNumberId: b.phoneNumberId, wabaId: b.wabaId, token: b.token });
  if (!info.phone) throw new Error("Meta didn't return this number's phone number. Check the Phone number ID.");
  const now = nowIso();
  const doc = {
    label: b.label,
    role: 'conversation',
    kind: 'cloud',
    phone: info.phone,
    name: info.verifiedName,
    auto_reply: false,
    created_at: now,
    cloud: {
      phone_number_id: b.phoneNumberId,
      waba_id: b.wabaId,
      token: b.token,
      app_secret: b.appSecret,
      verify_token: crypto.randomBytes(18).toString('base64url'),
      display_phone: info.displayPhone,
      verified_name: info.verifiedName,
      quality: info.quality,
      subscribed: info.subscribed,
      subscribe_error: info.subscribeError,
      checked_at: now,
      error: '',
    },
  };
  const r = await db.warmupAccounts().insertOne(doc);
  doc._id = r.insertedId;
  registerCloudAccount({ ...doc, ws: currentWs() || DEFAULT_WS });
  audit('connection', `Official WhatsApp number connected: +${info.phone}${info.verifiedName ? ` (${info.verifiedName})` : ''}`, { level: 'success' });
  return { id: String(r.insertedId), phone: info.phone, ...cloudPublic(doc), verify_token: doc.cloud.verify_token };
}

// Replace the token and/or app secret (tokens from Meta's "API Setup" page expire in 24 hours).
export async function updateCloudNumber(id, body) {
  const _id = oid(id);
  const d = _id ? await db.warmupAccounts().findOne({ _id, kind: 'cloud' }) : null;
  if (!d) throw new Error('Not found');
  const b = cleanInput(body);
  const token = b.token || d.cloud.token;
  const appSecret = b.appSecret || d.cloud.app_secret;
  if (b.token && b.token.length < 20) throw new Error('Paste the whole access token');
  if (b.appSecret && b.appSecret.length < 16) throw new Error('Paste the whole App secret');
  const info = await verifyCloudNumber({ phoneNumberId: d.cloud.phone_number_id, wabaId: d.cloud.waba_id, token });
  const set = {
    'cloud.token': token,
    'cloud.app_secret': appSecret,
    'cloud.verified_name': info.verifiedName,
    'cloud.quality': info.quality,
    'cloud.subscribed': info.subscribed,
    'cloud.subscribe_error': info.subscribeError,
    'cloud.checked_at': nowIso(),
    'cloud.error': '',
    name: info.verifiedName,
  };
  await db.warmupAccounts().updateOne({ _id }, { $set: set });
  registerCloudAccount({ ...(await db.warmupAccounts().findOne({ _id })), ws: currentWs() || DEFAULT_WS });
  audit('connection', `Official number +${d.phone}: credentials updated`);
  return cloudPublic(await db.warmupAccounts().findOne({ _id }));
}

export async function cloudDetails(id) {
  const _id = oid(id);
  const d = _id ? await db.warmupAccounts().findOne({ _id, kind: 'cloud' }) : null;
  if (!d) return null;
  return { id: String(d._id), phone: d.phone, ...cloudPublic(d), verify_token: d.cloud?.verify_token || '' };
}

// ---- Meta's webhook ----

// GET: Meta checks the callback URL with the verify token shown on the Gateway page.
export async function verifyWebhook(q = {}) {
  if (q['hub.mode'] !== 'subscribe' || !isMongoUp()) return null;
  const token = String(q['hub.verify_token'] || '');
  if (!token) return null;
  const docs = await col('warmup_accounts').find({ kind: 'cloud', 'cloud.verify_token': token }, { projection: { ws: 1 } }).toArray();
  if (!docs.length) return null;
  await col('warmup_accounts').updateMany({ kind: 'cloud', 'cloud.verify_token': token }, { $set: { 'cloud.webhook_verified_at': nowIso() } });
  for (const d of docs) emit('pool:update', {}, { ws: d.ws || DEFAULT_WS });
  return String(q['hub.challenge'] ?? '');
}

// Meta signs every POST with the app secret: X-Hub-Signature-256: sha256=<hmac of the raw body>.
function signatureOk(raw, header, secret) {
  if (!secret || typeof header !== 'string' || !header.startsWith('sha256=')) return false;
  const want = Buffer.from(crypto.createHmac('sha256', secret).update(raw).digest('hex'));
  const got = Buffer.from(header.slice(7).trim().toLowerCase());
  return got.length === want.length && crypto.timingSafeEqual(got, want);
}

let chain = Promise.resolve(); // webhook work runs in order, after Meta already got its 200
export const settleWebhooks = () => chain;
const lastMark = new Map();
const badSigNoted = new Map();

// POST: returns the HTTP status to answer with. Only entries for our numbers whose signature
// checks out are processed; the work happens after the 200 (Meta wants a quick answer).
export async function receiveWebhook(raw, sigHeader) {
  let body;
  try {
    body = JSON.parse(raw.toString('utf8'));
  } catch {
    return 400;
  }
  if (body?.object !== 'whatsapp_business_account') return 200;
  const work = [];
  let bad = 0;
  for (const entry of body.entry || []) {
    for (const ch of entry.changes || []) {
      if (ch.field !== 'messages') continue;
      const v = ch.value || {};
      const pnid = String(v.metadata?.phone_number_id || '');
      if (!pnid) continue;
      const doc = await col('warmup_accounts').findOne({ kind: 'cloud', 'cloud.phone_number_id': pnid });
      if (!doc) continue; // not one of our numbers (or unlinked)
      if (!signatureOk(raw, sigHeader, doc.cloud?.app_secret)) {
        bad++;
        const k = String(doc._id);
        if (Date.now() - (badSigNoted.get(k) || 0) > 3600e3) {
          badSigNoted.set(k, Date.now());
          audit('connection', `Official number +${doc.phone}: a webhook message was rejected because its signature didn't match. Check the App secret on the WhatsApp Gateway page.`, { level: 'warn', ws: doc.ws || DEFAULT_WS });
        }
        continue;
      }
      work.push([doc, v]);
    }
  }
  if (bad && !work.length) return 401;
  chain = chain
    .then(async () => {
      for (const [doc, v] of work) {
        await runInWs(doc.ws || DEFAULT_WS, () => handleValue(doc, v)).catch((e) =>
          audit('system', `Official number webhook error: ${e.message}`, { level: 'error', ws: doc.ws || DEFAULT_WS })
        );
      }
    })
    .catch(() => {});
  return 200;
}

// A Cloud API message → the shape the shared inbound pipeline reads (Baileys message content).
function toContent(m) {
  const mime = (o) => o?.mime_type || '';
  switch (m.type) {
    case 'text':
      return { conversation: m.text?.body || '' };
    case 'image':
      return { imageMessage: { caption: m.image?.caption || '', mimetype: mime(m.image) } };
    case 'video':
      return { videoMessage: { caption: m.video?.caption || '', mimetype: mime(m.video) } };
    case 'audio':
      return { audioMessage: { ptt: !!m.audio?.voice, mimetype: mime(m.audio) } };
    case 'document':
      return { documentMessage: { fileName: m.document?.filename || '', caption: m.document?.caption || '', mimetype: mime(m.document) } };
    case 'sticker':
      return { stickerMessage: { mimetype: mime(m.sticker) } };
    case 'location':
      return { locationMessage: { degreesLatitude: m.location?.latitude, degreesLongitude: m.location?.longitude, name: m.location?.name || m.location?.address || '' } };
    case 'contacts':
      return { contactMessage: { displayName: m.contacts?.[0]?.name?.formatted_name || '' } };
    case 'button': // tap on a template's quick-reply button
      return { conversation: m.button?.text || m.button?.payload || '' };
    case 'interactive':
      return { conversation: m.interactive?.button_reply?.title || m.interactive?.list_reply?.title || '' };
    case 'reaction':
      return { reactionMessage: { key: { id: m.reaction?.message_id }, text: m.reaction?.emoji || '' } };
    default:
      return null; // unsupported / system notices
  }
}
const MEDIA_TYPES = ['image', 'video', 'audio', 'document', 'sticker'];

async function handleValue(doc, v) {
  const id = String(doc._id);
  if (!accountByPhoneNumberId(doc.cloud.phone_number_id)) registerCloudAccount(doc);
  if (Date.now() - (lastMark.get(id) || 0) > 60e3) {
    lastMark.set(id, Date.now());
    await col('warmup_accounts').updateOne({ _id: doc._id }, { $set: { 'cloud.last_event_at': nowIso() } });
  }

  for (const s of v.statuses || []) await applyStatus(s);

  const names = new Map((v.contacts || []).map((c) => [String(c.wa_id), c.profile?.name || '']));
  const messages = [];
  const media = [];
  for (const m of v.messages || []) {
    const message = toContent(m);
    if (!message || !m.id || !m.from) continue;
    messages.push({
      key: { remoteJid: `${digits(m.from)}@s.whatsapp.net`, id: m.id, fromMe: false },
      message,
      pushName: names.get(String(m.from)) || '',
      messageTimestamp: Number(m.timestamp) || 0,
    });
    if (MEDIA_TYPES.includes(m.type) && m[m.type]?.id) media.push([m.id, m[m.type].id, m[m.type].mime_type || '']);
  }
  if (messages.length) await ingestCloud(id, { messages, type: 'notify' });
  // Their files download through Meta (not WhatsApp Web), by media id.
  for (const [waId, mediaId, mime] of media) {
    await db.messages().updateOne({ wa_message_id: waId }, { $set: { cloud_media_id: mediaId, media: 1, ...(mime ? { mime } : {}) }, $unset: { media_raw: '' } });
  }
}

// Delivery receipts: sent → delivered → read (never downgraded), or failed with Meta's reason.
async function applyStatus(s) {
  if (!s?.id) return;
  const code = { sent: 2, delivered: 3, read: 4 }[s.status];
  if (code) return applyReceipt(s.id, code);
  if (s.status !== 'failed') return;
  const e = s.errors?.[0] || {};
  const why = explainMetaError({ code: e.code, message: e.title || e.message, error_data: e.error_data });
  const r = await db.messages().updateOne(
    { wa_message_id: s.id, direction: 'out', $or: [{ status_code: { $exists: false } }, { status_code: { $lt: 3 } }] },
    { $set: { status: 'failed', error_code: e.code ? String(e.code) : '', error: why } }
  );
  await db.targets().updateOne({ wa_message_id: s.id, status: 'sent' }, { $set: { status: 'failed', error: why } });
  if (r.modifiedCount) {
    audit('send', `WhatsApp couldn't deliver a message to +${s.recipient_id || '?'}: ${why}`, { level: 'warn' });
    emit('message:status', { waId: s.id });
    emit('stats:dirty', {});
  }
}

// ---- Media people sent to an official number ----
export async function downloadCloudStored(doc) {
  const acc = cloudAccountOf(doc.account_id);
  if (!acc) throw new Error('The official number that received this file is no longer connected');
  const { buffer } = await downloadCloudMedia(acc, doc.cloud_media_id);
  return buffer;
}

// ---- The 24-hour window ----
// Outside 24 hours after the person's last message, Meta only delivers approved templates.
export const WINDOW_MS = 24 * 3600 * 1000;
export async function replyWindowOpen(contactId, phone) {
  const last = await db
    .messages()
    .find({ contact_id: String(contactId), direction: 'in', ...(phone ? { account_phone: phone } : {}) }, { projection: { created_at: 1 } })
    .sort({ created_at: -1 })
    .limit(1)
    .toArray();
  const t = Date.parse(last[0]?.created_at || '');
  return Number.isFinite(t) && Date.now() - t < WINDOW_MS;
}

// ---- Approved templates (campaigns from an official number send these) ----
const VAR_RX = /\{\{\s*([A-Za-z0-9_]+)\s*\}\}/g;
const varsOf = (txt) => [...new Set([...String(txt || '').matchAll(VAR_RX)].map((m) => m[1]))];
const MEDIA_HEADERS = ['IMAGE', 'VIDEO', 'DOCUMENT'];

export function templateShape(t) {
  const comps = t.components || [];
  const header = comps.find((c) => c.type === 'HEADER') || null;
  const body = comps.find((c) => c.type === 'BODY') || null;
  const footer = comps.find((c) => c.type === 'FOOTER') || null;
  const buttons = comps.find((c) => c.type === 'BUTTONS')?.buttons || [];
  const bodyVars = varsOf(body?.text);
  const headerVars = header?.format === 'TEXT' ? varsOf(header.text) : [];
  let unsupported = '';
  if (header && !['TEXT', ...MEDIA_HEADERS].includes(header.format)) unsupported = `a ${String(header.format || '').toLowerCase()} header`;
  for (const b of buttons) {
    if (b.type === 'URL' && /\{\{/.test(b.url || '')) unsupported = 'a button whose link has a variable';
    else if (!['QUICK_REPLY', 'URL', 'PHONE_NUMBER'].includes(b.type)) unsupported = `a "${String(b.type || '').toLowerCase().replace(/_/g, ' ')}" button`;
  }
  if (comps.some((c) => !['HEADER', 'BODY', 'FOOTER', 'BUTTONS'].includes(c.type))) unsupported = 'a carousel or special layout';
  return {
    name: t.name,
    language: t.language,
    category: t.category || '',
    status: t.status || '',
    header: header ? { format: header.format, text: header.text || '' } : null,
    body: body?.text || '',
    footer: footer?.text || '',
    buttons: buttons.map((b) => ({ type: b.type, text: b.text || '' })),
    bodyVars,
    headerVars,
    named: [...bodyVars, ...headerVars].some((k) => !/^\d+$/.test(k)),
    unsupported,
  };
}

export async function templatesFor(accountId) {
  const acc = cloudAccountOf(accountId);
  if (!acc) throw new Error('That is not an official WhatsApp API number');
  const list = await listCloudTemplates(acc);
  return list.filter((t) => t.status === 'APPROVED').map(templateShape);
}

// Check what a campaign asked for against Meta's approved templates and keep a clean copy.
export async function prepareCloudTemplate(accountId, input = {}) {
  const name = String(input.name || '');
  const language = String(input.language || '');
  if (!name || !language) throw new Error('Pick an approved WhatsApp template');
  const acc = cloudAccountOf(accountId);
  if (!acc) throw new Error('The sending number is not an official WhatsApp API number');
  const found = (await listCloudTemplates(acc)).find((t) => t.name === name && t.language === language);
  if (!found || found.status !== 'APPROVED') throw new Error(`The template "${name}" (${language}) isn't approved for this number's WhatsApp Business Account`);
  const shape = templateShape(found);
  if (shape.unsupported) throw new Error(`Templates with ${shape.unsupported} can't be sent from here yet. Pick another template.`);
  const fill = (vars, vals, where) =>
    vars.map((k, i) => {
      const v = String(vals?.[i] ?? '').trim().slice(0, 1000);
      if (!v) throw new Error(`Fill in {{${k}}} in the template's ${where}`);
      return v;
    });
  const out = { ...shape, body_params: fill(shape.bodyVars, input.body_params, 'text'), header_params: fill(shape.headerVars, input.header_params, 'header'), header_link: '' };
  if (MEDIA_HEADERS.includes(shape.header?.format)) {
    const link = String(input.header_link || '').trim();
    if (!/^https:\/\/\S+$/i.test(link)) throw new Error(`This template starts with a ${shape.header.format.toLowerCase()}. Paste a public https:// link to it.`);
    out.header_link = link;
  }
  return out;
}

// The components Meta needs for one person, and the text to show in the chat.
export function buildTemplateSend(tpl, contact) {
  const val = (s) => renderTemplate(String(s || ''), contact) || '-';
  const param = (k, text) => (tpl.named ? { type: 'text', parameter_name: k, text } : { type: 'text', text });
  const fillText = (txt, vars, vals) => vars.reduce((t, k, i) => t.replace(new RegExp(`\\{\\{\\s*${k}\\s*\\}\\}`, 'g'), vals[i]), String(txt || ''));
  const components = [];
  let headerText = '';
  if (tpl.header?.format === 'TEXT') {
    const vals = (tpl.headerVars || []).map((_, i) => val(tpl.header_params?.[i]));
    if (vals.length) components.push({ type: 'header', parameters: tpl.headerVars.map((k, i) => param(k, vals[i])) });
    headerText = fillText(tpl.header.text, tpl.headerVars || [], vals);
  } else if (MEDIA_HEADERS.includes(tpl.header?.format)) {
    const k = tpl.header.format.toLowerCase();
    components.push({ type: 'header', parameters: [{ type: k, [k]: { link: tpl.header_link } }] });
  }
  const bodyVals = (tpl.bodyVars || []).map((_, i) => val(tpl.body_params?.[i]));
  if (bodyVals.length) components.push({ type: 'body', parameters: tpl.bodyVars.map((k, i) => param(k, bodyVals[i])) });
  const text = [headerText ? `*${headerText}*` : '', fillText(tpl.body, tpl.bodyVars || [], bodyVals), tpl.footer ? `_${tpl.footer}_` : ''].filter(Boolean).join('\n\n');
  return { components, text };
}

