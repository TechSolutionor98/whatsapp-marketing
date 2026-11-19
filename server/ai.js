// Provider-agnostic AI layer. Talks to any OpenAI-compatible chat endpoint.
// Default provider: Groq (free, fast). Switchable to Gemini / Ollama / custom in Settings.
import { getSetting } from './db/mongo.js';
import { getLimits } from './limits.js';
import { DEFAULT_WS, currentWs } from './tenant.js';

const PRESETS = {
  groq: 'https://api.groq.com/openai/v1',
  gemini: 'https://generativelanguage.googleapis.com/v1beta/openai',
  ollama: 'http://localhost:11434/v1',
};

// Default model per provider. Gemini: 3.1-flash-lite answered the real shop questions in ~1 s
// (Arabic too); 3.5-flash / 3.8-flash kept failing with 503 "high demand" or 45 s timeouts, and
// 2.5-flash / 2.5-flash-lite are closed to new keys (404) — tested with the real key, Nov 2026.
const DEFAULT_MODEL = { groq: 'openai/gpt-oss-20b', gemini: 'gemini-3.1-flash-lite' };

function provider() {
  return getSetting('aiProvider', 'groq');
}
function baseUrl(p = provider()) {
  if (p === 'custom') return (getSetting('aiBaseUrl', '') || '').replace(/\/+$/, '');
  return PRESETS[p] || PRESETS.groq;
}
export function aiModel() {
  const p = provider();
  const m = (getSetting('aiModel', '') || '').trim();
  // switched to Gemini but the model box still names a Groq model ("openai/gpt-oss-20b") → 404
  if (p === 'gemini' && !/^(gemini|gemma)/i.test(m)) return DEFAULT_MODEL.gemini;
  return m || DEFAULT_MODEL[p] || DEFAULT_MODEL.groq; // llama-3.3-70b-versatile no longer exists on Groq (404)
}
export function aiProviderName() {
  return provider();
}
// The server's own keys (.env): GEMINI_API_KEY for Gemini (AI_API_KEY still works on its own),
// GROQ_API_KEY or AI_API_KEY for Groq — so Groq can stand in when Gemini is down.
function envKey(p) {
  if (p === 'gemini') return process.env.GEMINI_API_KEY || process.env.AI_API_KEY || '';
  if (p === 'groq') return process.env.GROQ_API_KEY || process.env.AI_API_KEY || '';
  if (p === 'ollama') return '';
  return process.env.AI_API_KEY || '';
}
// A workspace's own key for a provider (Settings → AI → API key).
function ownKey(p) {
  const k = (getSetting('aiKeys', null) || {})[p];
  return typeof k === 'string' ? k.trim() : '';
}
// The server's keys are the super admin's: the original workspace uses them; other workspaces
// only when the super admin allows it (Rules → AI). Otherwise each workspace uses its own key.
export function platformKeyAllowed() {
  return (currentWs() || DEFAULT_WS) === DEFAULT_WS || !!getLimits().sharePlatformKey;
}
function keyFor(p) {
  return ownKey(p) || (platformKeyAllowed() ? envKey(p) : '');
}
// Where the key for a provider comes from: 'own' | 'platform' | 'none' ('local' for Ollama).
export function keySource(p = provider()) {
  if (p === 'ollama') return 'local';
  if (ownKey(p)) return 'own';
  if (platformKeyAllowed() && envKey(p)) return 'platform';
  return 'none';
}

// Available when we have what the chosen provider needs (Ollama needs no key).
export function aiAvailable() {
  if (!getLimits().allowAi) return false; // switched off for every workspace by the super admin
  if (provider() === 'ollama') return !!baseUrl();
  return !!keyFor(provider());
}

async function chat(system, user, opts = {}) {
  return chatMessages(system, [{ role: 'user', content: user }], opts);
}

const REQUEST_TIMEOUT_MS = 25000; // a provider that hangs must not hold a customer's reply forever
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// One provider: busy minute (429: Groq free tier 8,000 tokens/min; Gemini "Please retry in 41s")
// → wait what it asks (at most 25 s) and try again; overloaded (503 "high demand") or no answer
// in time → one more try. Gives up with an error the caller can fall back on.
async function callProvider(p, model, system, msgs, { maxTokens, temperature, key: keyOverride }) {
  const base = baseUrl(p);
  if (!base) throw new Error('No AI endpoint configured');
  const key = keyOverride ?? keyFor(p);
  const headers = { 'Content-Type': 'application/json' };
  if (key && p !== 'ollama') headers.Authorization = `Bearer ${key}`;
  const body = { model, temperature, max_tokens: maxTokens, messages: [{ role: 'system', content: system }, ...msgs] };
  // Groq's GPT-OSS and Gemini 3 are reasoning models — keep reasoning low so the token budget
  // goes to the answer (otherwise content can come back empty) and replies stay fast.
  if (p === 'groq' || (p === 'gemini' && /^gemini/i.test(model))) body.reasoning_effort = 'low';

  let resp;
  let failure = '';
  for (let attempt = 0; ; attempt++) {
    failure = '';
    resp = await fetch(`${base}/chat/completions`, { method: 'POST', headers, body: JSON.stringify(body), signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) }).catch((e) => {
      failure = e.name === 'TimeoutError' ? `no answer in ${REQUEST_TIMEOUT_MS / 1000}s` : e.message;
      return null;
    });
    if (resp && resp.ok) break;
    const status = resp ? resp.status : 0;
    const t = resp ? await resp.text().catch(() => '') : '';
    if (resp) failure = `${status}: ${t.replace(/\s+/g, ' ').slice(0, 300)}`;
    if (status === 429 && attempt < 3) {
      // a daily quota won't come back in seconds — let the caller fall back right away
      if (/per ?day|PerDay|daily/i.test(t)) break;
      const m = t.match(/(?:try again|retry) in (?:(\d+)m)?([\d.]+)(ms|s)/i) || t.match(/"retryDelay"\s*:\s*"()([\d.]+)(s)"/);
      const asked = m ? (Number(m[1] || 0) * 60 + Number(m[2]) / (m[3] === 'ms' ? 1000 : 1)) * 1000 : Number(resp.headers.get('retry-after')) * 1000;
      if (Number.isFinite(asked) && asked > 25000) break;
      await sleep(Math.max(1000, (Number.isFinite(asked) && asked > 0 ? asked : 8000) + 300));
      continue;
    }
    if ((!resp || status >= 500) && attempt < 1) {
      await sleep(1500);
      continue;
    }
    break;
  }
  if (!resp || !resp.ok) throw new Error(`AI error ${failure}`);
  const data = await resp.json();
  return (data.choices?.[0]?.message?.content || '').trim();
}

async function chatMessages(system, msgs, { maxTokens = 1024, temperature = 1 } = {}) {
  const p = provider();
  try {
    return await callProvider(p, aiModel(), system, msgs, { maxTokens, temperature });
  } catch (e) {
    // Gemini busy, out of quota or down → answer with Groq when its key is there too, instead
    // of leaving the customer without a reply.
    const groqKey = keyFor('groq');
    if (p !== 'gemini' || !groqKey || groqKey === keyFor('gemini')) throw e;
    console.warn(`[ai] Gemini failed (${e.message.slice(0, 160)}) — answering with Groq instead`);
    return callProvider('groq', DEFAULT_MODEL.groq, system, msgs, { maxTokens, temperature });
  }
}

// Check a key before saving it: one tiny request to the provider. Throws with the provider's
// answer when the key is refused; { busy: true } when the provider was just busy (key not judged).
export async function testAiKey(p, key) {
  const model = p === provider() ? aiModel() : DEFAULT_MODEL[p] || aiModel();
  try {
    await callProvider(p, model, 'Reply with: OK', [{ role: 'user', content: 'Say OK' }], { maxTokens: 64, temperature: 0, key });
    return { ok: true };
  } catch (e) {
    if (/AI error (401|403|400)\b|API key|api_key|invalid/i.test(e.message)) throw e;
    return { ok: false, busy: true, error: e.message };
  }
}

// Rewrite a message so each recipient gets a unique, human variation.
// Returns the original text unchanged on any problem (safe fallback).
export async function rewriteMessage(baseText, contact = {}, opts = {}) {
  if (!aiAvailable() || !baseText?.trim()) return baseText;
  const tone = opts.tone || getSetting('aiTone', 'friendly');
  const instructions = opts.instructions ?? getSetting('aiInstructions', '');
  const savedName = (contact.name || '').trim();
  // No saved name → use their phone number as the name (e.g. "+923001234567").
  const firstName = savedName
    ? savedName.split(/\s+/)[0]
    : contact.phone
      ? `+${String(contact.phone).replace(/^\++/, '')}`
      : '';

  const system = `You rewrite a short WhatsApp outreach message so it reads as if a real person typed it, personally, for this one recipient.
Rules:
- Keep the same core offer, facts, and intent.
- Change the wording, greeting, and sentence structure so no two recipients receive the same text.
- Sound natural, warm, and human — never corporate or obviously templated.
- Keep it short (this is WhatsApp) and roughly the same length as the original.
- Preserve any URLs EXACTLY as written.
- If the original has an opt-out line, keep an opt-out line.
- Use the recipient's first name naturally if given; don't force it.
- Tone: ${tone}.${instructions ? `\n- Extra guidance: ${instructions}` : ''}
Output ONLY the final message text — no quotes, no notes, no preamble.`;
  const user = `Recipient first name: ${firstName || '(unknown)'}\n\nMessage to rewrite:\n"""${baseText}"""`;

  try {
    const out = await chat(system, user, { temperature: 1.05 });
    // a link that isn't in the original was made up → send the original instead
    if (inventedLinks(out, baseText).length) return baseText;
    return out || baseText;
  } catch {
    return baseText;
  }
}

// --- Warm-up conversations: casual, non-marketing chit-chat between the user's own numbers ---
export async function warmupOpener(toName = '') {
  if (!aiAvailable()) throw new Error('AI not configured');
  const system = `You are texting a friend on WhatsApp. Write ONE short, casual, friendly opener (a greeting + a light check-in or small-talk question). Rules:
- Max 1–2 short sentences, like a real person texting.
- Natural and warm; vary it every time (never the same line twice).
- An emoji is fine but optional.
- NOT marketing, no links, no business talk.
- You may use the name "${toName || 'there'}" if it fits.
Output ONLY the message text.`;
  return chat(system, 'Write one casual opener now.', { temperature: 1.15, maxTokens: 200 });
}

export async function warmupReply(incoming, fromName = '') {
  if (!aiAvailable()) throw new Error('AI not configured');
  const system = `You are texting a friend back on WhatsApp. Reply naturally to their message. Rules:
- Max 1–2 short sentences, casual and warm, like a real reply.
- Answer/acknowledge what they said, maybe ask back.
- Vary it every time; an emoji is optional.
- NOT marketing, no links.
Output ONLY the reply text.`;
  return chat(system, `They said: "${incoming}"\n\nWrite your casual reply.`, { temperature: 1.15, maxTokens: 200 });
}

// Generate a reply to an incoming conversation. `history` is oldest→newest
// [{direction:'in'|'out', body}] — ONLY this number's chat with this person.
// Returns { text, handoff } — handoff: the AI couldn't answer from the facts it has, so a
// person must reply (the chat is flagged "Needs human") — or null when no reply is needed.
//
// Built from real failures with the configured model: it answered Roman Urdu in Arabic or
// Hindi script, replied to an older topic instead of a plain greeting, invented services
// ("Yes, we offer SEO…") with no business info given, answered "ok"/"thanks", and sometimes
// repeated its whole answer twice. And it promised "I'll check and get back to you shortly" —
// which nothing ever does — so it now answers from the catalog or hands the chat to a person.
export const NO_REPLY = '[NO_REPLY]';
export const HANDOFF = '[HANDOFF]';
// A reply that says someone will come back ("our team will get back to you", "I'll check",
// "check kar ke batata hoon") is a promise only a person can keep — the chat is flagged for a
// person even when the model forgot the [HANDOFF] marker (seen with gpt-oss-20b).
const PROMISE_RX = /\b(get back to you|i'?ll (check|confirm|find out|look into|ask|forward|let you know)|let me (check|confirm|find out|ask)|(will|'ll) (get back|reply|respond|contact you|reach out|call you|update you|let you know|forward)|forward(ed)? (your|this|it) to|(check|confirm|pata) (kar|kr) ?(ke|k|kay|kai)|bata (deta|dete|doon|dun|denge|dain ge|dengy)|rabta (karenge|karen ge|krenge))\b/i;
const PROMISE_AR = /(سنعود|سنرد|سيرد|سيتواصل|سنتواصل|سيتولى|سوف نرد|سوف يرد)/;

// Which language/script their latest message is in. The configured model often missed Roman
// Urdu (Urdu typed in English letters) and answered in English, Arabic or Hindi script — so we
// detect it here and tell the model explicitly.
const ROMAN_URDU = new Set('hai hain ha hy hay he ho hoon hun ka ki ke ko kya kia kyun kyu kar kr karo krna karna krdo kardo nahi nai nhi theek thik bhai bhi ap aap apka apki apko mera meri mujhe mujy mujhy tum yar yaar kitne kitna kitni kaise kese kaisa acha achha ji jee abhi kal aaj wala wali sy mein raha rahi rha rhy rahy deta deeta dena lena chahiye chahye sakta sakti kab kahan ab phir fir bas jaldi shukriya salam assalam asslamoalikum assalamualaikum salamalaikum walaikum masla koi sab sath liye batao bata btao btaien prhana parhna namaz namaaz gaya gya ayega aye ay tak tk mil milega milegi milay jayega jayegi jaega jaegi jaye jae hoga hogi chahie kam zyada ziada sasta sasti bohat bahut boht zaroor haan han lekin magar sirf aur ya wo woh ye yeh apke apne hamare humare hum hamein kuch dena lena bhejo bhej bhejain karwa mangwana mangwa dikhao dikhaen chahte chahta chahti raha rahe'.split(' '));
export function languageOf(text = '') {
  if (/[\u0679\u0688\u0691\u06BA\u06BE\u06C1\u06D2]/.test(text)) return 'Urdu script'; // ٹ ڈ ڑ ں ھ ہ ے
  if (/[\u0600-\u06FF]/.test(text)) return 'Arabic';
  if (/[\u0900-\u097F]/.test(text)) return 'Hindi (Devanagari script)';
  const words = text.toLowerCase().match(/[a-z]+/g) || [];
  const hits = words.filter((w) => ROMAN_URDU.has(w)).length;
  if (hits >= 2 || (hits >= 1 && words.length <= 3)) return 'Roman Urdu';
  return 'English';
}
export async function conversationReply(history = [], opts = {}) {
  if (!aiAvailable()) throw new Error('AI not configured');
  const info = (opts.instructions ?? (getSetting('autoReplyInstructions', '') || getSetting('aiInstructions', ''))).trim();
  const tone = getSetting('aiTone', 'friendly') || 'friendly';
  const system = `You are the person managing this WhatsApp number, texting with a customer or contact. Write the next message.

Rules:
- Answer ONLY their latest message. Earlier messages are background — never bring up an older topic unless their latest message does.
- Match their language AND writing style exactly. Roman Urdu (Urdu/Hindi typed in English letters, e.g. "kitne ka hai?", "theek hai", "Asslamoalikum") → reply in Roman Urdu with English letters. Never use Arabic/Urdu script or Hindi (Devanagari) letters unless they wrote in that script. English → English. Arabic → Arabic.
- Keep it short, like a real person texting: 1–2 sentences, or a short list (at most 3 lines) when giving product options. Tone: ${tone}. Use an emoji only if they did.
- A salam (Asslamoalikum / Assalamualaikum / Salam) → reply "Walaikum Assalam" and ask how you can help. Any other greeting ("Hi") → greet back and ask how you can help.
- If they're only telling you something (they're busy, going to pray, will do it later, on the way) → a brief friendly acknowledgement, e.g. "Ji zaroor, koi masla nahi."
- "ok", "thanks", "theek hai", emoji-only and similar acknowledgements need no answer → output exactly ${NO_REPLY}
- "🎤 Voice message", "📷 Photo", "🎥 Video", "📄 …", "Sticker" are attachments you can't see or hear → say you got it and ask them to type the main point briefly.
- If they ask for help but don't say with what (e.g. "I need help with the POS"), ask ONE short question to find out what they need.
- Only state facts written below (Business info and Products). Never invent products, prices, specs, stock, links or policies.
- Products: when the list below has what they ask about, answer right away from it — name, price, and the link if there is one. If they ask what's available or for options, list up to 3 (in stock first) with prices — don't ask them to pick a model first. Say clearly when something is out of stock and offer an in-stock option from the list instead. If they gave a budget and nothing they asked for fits it, say so honestly and offer the nearest options listed, with prices.
- There is no "later" for you: you can't check anything, look anything up, or message them again on your own. Never say you'll check, confirm, look into it, find out, or get back to them.
- If the facts below don't answer their question — or they want something only a person can do (place or change an order, payment, delivery date, a complaint, a discount) — say honestly that you don't have that detail here and someone from the team will reply in this chat, and put ${HANDOFF} at the very end of your message. When you DID answer from the facts, don't add ${HANDOFF} and don't mention the team.
- A product's "Details" are facts from the store (description, specifications, colours, variants, stock…) — use them to answer questions about that product (what it does, specs, size, colour, what's included). Prices only from the price on the product line.
- Products marked "doesn't match: …" are NOT what they asked for (e.g. "doesn't match: gaming" = not a gaming laptop) — say so if you mention them.
- WhatsApp formatting only: *bold* with single asterisks, plain links (no [text](link)), no headings or tables.
- Never claim you checked, fixed or did something. Never mention being an AI or a bot.

Business info:
${info || '(none given — do not state any facts about the business, its services or prices)'}
${opts.products == null ? '' : `
Products from the store catalog for their message (facts you may use):
${opts.products || '(no product in the catalog matched their message)'}
`}
Output only the message text, or ${NO_REPLY}.`;
  const msgs = history
    .map((m) => ({ role: m.direction === 'in' ? 'user' : 'assistant', content: (m.body || '').trim() }))
    .filter((m) => m.content)
    .slice(-12);
  if (!msgs.length || msgs[msgs.length - 1].role !== 'user') return null; // nothing new from them
  const lang = languageOf(msgs[msgs.length - 1].content);
  const langLine = lang === 'Roman Urdu'
    ? 'Their latest message is in Roman Urdu → reply in Roman Urdu, using English letters only.'
    : `Their latest message is in ${lang} → reply in ${lang}.`;
  // Reasoning models (Groq gpt-oss) spend part of max_tokens thinking — leave room for the answer.
  let out = await chatMessages(`${system}\n\n${langLine}`, msgs, { temperature: 0.6, maxTokens: 900 });
  out = cleanReply(out);
  if (!out) throw new Error('empty reply from the AI');
  // A link that isn't in the facts was made up: ask once more, plainly; if it still invents one,
  // send nothing and hand the chat to a person — a fake link must never reach a customer.
  const facts = [info, opts.products || '', ...history.map((m) => m.body || '')].join('\n');
  let bad = inventedLinks(out, facts);
  if (bad.length) {
    const again = `${system}\n\n${langLine}\n\nIMPORTANT: there is NO link for anything except the links written in the facts above. Never write any other link, and never make one up. If they want a link that isn't listed, say you don't have it here and add ${HANDOFF}.`;
    out = cleanReply(await chatMessages(again, msgs, { temperature: 0.3, maxTokens: 900 }));
    bad = inventedLinks(out, facts);
    if (!out || bad.length) {
      console.warn(`[ai] reply had a made-up link (${bad.join(', ')}) — not sent, handed to a person`);
      return { text: '', handoff: true };
    }
  }
  if (out.includes(NO_REPLY)) return null;
  const text = cleanReply(out.replace(/\[\s*HANDOFF\s*\]/gi, ' ').replace(/[ \t]+\n/g, '\n').replace(/[ \t]{2,}/g, ' '));
  const handoff = /\[\s*HANDOFF\s*\]/i.test(out) || PROMISE_RX.test(text) || PROMISE_AR.test(text);
  return { text, handoff };
}

// Links the AI may write are only links it was given (products, business info, earlier messages).
// Real replay: Gemini timed out, Groq answered and invented "https://www.example.com/ugreen-…".
const URL_RX = /https?:\/\/[^\s<>()"'*]+/gi;
const trimUrl = (u) => u.replace(/[.,;:!?)\]]+$/, '');
export function inventedLinks(text, facts) {
  return [...new Set((String(text || '').match(URL_RX) || []).map(trimUrl))].filter((u) => !String(facts || '').includes(u));
}

// Tidy a model reply: drop wrapping quotes, turn Markdown into WhatsApp formatting (**bold** →
// *bold*, [text](link) → text: link, no # headings), and collapse an answer the model wrote twice
// in a row ("Hum check karte hain.Hum check karte hain." — seen with the configured model).
function cleanReply(text) {
  let t = String(text || '')
    .trim()
    .replace(/^["“](.*)["”]$/s, '$1')
    .replace(/\*\*(.+?)\*\*/g, '*$1*')
    .replace(/\[([^\]\n]+)\]\((https?:\/\/[^)\s]+)\)/g, (_, label, url) => (label.trim() === url ? url : `${label}: ${url}`))
    .replace(/^#{1,6}\s+/gm, '')
    // our product notes are for the model, not the customer ("(doesn't match: gaming)")
    .replace(/\s*\([^()\n]*doesn['’]t match:[^)\n]*\)/gi, '')
    .replace(/[ \t]*[—–-][ \t]*doesn['’]t match:[^\n]*/gi, '')
    .trim();
  for (let len = Math.floor(t.length / 2); len >= 8; len--) {
    const a = t.slice(0, len).trim();
    const b = t.slice(len).trim();
    if (a && a === b) return a;
  }
  return t;
}

// Draft a brand-new message from a plain-language description (template builder).
export async function draftMessage(prompt, opts = {}) {
  if (!aiAvailable()) throw new Error('AI is not configured — add an API key in Settings → AI');
  const tone = opts.tone || getSetting('aiTone', 'friendly');
  const system = `You write short, effective WhatsApp outreach messages.
Rules:
- Keep it concise: 2–5 short sentences.
- Natural and human, never spammy.
- Use {{first_name}} where a personal greeting fits.
- Add a clear, soft call to action when appropriate.
- No markdown headings or long paragraphs.
- Tone: ${tone}.
Output ONLY the message text.`;
  return chat(system, prompt, { temperature: 0.9 });
}
