// The website chat widget's side of AI Agents (/api/agent/:id/…): public, no sign-in. The id is
// the agent's public id (ag_…), which is in the website's HTML anyway. Each request finds the
// agent, then runs inside its workspace. Answers are JSON; errors are
// { "error": { "code", "message" } } with a message a visitor can read.
import express, { Router } from 'express';
import { col, isMongoUp, workspaceOf } from '../db/mongo.js';
import { runInWs } from '../tenant.js';
import { getLimits } from '../limits.js';
import { aiAvailable } from '../ai.js';
import {
  AgentError,
  MAX_MESSAGE,
  MAX_SESSION,
  answer,
  clientIp,
  findChat,
  newSession,
  originAllowed,
  publicConfig,
  saveTurn,
  takeDailySlot,
  visitorLimited,
} from '../agents.js';
import { emit } from '../events.js';

export const agentPublic = Router();

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
function sendError(res, e) {
  const status = e instanceof AgentError ? e.status : 500;
  const code = e instanceof AgentError ? e.code : 'server_error';
  const message = e instanceof AgentError ? e.message : 'Something went wrong. Please try again in a moment.';
  if (!(e instanceof AgentError)) console.error('  [agent] error:', e?.stack || e);
  res.status(status).json({ error: { code, message } });
}

// Any website may call these (the agent's "Websites" list is checked per request). No cookies.
agentPublic.use((req, res, next) => {
  res.set({
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '86400',
    'Cache-Control': 'no-store',
  });
  res.removeHeader('Access-Control-Allow-Credentials');
  if (req.method === 'OPTIONS') return res.status(204).end();
  next();
});
agentPublic.use(express.json({ limit: '16kb', type: ['application/json', 'text/plain'] }));

// The agent behind a public id → req.agent, and the rest runs in its workspace.
agentPublic.use('/:pub', async (req, res, next) => {
  try {
    if (!isMongoUp()) throw new AgentError(503, 'unavailable', 'The chat is starting up. Please try again in a moment.');
    const pub = String(req.params.pub || '');
    if (!/^ag_[a-f0-9]{20}$/.test(pub)) throw new AgentError(404, 'not_found', 'This chat assistant was not found.');
    const agent = await col('agents').findOne({ pub_id: pub });
    if (!agent) throw new AgentError(404, 'not_found', 'This chat assistant was not found. It may have been deleted.');
    const w = workspaceOf(agent.ws);
    if (!w || w.pending || w.suspended) throw new AgentError(403, 'unavailable', 'This chat is not available right now.');
    req.agent = agent;
    runInWs(agent.ws, next);
  } catch (e) {
    sendError(res, e);
  }
});

function checkOpen(req) {
  const a = req.agent;
  if (!a.enabled) throw new AgentError(403, 'agent_off', 'This chat is switched off right now.');
  if (!originAllowed(a, req)) throw new AgentError(403, 'website_not_allowed', 'This chat assistant is not set up for this website. (AI Agents → the agent → Websites.)');
  if (!getLimits().allowAi || !aiAvailable()) throw new AgentError(503, 'ai_off', "The assistant can't answer right now. Please try again later.");
}

// What the widget needs to draw itself.
agentPublic.get('/:pub/config', async (req, res) => {
  try {
    checkOpen(req);
    res.json(await publicConfig(req.agent));
  } catch (e) {
    sendError(res, e);
  }
});

// A visitor's message → the agent's answer. { message, session?, page? } → { session, reply, … }
agentPublic.post('/:pub/chat', async (req, res) => {
  const agent = req.agent;
  try {
    checkOpen(req);
    const b = req.body && typeof req.body === 'object' ? req.body : {};
    const text = String(b.message ?? '').replace(/\r\n/g, '\n').trim();
    if (!text) throw new AgentError(400, 'empty_message', 'Type a message first.');
    if (text.length > MAX_MESSAGE) throw new AgentError(400, 'message_too_long', `That message is too long. Please keep it under ${MAX_MESSAGE} characters.`);
    const wait = visitorLimited(agent.pub_id, clientIp(req), typeof b.session === 'string' ? b.session : '');
    if (wait) {
      res.set('Retry-After', String(wait));
      const mins = Math.ceil(wait / 60);
      throw new AgentError(429, 'too_many_messages', `You're sending messages very fast. Please wait ${wait <= 60 ? `${wait} second${wait === 1 ? '' : 's'}` : `${mins} minute${mins === 1 ? '' : 's'}`} and try again.`);
    }
    let session = typeof b.session === 'string' ? b.session : '';
    const chat = await findChat(agent, session);
    if (!chat) session = newSession(); // new visitor, an old chat that was removed, or a made-up token
    if ((chat?.visitor_msgs || 0) >= MAX_SESSION) {
      throw new AgentError(429, 'chat_full', 'This chat is getting long. Please start a new chat (the ↻ button at the top).');
    }
    if (!(await takeDailySlot(agent))) throw new AgentError(429, 'daily_limit', "The assistant has answered a lot of questions today and is resting. Please try again tomorrow.");

    const history = [...(chat?.messages || []).filter((m) => !m.failed).slice(-12).map((m) => ({ role: m.role, text: m.text })), { role: 'visitor', text }];
    let reply;
    try {
      reply = await answer(agent, history);
    } catch (e) {
      if (e instanceof AgentError) throw e;
      console.warn(`  [agent] no AI answer (${String(e.message).slice(0, 160)})`);
      const cfg = await publicConfig(agent);
      reply = {
        text: cfg.whatsapp ? "Sorry, I can't answer right now. Tap \"Chat on WhatsApp\" to talk to the team." : "Sorry, I can't answer right now. Please try again in a minute.",
        handoff: !!cfg.whatsapp,
        whatsapp: cfg.whatsapp,
        failed: true,
      };
    }
    const chatId = await saveTurn(agent, { chat, session, page: b.page, visitorText: text, reply });
    emit('agent:chat', { agentId: String(agent._id), chatId: String(chatId) });
    res.json({ session, reply: reply.text, handoff: !!reply.handoff, whatsapp: reply.handoff ? reply.whatsapp || null : null });
  } catch (e) {
    sendError(res, e);
  }
});

// A plain page with the chat on it, to see the widget before adding it to a website.
agentPublic.get('/:pub/preview', (req, res) => {
  const a = req.agent;
  res.set('Cache-Control', 'no-store');
  res.type('html').send(`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(a.name)} — chat preview</title>
<style>
  :root { color-scheme: light; }
  body { margin: 0; font: 16px/1.55 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; background: #f6f7f9; color: #1f2937; }
  header { background: #fff; border-bottom: 1px solid #e5e7eb; padding: 16px 20px; display: flex; align-items: center; gap: 10px; }
  header b { font-size: 17px; }
  .tag { margin-left: auto; font-size: 12px; background: #eef2ff; color: #3730a3; border-radius: 999px; padding: 3px 10px; }
  main { max-width: 760px; margin: 0 auto; padding: 32px 20px 120px; }
  h1 { font-size: 28px; line-height: 1.2; margin: 0 0 10px; }
  p { color: #4b5563; }
  .blocks { display: grid; grid-template-columns: repeat(auto-fill, minmax(200px, 1fr)); gap: 14px; margin-top: 26px; }
  .blocks div { height: 120px; border-radius: 12px; background: #e9ebef; }
  .off { background: #fef3c7; color: #92400e; border-radius: 10px; padding: 12px 14px; }
</style>
</head>
<body>
<header><b>Your website</b><span class="tag">Preview</span></header>
<main>
  <h1>This is how the chat looks on your website</h1>
  <p>The round button at the bottom ${a.position === 'left' ? 'left' : 'right'} opens <strong>${esc(a.name)}</strong>. Ask it about your products, prices or opening hours, like a visitor would.</p>
  ${a.enabled ? '' : '<p class="off">This agent is switched off, so the chat button won’t show. Turn it on in AI Agents.</p>'}
  <div class="blocks"><div></div><div></div><div></div><div></div><div></div><div></div></div>
</main>
<script src="/widget.js" data-agent="${esc(a.pub_id)}" data-open="true" async></script>
</body>
</html>`);
});

// A body that isn't JSON, or is far too big: the visitor-readable error shape, not Express's page.
// eslint-disable-next-line no-unused-vars
agentPublic.use((err, _req, res, _next) => {
  if (err?.type === 'entity.too.large') return sendError(res, new AgentError(413, 'too_large', 'That message is too long.'));
  if (err?.type === 'entity.parse.failed' || err instanceof SyntaxError) return sendError(res, new AgentError(400, 'bad_request', 'Send the message as JSON: { "message": "…" }'));
  sendError(res, err);
});
