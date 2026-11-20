// Meta WhatsApp Cloud API (the official WhatsApp Business Platform) — the HTTP calls only.
// A number linked this way sends through Meta's Graph API with the business's own access
// token; nothing here touches the QR-linked (Baileys) numbers.
//
// Shapes follow Meta's reference (developers.facebook.com → WhatsApp Business Platform):
//   POST /{version}/{phone-number-id}/messages   → { messaging_product, contacts[], messages[{ id }] }
//   POST /{version}/{phone-number-id}/media      → { id }
//   GET  /{version}/{phone-number-id}?fields=…   → display_phone_number, verified_name, quality_rating
//   GET  /{version}/{waba-id}/phone_numbers       → { data: [{ id, display_phone_number, … }] }
//   GET  /{version}/{waba-id}/message_templates   → { data: [{ name, language, status, category, components }], paging }
//   POST /{version}/{waba-id}/subscribed_apps     → { success } (webhooks for this WhatsApp Business Account)
//   GET  /{version}/{media-id}                    → { url, mime_type } (then GET url with the token)
// Errors come back as { error: { message, type, code, error_subcode, error_data: { details }, fbtrace_id } }.

export const GRAPH_BASE = (process.env.WA_CLOUD_API_BASE || 'https://graph.facebook.com').replace(/\/+$/, '');
// v25.0 is supported until July 2028 (Graph API changelog); override with WA_CLOUD_API_VERSION.
export const GRAPH_VERSION = process.env.WA_CLOUD_API_VERSION || 'v25.0';

// Plain-language reasons for the errors people actually hit; anything else shows Meta's own words.
const KNOWN = {
  190: 'The access token is invalid or has expired. Create a permanent token (Meta Business Settings → System users) and save it again.',
  10: "The access token doesn't have permission for this. Give it whatsapp_business_messaging and whatsapp_business_management.",
  200: "The access token doesn't have permission for this. Give it whatsapp_business_messaging and whatsapp_business_management.",
  131047: 'More than 24 hours have passed since this person last wrote to you. WhatsApp only allows an approved template message now.',
  131026: "Message undeliverable: the number may not be on WhatsApp, or the person hasn't accepted WhatsApp's latest terms.",
  131049: "Meta didn't deliver this marketing message, to keep engagement healthy for this person. Try again later.",
  131056: 'Too many messages to this person in a short time. Wait a moment and try again.',
  130429: "You've reached Meta's sending speed limit. It will continue shortly.",
  131048: 'Spam rate limit hit: too many people blocked or reported this number. Slow down and review your messages.',
  131031: 'This WhatsApp Business Account has been locked by Meta.',
  131042: 'There is a payment problem on your WhatsApp Business Account (Meta Business Settings → Billing).',
  368: 'This number is temporarily blocked by Meta for policy violations.',
  132000: "The number of template variables doesn't match the template.",
  132001: "This template doesn't exist in that language (or isn't approved yet).",
  132005: 'The template text is too long once the variables are filled in.',
  132007: "The template's content breaks WhatsApp policy.",
  132015: 'This template is paused because of low quality.',
  132016: 'This template is disabled because of low quality.',
  133010: "This phone number isn't registered on the WhatsApp Cloud API yet.",
};

export function explainMetaError(e = {}) {
  const details = e.error_data?.details || e.message || 'Unknown error from Meta';
  const known = KNOWN[e.code];
  return known ? `${known} (Meta error ${e.code})` : `${details}${e.code ? ` (Meta error ${e.code})` : ''}`;
}

async function call(token, method, pathname, { json, form, query } = {}) {
  const url = new URL(`${GRAPH_BASE}/${GRAPH_VERSION}/${pathname}`);
  for (const [k, v] of Object.entries(query || {})) if (v != null) url.searchParams.set(k, String(v));
  const headers = { Authorization: `Bearer ${token}` };
  let body;
  if (form) body = form;
  else if (json) {
    headers['Content-Type'] = 'application/json';
    body = JSON.stringify(json);
  }
  let r;
  try {
    r = await fetch(url, { method, headers, body, signal: AbortSignal.timeout(25000) });
  } catch (err) {
    throw new Error(`Couldn't reach Meta's WhatsApp API (${err.cause?.code || err.message})`);
  }
  let j = null;
  try {
    j = await r.json();
  } catch {}
  if (!r.ok || j?.error) {
    const e = j?.error || {};
    const err = new Error(j?.error ? explainMetaError(e) : `Meta returned HTTP ${r.status}`);
    err.code = e.code || null;
    err.status = r.status;
    throw err;
  }
  return j;
}

// ---- Setup ----

// Check the details someone pasted: the token can read this phone number, the number belongs to
// this WhatsApp Business Account, and the account's templates are readable. Then subscribe the
// app to the account's webhooks so incoming messages reach us.
export async function verifyCloudNumber({ phoneNumberId, wabaId, token }) {
  const info = await call(token, 'GET', encodeURIComponent(phoneNumberId), {
    query: { fields: 'display_phone_number,verified_name,quality_rating' },
  });
  const nums = await call(token, 'GET', `${encodeURIComponent(wabaId)}/phone_numbers`, { query: { fields: 'id,display_phone_number' } });
  if (!(nums.data || []).some((n) => String(n.id) === String(phoneNumberId))) {
    throw new Error("This phone number ID doesn't belong to that WhatsApp Business Account ID. Copy both from the same page in Meta (WhatsApp → API Setup).");
  }
  await call(token, 'GET', `${encodeURIComponent(wabaId)}/message_templates`, { query: { fields: 'name', limit: 1 } });
  let subscribed = true;
  let subscribeError = '';
  try {
    await call(token, 'POST', `${encodeURIComponent(wabaId)}/subscribed_apps`);
  } catch (e) {
    subscribed = false;
    subscribeError = e.message;
  }
  return {
    phone: String(info.display_phone_number || '').replace(/\D/g, ''),
    displayPhone: info.display_phone_number || '',
    verifiedName: info.verified_name || '',
    quality: info.quality_rating || '',
    subscribed,
    subscribeError,
  };
}

// ---- Sending ----

const sentId = (j) => j?.messages?.[0]?.id || null;
const digits = (p) => String(p || '').replace(/\D/g, '');

export async function sendCloudText(acc, to, text) {
  const j = await call(acc.token, 'POST', `${encodeURIComponent(acc.phone_number_id)}/messages`, {
    json: { messaging_product: 'whatsapp', recipient_type: 'individual', to: digits(to), type: 'text', text: { preview_url: true, body: String(text) } },
  });
  return sentId(j);
}

// Upload the file to Meta first (our uploads aren't public), then send it by media id.
export async function sendCloudImage(acc, to, buffer, caption, mime = 'image/jpeg') {
  const form = new FormData();
  form.append('messaging_product', 'whatsapp');
  form.append('type', mime);
  form.append('file', new Blob([buffer], { type: mime }), mime === 'image/png' ? 'image.png' : 'image.jpg');
  const up = await call(acc.token, 'POST', `${encodeURIComponent(acc.phone_number_id)}/media`, { form });
  const image = { id: up.id };
  if (caption) image.caption = String(caption);
  const j = await call(acc.token, 'POST', `${encodeURIComponent(acc.phone_number_id)}/messages`, {
    json: { messaging_product: 'whatsapp', recipient_type: 'individual', to: digits(to), type: 'image', image },
  });
  return sentId(j);
}

export async function sendCloudTemplate(acc, to, { name, language, components }) {
  const template = { name, language: { code: language } };
  if (components?.length) template.components = components;
  const j = await call(acc.token, 'POST', `${encodeURIComponent(acc.phone_number_id)}/messages`, {
    json: { messaging_product: 'whatsapp', recipient_type: 'individual', to: digits(to), type: 'template', template },
  });
  return sentId(j);
}

// ---- Templates ----

// Every template of the account (all pages, at most 1,000).
export async function listCloudTemplates(acc) {
  const out = [];
  let after = null;
  for (let page = 0; page < 10; page++) {
    const j = await call(acc.token, 'GET', `${encodeURIComponent(acc.waba_id)}/message_templates`, {
      query: { fields: 'name,status,language,category,components', limit: 100, after },
    });
    out.push(...(j.data || []));
    after = j.paging?.cursors?.after;
    if (!j.paging?.next || !after) break;
  }
  return out;
}

// ---- Media people send us ----

export async function downloadCloudMedia(acc, mediaId) {
  const meta = await call(acc.token, 'GET', encodeURIComponent(mediaId));
  if (!meta.url) throw new Error('Meta gave no download link for this file');
  const r = await fetch(meta.url, { headers: { Authorization: `Bearer ${acc.token}` }, signal: AbortSignal.timeout(60000) });
  if (!r.ok) throw new Error(`The file is no longer available from Meta (HTTP ${r.status})`);
  return { buffer: Buffer.from(await r.arrayBuffer()), mime: meta.mime_type || r.headers.get('content-type') || '' };
}
