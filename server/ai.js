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
  return getSetting('aiModel', 'llama-3.3-70b-versatile');
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
  const firstName = (contact.name || '').trim().split(/\s+/)[0] || '';

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
// [{direction:'in'|'out', body}]. Returns a short, natural reply.
export async function conversationReply(history = [], opts = {}) {
  if (!aiAvailable()) throw new Error('AI not configured');
  const instructions = opts.instructions ?? getSetting('autoReplyInstructions', '');
  const system = `You are a helpful, friendly assistant replying to a customer on WhatsApp on behalf of a business.
Rules:
- Reply naturally in 1–3 short sentences, like a real person texting.
- Reply in the same language the customer used.
- Be warm and concise. Do NOT invent prices, facts, or promises you weren't given.
- If they want to buy, need something specific, or you can't help, say a team member will follow up shortly.
${instructions ? `Business context & guidance:\n${instructions}` : ''}
Output ONLY the reply text.`;
  const msgs = history
    .map((m) => ({ role: m.direction === 'in' ? 'user' : 'assistant', content: (m.body || '').trim() }))
    .filter((m) => m.content)
    .slice(-12);
  if (!msgs.length || msgs[msgs.length - 1].role !== 'user') return '';
  return chatMessages(system, msgs, { temperature: 0.7, maxTokens: 400 });
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
