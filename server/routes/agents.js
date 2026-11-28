// The AI Agents page: create and change website chat assistants, try one before it goes live,
// and read what website visitors asked. (The website's side is routes/agent-public.js.)
import { Router } from 'express';
import { db, oid, audit, dayKey, isMongoUp } from '../db/mongo.js';
import { aiAvailable, aiProviderName, keySource } from '../ai.js';
import { getLimits } from '../limits.js';
import { listNumbers } from '../numbers.js';
import {
  AgentError,
  MAX_AGENTS,
  MAX_MESSAGE,
  PER_AGENT_DAY,
  KEEP_DAYS,
  agentPublic,
  answer,
  businessInfoFromSettings,
  cleanAgent,
  newAgentDoc,
  handoffPhone,
  waLink,
} from '../agents.js';

export const agents = Router();

function fail(res, e) {
  if (e instanceof AgentError) return res.status(e.status).json({ error: e.message, code: e.code });
  console.error('  [agents] error:', e?.stack || e);
  res.status(500).json({ error: e?.message || 'Something went wrong' });
}
async function load(id) {
  const _id = oid(id);
  const a = _id ? await db.agents().findOne({ _id }) : null;
  if (!a) throw new AgentError(404, 'not_found', 'Agent not found. It may have been deleted.');
  return a;
}

// Everything the page shows: agents with their numbers, catalogs to pick from, the numbers
// for the WhatsApp button, and whether AI can answer at all.
agents.get('/', async (_req, res) => {
  try {
    const [list, cats, counts, numbers] = await Promise.all([
      db.agents().find().sort({ created_at: 1 }).toArray(),
      db.catalogs().find({}, { projection: { name: 1, type: 1 } }).sort({ created_at: 1 }).toArray(),
      db.products().aggregate([{ $group: { _id: '$catalog_id', n: { $sum: 1 } } }]).toArray(),
      listNumbers().catch(() => []),
    ]);
    const today = dayKey();
    const chatRows = await db
      .agentChats()
      .aggregate([{ $group: { _id: '$agent_id', chats: { $sum: 1 }, today: { $sum: { $cond: [{ $eq: ['$day_key', today] }, 1, 0] } } } }])
      .toArray();
    const stats = new Map(chatRows.map((r) => [r._id, r]));
    const n = new Map(counts.map((c) => [c._id, c.n]));
    const def = numbers.find((x) => x.default) || numbers[0] || null;
    const L = getLimits();
    res.json({
      agents: list.map((a) => agentPublic(a, stats.get(String(a._id)))),
      catalogs: cats.map((c) => ({ id: String(c._id), name: c.name, type: c.type, count: n.get(String(c._id)) || 0 })),
      products: [...n.values()].reduce((s, x) => s + x, 0),
      numbers: numbers.map((x) => ({ phone: x.phone, label: x.label || '', default: !!x.default })),
      default_phone: def?.phone || null,
      business_info: businessInfoFromSettings(),
      ai: { available: aiAvailable(), allowed: !!L.allowAi, provider: aiProviderName(), key: keySource() },
      limits: { maxAgents: MAX_AGENTS, perDay: PER_AGENT_DAY, maxMessage: MAX_MESSAGE, keepDays: KEEP_DAYS },
    });
  } catch (e) {
    fail(res, e);
  }
});

agents.post('/', async (req, res) => {
  try {
    if ((await db.agents().countDocuments({})) >= MAX_AGENTS) throw new AgentError(400, 'too_many', `You can have up to ${MAX_AGENTS} agents. Delete one you don't use first.`);
    const b = { ...(req.body || {}) };
    if (b.info === undefined) b.info = businessInfoFromSettings(); // start from what the WhatsApp AI already knows
    const doc = newAgentDoc(b, req.user);
    await db.agents().insertOne(doc);
    audit('system', `AI agent "${doc.name}" created`);
    res.status(201).json(agentPublic(doc));
  } catch (e) {
    fail(res, e);
  }
});

agents.put('/:id', async (req, res) => {
  try {
    const a = await load(req.params.id);
    const set = { ...cleanAgent(req.body || {}, a), updated_at: new Date().toISOString() };
    await db.agents().updateOne({ _id: a._id }, { $set: set });
    if ('enabled' in set && set.enabled !== a.enabled) audit('system', `AI agent "${set.name || a.name}" switched ${set.enabled ? 'on' : 'off'}`);
    res.json(agentPublic({ ...a, ...set }));
  } catch (e) {
    fail(res, e);
  }
});

agents.delete('/:id', async (req, res) => {
  try {
    const a = await load(req.params.id);
    await db.agents().deleteOne({ _id: a._id });
    const r = await db.agentChats().deleteMany({ agent_id: String(a._id) });
    audit('system', `AI agent "${a.name}" deleted (and ${r.deletedCount} website chat${r.deletedCount === 1 ? '' : 's'})`, { level: 'warn' });
    res.json({ ok: true });
  } catch (e) {
    fail(res, e);
  }
});

// Try an agent with the settings on screen (saved or not). Nothing is stored or counted.
// { agent: { name, info, tone, catalogs, handoff }, messages: [{ role: 'visitor'|'agent', text }] }
agents.post('/test', async (req, res) => {
  try {
    if (!isMongoUp()) throw new AgentError(503, 'unavailable', 'Database unavailable — try again in a moment');
    const b = req.body || {};
    const agent = cleanAgent({ ...(b.agent || {}), info: String(b.agent?.info ?? '') });
    const messages = (Array.isArray(b.messages) ? b.messages : [])
      .filter((m) => m && (m.role === 'visitor' || m.role === 'agent') && typeof m.text === 'string' && m.text.trim())
      .slice(-13)
      .map((m) => ({ role: m.role, text: m.text.trim().slice(0, MAX_MESSAGE) }));
    if (!messages.length || messages[messages.length - 1].role !== 'visitor') throw new AgentError(400, 'empty_message', 'Type a message first.');
    if (!aiAvailable()) throw new AgentError(503, 'ai_off', getLimits().allowAi ? 'AI is not set up for this workspace yet. Add an AI key in Settings → AI.' : 'AI is switched off by the super admin.');
    const r = await answer(agent, messages);
    res.json({ reply: r.text, handoff: !!r.handoff, whatsapp: r.whatsapp || null });
  } catch (e) {
    if (!(e instanceof AgentError)) return fail(res, new AgentError(502, 'ai_failed', `The AI didn't answer: ${String(e.message).slice(0, 200)}`));
    fail(res, e);
  }
});

// Which number the WhatsApp button would open, for the settings on screen.
agents.post('/whatsapp-preview', async (req, res) => {
  try {
    const h = cleanAgent({ handoff: req.body?.handoff || {} }).handoff;
    res.json({ whatsapp: waLink(await handoffPhone({ handoff: h })) });
  } catch (e) {
    fail(res, e);
  }
});

// ---- Website chats ----

const chatRow = (c, names) => ({
  id: String(c._id),
  agent_id: c.agent_id,
  agent_name: names.get(c.agent_id) || 'Deleted agent',
  first_text: c.first_text || '',
  last_text: c.last_text || '',
  messages: c.count ?? (c.messages || []).length,
  visitor_msgs: c.visitor_msgs || 0,
  handoff: !!c.handoff,
  page: c.page || '',
  started_at: c.started_at,
  last_at: c.last_at,
});

agents.get('/chats', async (req, res) => {
  try {
    const q = {};
    if (req.query.agent) q.agent_id = String(req.query.agent);
    if (req.query.handoff === '1') q.handoff = true;
    const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 50));
    const before = String(req.query.before || '');
    if (before) q.last_at = { $lt: before };
    const [rows, list, total] = await Promise.all([
      db.agentChats().aggregate([
        { $match: q },
        { $sort: { last_at: -1 } },
        { $limit: limit },
        { $project: { messages: 0, session_hash: 0 } },
      ]).toArray(),
      db.agents().find({}, { projection: { name: 1 } }).toArray(),
      db.agentChats().countDocuments(q),
    ]);
    // message counts without loading every chat's messages
    const ids = rows.map((r) => r._id);
    const counts = ids.length ? await db.agentChats().aggregate([{ $match: { _id: { $in: ids } } }, { $project: { n: { $size: { $ifNull: ['$messages', []] } } } }]).toArray() : [];
    const cnt = new Map(counts.map((c) => [String(c._id), c.n]));
    const names = new Map(list.map((a) => [String(a._id), a.name]));
    res.json({ chats: rows.map((r) => chatRow({ ...r, count: cnt.get(String(r._id)) || 0 }, names)), total, more: rows.length === limit });
  } catch (e) {
    fail(res, e);
  }
});

agents.get('/chats/:id', async (req, res) => {
  try {
    const _id = oid(req.params.id);
    const c = _id ? await db.agentChats().findOne({ _id }, { projection: { session_hash: 0 } }) : null;
    if (!c) throw new AgentError(404, 'not_found', 'Chat not found. Chats are removed 90 days after the last message.');
    const a = await db.agents().findOne({ _id: oid(c.agent_id) }, { projection: { name: 1 } });
    res.json({ ...chatRow(c, new Map([[c.agent_id, a?.name || 'Deleted agent']])), list: (c.messages || []).map((m) => ({ role: m.role, text: m.text, at: m.at, handoff: !!m.handoff, failed: !!m.failed })) });
  } catch (e) {
    fail(res, e);
  }
});

agents.delete('/chats/:id', async (req, res) => {
  try {
    const _id = oid(req.params.id);
    const r = _id ? await db.agentChats().deleteOne({ _id }) : { deletedCount: 0 };
    if (!r.deletedCount) throw new AgentError(404, 'not_found', 'Chat not found.');
    res.json({ ok: true });
  } catch (e) {
    fail(res, e);
  }
});
