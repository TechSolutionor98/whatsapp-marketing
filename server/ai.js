// Provider-agnostic AI layer. Talks to any OpenAI-compatible chat endpoint.
// Default provider: Groq (free, fast). Switchable to Gemini / Ollama / custom in Settings.
import { getSetting } from './db/mongo.js';

const PRESETS = {
  groq: 'https://api.groq.com/openai/v1',
  gemini: 'https://generativelanguage.googleapis.com/v1beta/openai',
  ollama: 'http://localhost:11434/v1',
};

function provider() {
  return getSetting('aiProvider', 'groq');
}
function baseUrl() {
  const p = provider();
  if (p === 'custom') return (getSetting('aiBaseUrl', '') || '').replace(/\/+$/, '');
  return PRESETS[p] || PRESETS.groq;
}
export function aiModel() {
  return getSetting('aiModel', 'openai/gpt-oss-20b') || 'openai/gpt-oss-20b'; // llama-3.3-70b-versatile no longer exists on Groq (404)
}
export function aiProviderName() {
  return provider();
}

// Available when we have what the chosen provider needs (Ollama needs no key).
export function aiAvailable() {
  if (provider() === 'ollama') return !!baseUrl();
  return !!process.env.AI_API_KEY;
}

async function chat(system, user, opts = {}) {
  return chatMessages(system, [{ role: 'user', content: user }], opts);
}

async function chatMessages(system, msgs, { maxTokens = 1024, temperature = 1 } = {}) {
  const base = baseUrl();
  if (!base) throw new Error('No AI endpoint configured');
  const key = process.env.AI_API_KEY;
  const headers = { 'Content-Type': 'application/json' };
  if (key && provider() !== 'ollama') headers.Authorization = `Bearer ${key}`;

  const body = {
    model: aiModel(),
    temperature,
    max_tokens: maxTokens,
    messages: [{ role: 'system', content: system }, ...msgs],
  };
  // Groq's GPT-OSS/Qwen models are reasoning models — keep reasoning minimal so
  // the token budget goes to the actual answer (otherwise content can come back empty).
  if (provider() === 'groq') body.reasoning_effort = 'low';

  const resp = await fetch(`${base}/chat/completions`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });
  if (!resp.ok) {
    const t = await resp.text().catch(() => '');
    throw new Error(`AI error ${resp.status}: ${t.slice(0, 200)}`);
  }
  const data = await resp.json();
  return (data.choices?.[0]?.message?.content || '').trim();
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
// Returns the reply text, or null when the latest message needs no reply ("ok", "thanks").
//
// Built from real failures with the configured model: it answered Roman Urdu in Arabic or
// Hindi script, replied to an older topic instead of a plain greeting, invented services
// ("Yes, we offer SEO…") with no business info given, answered "ok"/"thanks", and sometimes
// repeated its whole answer twice.
export const NO_REPLY = '[NO_REPLY]';

// Which language/script their latest message is in. The configured model often missed Roman
// Urdu (Urdu typed in English letters) and answered in English, Arabic or Hindi script — so we
// detect it here and tell the model explicitly.
const ROMAN_URDU = new Set('hai hain ha hy hay he ho hoon hun ka ki ke ko kya kia kyun kyu kar kr karo krna karna krdo kardo nahi nai nhi theek thik bhai bhi ap aap apka apki apko mera meri mujhe mujy mujhy tum yar yaar kitne kitna kitni kaise kese kaisa acha achha ji jee abhi kal aaj wala wali sy mein raha rahi rha rhy rahy deta deeta dena lena chahiye chahye sakta sakti kab kahan ab phir fir bas jaldi shukriya salam assalam asslamoalikum assalamualaikum salamalaikum walaikum masla koi sab sath liye batao bata btao btaien prhana parhna namaz namaaz gaya gya ayega aye ay'.split(' '));
export function languageOf(text = '') {
  if (/[\u0600-\u06FF]/.test(text)) return 'Urdu script';
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
- Match their language AND writing style exactly. Roman Urdu (Urdu/Hindi typed in English letters, e.g. "kitne ka hai?", "theek hai", "Asslamoalikum") → reply in Roman Urdu with English letters. Never use Arabic/Urdu script or Hindi (Devanagari) letters unless they wrote in that script. English → English.
- Keep it to 1–2 short sentences, like a real person texting. Tone: ${tone}. Use an emoji only if they did.
- A salam (Asslamoalikum / Assalamualaikum / Salam) → reply "Walaikum Assalam" and ask how you can help. Any other greeting ("Hi") → greet back and ask how you can help.
- If they're only telling you something (they're busy, going to pray, will do it later, on the way) → a brief friendly acknowledgement, e.g. "Ji zaroor, koi masla nahi." — don't promise to check anything.
- "ok", "thanks", "theek hai", emoji-only and similar acknowledgements need no answer → output exactly ${NO_REPLY}
- "🎤 Voice message", "📷 Photo", "🎥 Video", "📄 …", "Sticker" are attachments you can't see or hear → say you got it and ask them to type the main point briefly.
- If they ask for help but don't say with what exactly (e.g. "I need help with the POS"), ask ONE short question to find out what they need — don't just say you'll get back to them.
- Only state facts written below (Business info and Products). When the Products list has what they're asking about, answer directly with the product name, price and link, and say if it's out of stock; if several fit, give up to 3 short options or ask which one they mean. Never invent products, prices, specs or stock.
- For anything not covered below, don't guess and don't say yes or no — say you'll confirm and get back to them shortly.
- Never claim you checked, fixed or did something. Never mention being an AI or a bot.

Business info:
${info || '(none given — do not state any facts about the business, its services or prices)'}
${opts.products == null ? '' : `
Products from the store catalog that match their message (facts you may use):
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
  if (out.includes(NO_REPLY)) return null;
  return out;
}

// Tidy a model reply: drop wrapping quotes, and collapse an answer the model wrote twice in a
// row ("Hum check karte hain.Hum check karte hain." — seen with the configured model).
function cleanReply(text) {
  let t = String(text || '').trim().replace(/^["“](.*)["”]$/s, '$1').trim();
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
