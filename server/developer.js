// Developer API: a business's own software (a POS, a website, a CRM) sends WhatsApp messages
// through the numbers it linked here, whether scanned by QR or connected through the official
// API. Typical case: a POS "Send receipt on WhatsApp" button. The business creates an API key on
// the Developer page and its software calls
//   POST /api/v1/messages      Authorization: Bearer <key>
// with the customer's number and a text, a PDF/image (a link or base64) or, for an official
// number outside the 24-hour window, a Meta-approved template.
// Keys are stored only as a SHA-256 hash; the key itself is shown once, when it's created.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import https from 'node:https';
import dns from 'node:dns';
import net from 'node:net';
import { DATA_DIR } from './config.js';
import { db, col, audit, oid, nowIso, dayKey } from './db/mongo.js';
import { emit } from './events.js';
import { currentWs } from './tenant.js';
import { getLimits } from './limits.js';
import { listNumbers, accountGroup, hasMain } from './numbers.js';
import { isConnected as mainConnected, checkOnWhatsApp, sendContent } from './whatsapp/client.js';
import { isAccountConnected, checkOnWhatsAppVia, sendContentFromTo, accountKind, cloudAccountOf } from './whatsapp/pool.js';
import { sendCloudText, sendCloudMedia, uploadCloudMedia, sendCloudTemplate, listCloudTemplates } from './whatsapp/cloud-api.js';
import { replyWindowOpen, templateShape } from './whatsapp/cloud.js';
import { normalizePhone, randInt, sleep } from './utils.js';

const MEDIA_DIR = path.join(DATA_DIR, 'media_cache'); // the chat shows sent files from here
export const KEY_PREFIX = 'twa_live_';
export const MAX_KEYS = 20; // per workspace
export const PER_MINUTE = 60; // requests per key per minute

// An error the API returns as { error: { code, message } } with this HTTP status.
export class ApiError extends Error {
  constructor(status, code, message, extra) {
    super(message);
    this.status = status;
    this.code = code;
    this.extra = extra || null;
  }
}
const fail = (status, code, message, extra) => {
  throw new ApiError(status, code, message, extra);
};

// ---- Keys ----

const hashKey = (k) => crypto.createHash('sha256').update(String(k)).digest('hex');

export function keyPublic(d) {
  return {
    id: String(d._id),
    name: d.name,
    prefix: d.prefix,
    last4: d.last4,
    sender: d.sender_phone || null, // null = the workspace's default number
    created_at: d.created_at,
    created_by: d.created_by || '',
    last_used_at: d.last_used_at || null,
    sent: d.sent || 0,
  };
}

// 'default' / empty → null (the default number); otherwise a number linked in this workspace.
async function cleanSender(v) {
  if (v === null || v === undefined || v === '' || v === 'default') return null;
  const phone = normalizePhone(v);
  const nums = await listNumbers();
  if (!phone || !nums.some((n) => n.phone === phone)) fail(400, 'invalid_sender', "That number isn't linked in this workspace");
  return phone;
}

export async function listKeys() {
  const list = await db.apiKeys().find({ revoked_at: null }).sort({ created_at: -1 }).toArray();
  return list.map(keyPublic);
}

export async function createKey(body = {}, by = '') {
  const name = String(body.name || '').trim().slice(0, 60);
  if (!name) fail(400, 'invalid_name', 'Give the key a name, e.g. "Shop POS"');
  if ((await db.apiKeys().countDocuments({ revoked_at: null })) >= MAX_KEYS) {
    fail(400, 'too_many_keys', `A workspace can have up to ${MAX_KEYS} keys. Delete one you no longer use first.`);
  }
  const senderPhone = await cleanSender(body.sender);
  const key = KEY_PREFIX + crypto.randomBytes(24).toString('base64url');
  const doc = {
    name,
    prefix: key.slice(0, KEY_PREFIX.length + 4),
    last4: key.slice(-4),
    hash: hashKey(key),
    sender_phone: senderPhone,
    created_at: nowIso(),
    created_by: by,
    last_used_at: null,
    sent: 0,
    revoked_at: null,
  };
  const r = await db.apiKeys().insertOne(doc);
  audit('system', `API key "${name}" created${by ? ` by ${by}` : ''}`);
  return { key, ...keyPublic({ _id: r.insertedId, ...doc }) };
}

export async function updateKey(id, body = {}) {
  const _id = oid(id);
  const cur = _id && (await db.apiKeys().findOne({ _id, revoked_at: null }));
  if (!cur) fail(404, 'not_found', 'Not found');
  const set = {};
  if ('name' in body) {
    set.name = String(body.name || '').trim().slice(0, 60);
    if (!set.name) fail(400, 'invalid_name', 'Give the key a name');
  }
  if ('sender' in body) set.sender_phone = await cleanSender(body.sender);
  await db.apiKeys().updateOne({ _id }, { $set: set });
  return keyPublic({ ...cur, ...set });
}

export async function revokeKey(id, by = '') {
  const _id = oid(id);
  const cur = _id && (await db.apiKeys().findOne({ _id, revoked_at: null }));
  if (!cur) fail(404, 'not_found', 'Not found');
  await db.apiKeys().updateOne({ _id }, { $set: { revoked_at: nowIso() } });
  audit('system', `API key "${cur.name}" deleted${by ? ` by ${by}` : ''} — software using it can no longer send`, { level: 'warn' });
}

// The key a request carries (any workspace: the key decides which one). null = not a valid key.
export async function findKey(raw) {
  const k = String(raw || '').trim();
  if (!k.startsWith(KEY_PREFIX) || k.length > 100) return null;
  return col('api_keys').findOne({ hash: hashKey(k), revoked_at: null });
}

// Requests per key per minute. Returns 0 when allowed, else the seconds to wait.
const hits = new Map();
export function rateLimited(keyId, now = Date.now()) {
  const k = String(keyId);
  const recent = (hits.get(k) || []).filter((t) => now - t < 60000);
  if (recent.length >= PER_MINUTE) {
    hits.set(k, recent);
    return Math.max(1, Math.ceil((recent[0] + 60000 - now) / 1000));
  }
  recent.push(now);
  hits.set(k, recent);
  return 0;
}

// "Last used" on the Developer page (written at most once a minute per key).
const touched = new Map();
export function touchKey(key) {
  const k = String(key._id);
  if (Date.now() - (touched.get(k) || 0) < 60000) return;
  touched.set(k, Date.now());
  col('api_keys').updateOne({ _id: key._id }, { $set: { last_used_at: nowIso() } }).catch(() => {});
}

// ---- Request log (Developer page → Recent requests; kept 30 days) ----

export function logRequest(entry) {
  db.apiLogs()
    .insertOne({ at: new Date(), ...entry })
    .catch(() => {});
}

export async function listLogs(limit = 50) {
  const n = Math.min(200, Math.max(1, Number(limit) || 50));
  const list = await db.apiLogs().find({}).sort({ at: -1 }).limit(n).toArray();
  return list.map((l) => ({
    id: String(l._id),
    at: l.at instanceof Date ? l.at.toISOString() : l.at,
    key: l.key_name || '',
    method: l.method,
    path: l.path,
    http: l.http,
    code: l.code,
    message: l.message || '',
    to: l.to || null,
    type: l.type || null,
    reference: l.reference || null,
    message_id: l.message_id || null,
    ms: l.ms ?? null,
  }));
}

// ---- Who sends: the number ----

// The number a message goes out from: `from` (a number of this workspace), else the key's own
// number, else the workspace's default number. Then the session of it that's connected now.
export async function resolveSender(fromPhone, { keyNumber = false, soft = false } = {}) {
  const nums = await listNumbers();
  let n;
  if (fromPhone) {
    n = nums.find((x) => x.phone === fromPhone);
    if (!n) {
      if (soft) return null;
      fail(
        400,
        'invalid_sender',
        keyNumber
          ? `This key sends from +${fromPhone}, which is no longer linked. Edit the key on the Developer page, or link the number again.`
          : `+${fromPhone} isn't one of this workspace's WhatsApp numbers.`
      );
    }
  } else n = nums.find((x) => x.default) || nums[0];
  if (!n) {
    if (soft) return null;
    fail(503, 'no_number', 'No WhatsApp number is linked yet. Open WhatsApp Gateway and link one (scan a QR code or connect the official API).');
  }
  const { ids } = accountGroup(n.id);
  let id = null;
  if (hasMain() && ids.includes('main') && mainConnected()) id = 'main';
  else id = ids.find((x) => x !== 'main' && isAccountConnected(x)) || null;
  const kind = n.kind === 'cloud' || (id && id !== 'main' && accountKind(id) === 'cloud') ? 'cloud' : 'qr';
  if (soft) return { id, phone: n.phone, kind, label: n.label || '', connected: !!id, default: !!n.default };
  if (!id) {
    fail(
      503,
      'number_not_connected',
      `The WhatsApp number +${n.phone} isn't connected right now. Open WhatsApp Gateway and reconnect it${kind === 'qr' ? ' (the phone has to stay online)' : ''}.`
    );
  }
  return { id, phone: n.phone, kind, label: n.label || '' };
}

// ---- Who receives ----

function cleanTo(raw) {
  const s = String(raw ?? '').trim();
  if (!s) fail(400, 'missing_to', 'Add "to": the customer\'s WhatsApp number with country code, e.g. "971501234567".');
  const compact = s.replace(/[\s\-().]/g, '');
  if (!/^\+?\d+$/.test(compact)) fail(400, 'invalid_phone', `"${s.slice(0, 40)}" isn't a phone number. Use digits with the country code, e.g. 971501234567.`);
  if (/^0(?!0)/.test(compact)) fail(400, 'invalid_phone', `"${s}" looks like a local number. Use the full international number with the country code, e.g. 971501234567.`);
  const p = normalizePhone(compact);
  if (!p || p.length < 8 || p.length > 15) fail(400, 'invalid_phone', `"${s}" isn't a valid WhatsApp number. Use digits with the country code, e.g. 971501234567.`);
  return p;
}

// The customer's contact (created on the first message; a name is only filled in if missing).
async function contactFor(phone, name) {
  const nm = String(name || '').trim().slice(0, 100);
  const upsert = () =>
    db.contacts().findOneAndUpdate(
      { phone },
      {
        $setOnInsert: {
          name: nm,
          tags: '',
          notes: '',
          status: 'active',
          synced: 0,
          list_ids: [],
          handoff: 0,
          handoff_reason: '',
          last_inbound_at: null,
          last_outbound_at: null,
          created_at: nowIso(),
          source: 'api',
        },
      },
      { upsert: true, returnDocument: 'after' }
    );
  let c;
  try {
    c = await upsert();
  } catch (e) {
    if (e.code !== 11000) throw e;
    c = await upsert(); // two requests for a new customer at the same moment
  }
  if (nm && !c.name) {
    await db.contacts().updateOne({ _id: c._id }, { $set: { name: nm } });
    c.name = nm;
  }
  return c;
}

// ---- Files: a PDF receipt, an image ----

const MB = 1024 * 1024;
const MAX_SIZE = { document: 16 * MB, image: 5 * MB };
const DOC_TYPES = {
  pdf: 'application/pdf',
  txt: 'text/plain',
  doc: 'application/msword',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xls: 'application/vnd.ms-excel',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  ppt: 'application/vnd.ms-powerpoint',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
};
const IMG_TYPES = { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png' };
const EXT_OF = { ...Object.fromEntries(Object.entries(DOC_TYPES).map(([e, m]) => [m, e])), 'image/jpeg': 'jpg', 'image/png': 'png' };
const KNOWN_TYPES = new Set(Object.keys(EXT_OF));
const mb = (n) => `${(n / MB).toFixed(n < MB ? 2 : 1)} MB`;

function sniff(buf) {
  if (buf.length >= 4 && buf.subarray(0, 4).toString('latin1') === '%PDF') return 'application/pdf';
  if (buf.length >= 4 && buf[0] === 0x89 && buf.subarray(1, 4).toString('latin1') === 'PNG') return 'image/png';
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  return null;
}

function cleanName(v) {
  return path
    .basename(String(v || '').replace(/\\/g, '/'))
    .replace(/[\u0000-\u001f\u007f"<>|:*?]/g, '')
    .trim()
    .slice(0, 100);
}

// Private and local addresses a file link may not point to (so the API can't be used to read
// the server's own network).
export function privateIp(ip) {
  const v = String(ip || '').toLowerCase();
  if (net.isIPv4(v)) {
    const [a, b] = v.split('.').map(Number);
    return (
      a === 0 || a === 10 || a === 127 || a >= 224 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && (b === 168 || b === 0)) ||
      (a === 198 && (b === 18 || b === 19))
    );
  }
  if (!net.isIPv6(v)) return true;
  if (v === '::' || v === '::1') return true;
  const dotted = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(v);
  if (dotted) return privateIp(dotted[1]);
  const hex = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(v);
  if (hex) {
    const n = (parseInt(hex[1], 16) << 16) | parseInt(hex[2], 16);
    return privateIp([n >>> 24, (n >> 16) & 255, (n >> 8) & 255, n & 255].join('.'));
  }
  return /^(fc|fd|fe[89ab]|ff)/.test(v) || v.startsWith('64:ff9b:');
}
const allowPrivate = () => process.env.API_ALLOW_PRIVATE_URLS === '1'; // tests only

function safeLookup(hostname, options, cb) {
  dns.lookup(hostname, { all: true }, (err, addrs) => {
    if (err) return cb(err);
    if (!allowPrivate() && addrs.some((a) => privateIp(a.address))) return cb(Object.assign(new Error('private address'), { code: 'EPRIVATE' }));
    if (options?.all) return cb(null, addrs);
    cb(null, addrs[0].address, addrs[0].family);
  });
}

function nameFromDisposition(h) {
  const v = String(h || '');
  const star = /filename\*\s*=\s*(?:UTF-8'')?([^;]+)/i.exec(v);
  if (star) {
    try {
      return decodeURIComponent(star[1].trim().replace(/^"|"$/g, ''));
    } catch {}
  }
  return /filename\s*=\s*"?([^";]+)"?/i.exec(v)?.[1] || '';
}

const unreachable = (why) => new ApiError(422, 'file_unreachable', why);
const PRIVATE_LINK = 'That file link points to a private or local address. Use a public link (https://…), or send the file as base64.';

function fetchPublicFile(rawUrl, max, hops = 0) {
  return new Promise((resolve, reject) => {
    let u;
    try {
      u = new URL(rawUrl);
    } catch {
      return reject(new ApiError(400, 'invalid_file', `"${String(rawUrl).slice(0, 80)}" isn't a valid link.`));
    }
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return reject(new ApiError(400, 'invalid_file', 'The file link must start with https:// or http://'));
    const host = u.hostname.replace(/^\[|\]$/g, '');
    if (!allowPrivate() && ((net.isIP(host) && privateIp(host)) || /(^|\.)(localhost|local|internal)$/i.test(host))) return reject(unreachable(PRIVATE_LINK));
    const mod = u.protocol === 'https:' ? https : http;
    const req = mod.get(u, { lookup: safeLookup, timeout: 20000, headers: { 'User-Agent': 'WhatsApp-API-file-fetch/1.0', Accept: '*/*' } }, (res) => {
      if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
        res.resume();
        if (hops >= 3) return reject(unreachable('The file link redirects too many times.'));
        return resolve(fetchPublicFile(new URL(res.headers.location, u).toString(), max, hops + 1));
      }
      if (res.statusCode !== 200) {
        res.resume();
        return reject(unreachable(`Couldn't download the file: the link answered HTTP ${res.statusCode}.`));
      }
      const tooBig = () => new ApiError(413, 'file_too_large', `The file is larger than ${mb(max)}, the most allowed here.`);
      if (Number(res.headers['content-length'] || 0) > max) {
        res.destroy();
        return reject(tooBig());
      }
      const chunks = [];
      let size = 0;
      res.on('data', (c) => {
        size += c.length;
        if (size > max) {
          res.destroy();
          reject(tooBig());
        } else chunks.push(c);
      });
      res.on('end', () => {
        let name = nameFromDisposition(res.headers['content-disposition']);
        if (!name) {
          try {
            name = decodeURIComponent(path.basename(u.pathname));
          } catch {
            name = path.basename(u.pathname);
          }
        }
        resolve({ buf: Buffer.concat(chunks), type: String(res.headers['content-type'] || '').split(';')[0].trim().toLowerCase(), name });
      });
      res.on('error', (e) => reject(unreachable(`Couldn't download the file (${e.message}).`)));
    });
    req.on('timeout', () => req.destroy(Object.assign(new Error('timed out'), { code: 'ETIMEDOUT' })));
    req.on('error', (e) => reject(e.code === 'EPRIVATE' ? unreachable(PRIVATE_LINK) : unreachable(`Couldn't download the file (${e.code || e.message}).`)));
  });
}

// { url } or { base64, filename } (a plain string works too) → { kind, buffer, mime, filename, size }.
async function loadFile(spec, kind) {
  if (typeof spec === 'string') spec = /^https?:\/\//i.test(spec.trim()) ? { url: spec.trim() } : { base64: spec };
  if (!spec || typeof spec !== 'object') fail(400, 'invalid_file', `"${kind}" must be { "url": "https://…" } or { "base64": "…", "filename": "receipt.pdf" }.`);
  const max = MAX_SIZE.document; // checked again below once we know it's an image
  let buf;
  let headerType = '';
  let linkName = '';
  if (spec.base64) {
    let b = String(spec.base64);
    const m = /^data:([\w.+/-]*)(;[^,]*)?,/i.exec(b);
    if (m) {
      headerType = (m[1] || '').toLowerCase();
      b = b.slice(m[0].length);
    }
    b = b.replace(/\s/g, '');
    if (!b || !/^[A-Za-z0-9+/_-]+={0,2}$/.test(b)) fail(400, 'invalid_file', `"${kind}.base64" isn't valid base64 data.`);
    if (b.length > Math.ceil(max / 3) * 4 + 4) fail(413, 'file_too_large', `The file is larger than ${mb(max)}, the most allowed here.`);
    buf = Buffer.from(b, 'base64');
  } else if (spec.url) {
    ({ buf, type: headerType, name: linkName } = await fetchPublicFile(String(spec.url).trim(), max));
  } else {
    fail(400, 'invalid_file', `"${kind}" needs a "url" or "base64".`);
  }
  if (!buf.length) fail(400, 'invalid_file', 'The file is empty.');

  let filename = cleanName(spec.filename || spec.file_name || linkName);
  const ext = path.extname(filename).slice(1).toLowerCase();
  const mime = sniff(buf) || DOC_TYPES[ext] || IMG_TYPES[ext] || (KNOWN_TYPES.has(headerType) ? headerType : '');
  if (!mime) fail(415, 'unsupported_file', 'Send a PDF, a JPG/PNG image, or a Word, Excel, PowerPoint or text file.');
  const isImage = mime === 'image/jpeg' || mime === 'image/png';
  // A receipt rendered as a picture but sent as "document" goes out as a photo.
  const k = isImage ? 'image' : 'document';
  if (kind === 'image' && !isImage) fail(415, 'unsupported_file', 'That file isn\'t a JPG or PNG image. Send it as "document" instead.');
  if (buf.length > MAX_SIZE[k]) fail(413, 'file_too_large', `The file is ${mb(buf.length)}; WhatsApp ${k === 'image' ? 'images' : 'documents'} sent here can be up to ${mb(MAX_SIZE[k])}.`);
  if (!filename || filename.startsWith('.')) filename = mime === 'application/pdf' ? 'receipt.pdf' : `file.${EXT_OF[mime]}`;
  if (!path.extname(filename)) filename += `.${EXT_OF[mime]}`;
  return { kind: k, buffer: buf, mime, filename, size: buf.length };
}

// ---- Official numbers: approved templates ----

const tplCache = new Map(); // account id -> { at, list }
async function approvedTemplates(accountId, fresh = false) {
  const hit = tplCache.get(accountId);
  if (!fresh && hit && Date.now() - hit.at < 5 * 60000) return hit.list;
  const acc = cloudAccountOf(accountId);
  if (!acc) fail(503, 'number_not_connected', 'The official WhatsApp number is no longer connected.');
  let list;
  try {
    list = (await listCloudTemplates(acc)).filter((t) => t.status === 'APPROVED');
  } catch (e) {
    fail(502, 'send_failed', `Couldn't read this number's templates from Meta: ${e.message}`);
  }
  tplCache.set(accountId, { at: Date.now(), list });
  return list;
}

const VAR_FIX = (v) => String(v ?? '').replace(/[\r\n\t]+/g, ' ').replace(/ {4,}/g, '   ').trim().slice(0, 1024);

async function buildApiTemplate(senderId, spec, file) {
  if (!spec || typeof spec !== 'object' || !spec.name) fail(400, 'invalid_template', 'Give the template\'s "name" and "language", e.g. { "name": "order_receipt", "language": "en", "variables": ["Ali", "INV-1043"] }.');
  const name = String(spec.name).trim();
  const language = String(spec.language || spec.lang || 'en').trim();
  const pick = (list) => list.find((t) => t.name === name && t.language === language);
  let found = pick(await approvedTemplates(senderId));
  if (!found) found = pick(await approvedTemplates(senderId, true)); // approved in the last few minutes?
  if (!found) {
    const langs = (await approvedTemplates(senderId)).filter((t) => t.name === name).map((t) => t.language);
    fail(
      422,
      'template_not_found',
      langs.length
        ? `The template "${name}" is approved in ${langs.join(', ')}, not "${language}". Send "language": "${langs[0]}".`
        : `There's no approved template called "${name}" on this number's WhatsApp Business Account. Check the exact name in Meta (WhatsApp Manager → Message templates); only approved templates can be sent.`
    );
  }
  const shape = templateShape(found);
  if (shape.unsupported) fail(422, 'template_not_supported', `Templates with ${shape.unsupported} can't be sent through the API yet. Use another template.`);
  const values = (vars, given, field, where) =>
    vars.map((k, i) => {
      const raw = Array.isArray(given) ? given[i] : given && typeof given === 'object' ? given[k] ?? given[String(i + 1)] : undefined;
      const v = VAR_FIX(raw);
      if (!v) fail(400, 'missing_variable', `The template "${name}" needs a value for {{${k}}} in its ${where}. Send it in "template.${field}".`);
      return v;
    });
  const bodyVals = values(shape.bodyVars, spec.variables ?? spec.body_variables, 'variables', 'text');
  const headerVals = values(shape.headerVars, spec.header_variables, 'header_variables', 'header');
  const param = (k, text) => (shape.named ? { type: 'text', parameter_name: k, text } : { type: 'text', text });
  const components = [];
  let headerKind = null;
  const fmt = shape.header?.format;
  if (fmt === 'TEXT' && headerVals.length) components.push({ type: 'header', parameters: shape.headerVars.map((k, i) => param(k, headerVals[i])) });
  if (fmt === 'VIDEO') fail(422, 'template_not_supported', "Templates that start with a video can't be sent through the API yet.");
  if (fmt === 'IMAGE' || fmt === 'DOCUMENT') {
    headerKind = fmt.toLowerCase();
    if (!file) fail(400, 'missing_header_file', `The template "${name}" starts with ${headerKind === 'image' ? 'an image' : 'a document'}. Add "${headerKind}": { "url": "https://…" } or { "base64": "…", "filename": "…" }.`);
    if (file.kind !== headerKind) fail(400, 'invalid_file', `The template "${name}" starts with ${headerKind === 'image' ? 'an image (JPG/PNG)' : 'a document (e.g. a PDF)'}, so send "${headerKind}".`);
  } else if (file) {
    fail(400, 'invalid_request', `The template "${name}" has no ${file.kind} at the top, so a file can't go with it. Remove "${file.kind === 'image' ? 'image' : 'document'}".`);
  }
  if (bodyVals.length) components.push({ type: 'body', parameters: shape.bodyVars.map((k, i) => param(k, bodyVals[i])) });
  const fill = (txt, vars, vals) => vars.reduce((t, k, i) => t.replace(new RegExp(`\\{\\{\\s*${k}\\s*\\}\\}`, 'g'), vals[i]), String(txt || ''));
  const headerText = fmt === 'TEXT' ? fill(shape.header.text, shape.headerVars, headerVals) : '';
  const text = [headerText ? `*${headerText}*` : '', fill(shape.body, shape.bodyVars, bodyVals), shape.footer ? `_${shape.footer}_` : ''].filter(Boolean).join('\n\n');
  return { name, language, components, headerKind, text };
}

// ---- Sending ----

// One message at a time per number, with a short human gap on QR-linked numbers (ten tills
// pressing "send" at once mustn't burst out of one phone).
const queues = new Map();
const MAX_WAITING = 30;
const qrGapMs = () => {
  const v = process.env.API_QR_GAP_MS; // tests
  return v != null && v !== '' ? Math.max(0, Number(v) || 0) : randInt(1500, 3500);
};
function onQueue(key, gapMs, fn) {
  let q = queues.get(key);
  if (!q) {
    q = { tail: Promise.resolve(), waiting: 0, lastAt: 0 };
    queues.set(key, q);
  }
  if (q.waiting >= MAX_WAITING) fail(429, 'busy', 'This number has too many messages waiting to go out. Try again in a few seconds.');
  q.waiting++;
  const run = q.tail.then(async () => {
    const wait = q.lastAt + gapMs - Date.now();
    if (wait > 0) await sleep(wait);
    try {
      return await fn();
    } finally {
      q.lastAt = Date.now();
    }
  });
  q.tail = run.then(
    () => {},
    () => {}
  ).finally(() => {
    q.waiting--;
  });
  return run;
}

async function deliver(sender, to, { text, caption, file, tpl }) {
  try {
    if (sender.kind === 'cloud') {
      const acc = cloudAccountOf(sender.id);
      if (!acc) throw new Error('The official number is no longer connected');
      if (tpl) {
        const components = [...tpl.components];
        if (tpl.headerKind) {
          const id = await uploadCloudMedia(acc, file.buffer, file.mime, file.filename);
          const media = tpl.headerKind === 'document' ? { id, filename: file.filename } : { id };
          components.unshift({ type: 'header', parameters: [{ type: tpl.headerKind, [tpl.headerKind]: media }] });
        }
        return await sendCloudTemplate(acc, to, { name: tpl.name, language: tpl.language, components });
      }
      if (file) {
        const id = await uploadCloudMedia(acc, file.buffer, file.mime, file.filename);
        return await sendCloudMedia(acc, to, file.kind, { id, caption, filename: file.filename });
      }
      return await sendCloudText(acc, to, text);
    }
    const content = !file
      ? { text }
      : file.kind === 'image'
        ? { image: file.buffer, mimetype: file.mime, caption: caption || undefined }
        : { document: file.buffer, mimetype: file.mime, fileName: file.filename, caption: caption || undefined };
    return sender.id === 'main' ? await sendContent(to, content) : await sendContentFromTo(sender.id, to, content);
  } catch (e) {
    if (e instanceof ApiError) throw e;
    const metaCode = typeof e.code === 'number' ? e.code : null;
    if (metaCode === 131047) fail(422, 'window_closed', e.message, { meta_code: metaCode });
    fail(502, 'send_failed', `WhatsApp didn't accept the message: ${e.message}`, metaCode ? { meta_code: metaCode } : undefined);
  }
}

export function messagePublic(m) {
  const out = {
    id: String(m._id),
    status: m.status || 'sent', // sent → delivered → read, or failed
    to: m.api_to || null,
    from: m.account_phone || null,
    type: m.api_type || 'text',
    reference: m.api_ref || null,
    created_at: m.created_at,
  };
  if (m.file_name) out.file_name = m.file_name;
  if (m.template_name) out.template = m.template_name;
  if (m.status === 'failed') out.error = { code: m.error_code || null, message: m.error || "WhatsApp couldn't deliver this message" };
  return out;
}

const DAY_MS = 24 * 3600 * 1000;
async function sentWithReference(reference, to) {
  const since = new Date(Date.now() - DAY_MS).toISOString();
  const [m] = await db
    .messages()
    .find({ api_ref: reference, api_to: to, source: 'api', status: { $ne: 'failed' }, created_at: { $gte: since } })
    .sort({ created_at: -1 })
    .limit(1)
    .toArray();
  return m || null;
}

export async function messageById(id) {
  const _id = oid(id);
  const m = _id && (await db.messages().findOne({ _id, source: 'api' }));
  return m ? messagePublic(m) : null;
}
export async function messageByReference(reference) {
  const [m] = await db.messages().find({ api_ref: String(reference), source: 'api' }).sort({ created_at: -1 }).limit(1).toArray();
  return m ? messagePublic(m) : null;
}

const inflight = new Map(); // workspace:reference:to → the send in progress

// Send one message for an API key (or the Developer page's test, key._id 'test').
export async function sendViaApi(key, body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) fail(400, 'invalid_request', 'Send a JSON body, e.g. {"to": "971501234567", "text": "Thanks for shopping with us!"}.');
  const to = cleanTo(body.to ?? body.phone);
  const reference = body.reference == null ? null : String(body.reference).trim().slice(0, 100) || null;
  if (!reference) return send(key, body, to, null);

  // The same receipt sent twice (a double click, a retry after a timeout) goes out once.
  const prior = await sentWithReference(reference, to);
  if (prior) return { ...messagePublic(prior), duplicate: true };
  const k = `${currentWs()}:${reference}:${to}`;
  if (inflight.has(k)) {
    const first = await inflight.get(k).catch(() => null);
    if (first) return { ...first, duplicate: true };
  }
  const p = send(key, body, to, reference);
  inflight.set(k, p);
  try {
    return await p;
  } finally {
    if (inflight.get(k) === p) inflight.delete(k);
  }
}

async function send(key, body, to, reference) {
  const rawText = body.text ?? body.message ?? body.body;
  if (rawText != null && typeof rawText !== 'string') fail(400, 'invalid_request', '"text" must be a string.');
  const text = String(rawText ?? '').trim();
  const hasDoc = body.document != null && body.document !== '';
  const hasImg = body.image != null && body.image !== '';
  const tplSpec = body.template || null;
  if (hasDoc && hasImg) fail(400, 'invalid_request', 'Send one file per message: "document" or "image", not both.');
  if (!tplSpec && !hasDoc && !hasImg && !text) fail(400, 'missing_content', 'Add "text" (the message), or a "document" or "image" to send.');
  if (text.length > 4096) fail(400, 'text_too_long', `"text" is ${text.length} characters; WhatsApp allows up to 4,096.`);
  const caption = String(body.caption ?? (hasDoc || hasImg ? text : '')).trim();
  if ((hasDoc || hasImg) && caption.length > 1024) fail(400, 'caption_too_long', "A file's caption can be up to 1,024 characters. Send longer text as its own message.");

  const askedFrom = body.from != null && body.from !== '' ? normalizePhone(body.from) : null;
  const sender = await resolveSender(askedFrom || key.sender_phone || null, { keyNumber: !askedFrom && !!key.sender_phone });
  if (tplSpec && sender.kind !== 'cloud') {
    fail(400, 'template_not_supported', `Templates are for official WhatsApp API numbers. +${sender.phone} is linked by QR code, so send "text", "document" or "image" instead.`);
  }

  // A QR-linked number's daily API cap (the super admin's rule; keeps the number safe from bans).
  const L = getLimits();
  if (sender.kind !== 'cloud' && L.apiMaxPerNumberDay > 0) {
    const today = await db.messages().countDocuments({ source: 'api', account_phone: sender.phone, day_key: dayKey() });
    if (today >= L.apiMaxPerNumberDay) {
      fail(429, 'daily_limit', `+${sender.phone} has sent ${today} messages through the API today, the most a QR-linked number may send (${L.apiMaxPerNumberDay}) to keep it safe from bans. It resets tomorrow.`);
    }
  }

  const contact = await contactFor(to, body.name);
  if (contact.status === 'opted_out') fail(422, 'opted_out', `+${to} replied STOP and opted out of messages from this business, so nothing was sent.`);

  const file = hasDoc ? await loadFile(body.document, 'document') : hasImg ? await loadFile(body.image, 'image') : null;

  let tpl = null;
  if (sender.kind === 'cloud') {
    if (tplSpec) tpl = await buildApiTemplate(sender.id, tplSpec, file);
    else if (!(await replyWindowOpen(contact._id, sender.phone))) {
      fail(
        422,
        'window_closed',
        `+${to} hasn't written to +${sender.phone} in the last 24 hours, so WhatsApp only allows an approved template. Send "template": { "name": "…", "language": "en", "variables": […] } with a template approved in Meta (a "utility" receipt template works well).`
      );
    }
  } else {
    const check = sender.id === 'main' ? await checkOnWhatsApp(to) : await checkOnWhatsAppVia(sender.id, to);
    if (!check.exists && !check.reason) {
      await db.contacts().updateOne({ _id: contact._id }, { $set: { status: 'bounced' } });
      fail(422, 'not_on_whatsapp', `+${to} isn't on WhatsApp.`);
    }
  }

  const type = tpl ? 'template' : file ? file.kind : 'text';
  const waId = await onQueue(`${currentWs()}:${sender.phone}`, sender.kind === 'cloud' ? 0 : qrGapMs(), () => deliver(sender, to, { text, caption, file, tpl }));

  // Save it in the chat, like a message typed in Conversations.
  const now = nowIso();
  const shown = tpl ? tpl.text : file ? caption || (file.kind === 'image' ? '📷 Photo' : `📄 ${file.filename}`) : text;
  const doc = {
    contact_id: String(contact._id),
    campaign_id: null,
    account_id: sender.id,
    account_phone: sender.phone,
    direction: 'out',
    body: shown,
    source: 'api',
    api_key_id: String(key._id),
    api_key_name: key.name,
    api_to: to,
    api_type: type,
    ...(reference ? { api_ref: reference } : {}),
    ...(tpl ? { template_name: tpl.name } : {}),
    ...(file
      ? { type: file.kind, media: 1, mime: file.mime, size: file.size, caption: tpl ? tpl.text : caption, local_media: 1, ...(file.kind === 'document' ? { file_name: file.filename } : {}) }
      : {}),
  };
  const onInsert = { status: 'sent', created_at: now, day_key: dayKey() };
  let saved;
  if (waId) {
    // The phone's own copy of the message may already be stored (same WhatsApp id): fill it in.
    saved = await db.messages().findOneAndUpdate({ wa_message_id: waId }, { $set: { ...doc, wa_message_id: waId }, $setOnInsert: onInsert }, { upsert: true, returnDocument: 'after' });
  } else {
    const r = await db.messages().insertOne({ ...doc, ...onInsert });
    saved = { _id: r.insertedId, ...doc, ...onInsert };
  }
  if (file) {
    try {
      await fs.promises.mkdir(MEDIA_DIR, { recursive: true });
      await fs.promises.writeFile(path.join(MEDIA_DIR, String(saved._id)), file.buffer);
    } catch {}
  }
  await db.contacts().updateOne({ _id: contact._id }, { $set: { last_outbound_at: now } });
  if (key._id !== 'test') col('api_keys').updateOne({ _id: key._id }, { $inc: { sent: 1 }, $set: { last_used_at: now } }).catch(() => {});
  audit('send', `Sent by API${key._id === 'test' ? ' (test from the Developer page)' : ` (key "${key.name}")`} to ${contact.name ? `${contact.name} (+${to})` : `+${to}`}${reference ? ` — ${reference}` : ''}`, {
    meta: { contactId: String(contact._id) },
  });
  emit('message:out', { contactId: String(contact._id) });
  emit('stats:dirty', {});
  return messagePublic(saved);
}

// What the Developer page shows next to the keys.
export async function usageToday() {
  return db.messages().countDocuments({ source: 'api', day_key: dayKey() });
}
