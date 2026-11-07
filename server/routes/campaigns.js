import { Router } from 'express';
import { db, audit, getSetting, oid, pub, nowIso } from '../db/mongo.js';

export const campaigns = Router();

function esc(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

async function progressFor(campaignId) {
  const rows = await db
    .targets()
    .aggregate([
      { $match: { campaign_id: campaignId } },
      { $group: { _id: '$status', c: { $sum: 1 } } },
    ])
    .toArray();
  const p = { queued: 0, sent: 0, failed: 0, replied: 0, skipped: 0 };
  for (const r of rows) if (r._id in p) p[r._id] = r.c;
  p.total = p.queued + p.sent + p.failed + p.replied + p.skipped;
  p.done = p.sent + p.failed + p.replied + p.skipped;
  p.percent = p.total ? Math.round((p.done / p.total) * 100) : 0;

  // Delivery/read receipts (from the outbound messages of this campaign).
  const msgRows = await db
    .messages()
    .aggregate([
      { $match: { campaign_id: campaignId, direction: 'out' } },
      { $group: { _id: '$status', c: { $sum: 1 } } },
    ])
    .toArray();
  let delivered = 0,
    read = 0;
  for (const r of msgRows) {
    if (r._id === 'read') {
      read += r.c;
      delivered += r.c;
    } else if (r._id === 'delivered') delivered += r.c;
  }
  p.delivered = delivered;
  p.read = read;
  return p;
}

async function buildTargets(campaignIdStr, { audienceFilter = '', audienceListId = '' } = {}) {
  // never cold-message warm-up numbers or synced personal WhatsApp chats
  const filter = { status: 'active', warmup: { $ne: 1 }, synced: { $ne: 1 } };
  if (audienceListId) filter.list_ids = audienceListId;
  else if (audienceFilter) filter.tags = new RegExp(esc(audienceFilter), 'i');
  const contactsList = await db
    .contacts()
    .find(filter, { projection: { _id: 1 } })
    .toArray();
  const existing = await db
    .targets()
    .find({ campaign_id: campaignIdStr }, { projection: { contact_id: 1 } })
    .toArray();
  const have = new Set(existing.map((t) => t.contact_id));
  const toInsert = contactsList
    .filter((c) => !have.has(String(c._id)))
    .map((c) => ({
      campaign_id: campaignIdStr,
      contact_id: String(c._id),
      status: 'queued',
      sent_at: null,
      error: null,
      wa_message_id: null,
    }));
  if (toInsert.length) await db.targets().insertMany(toInsert, { ordered: false }).catch(() => {});
  return contactsList.length;
}

campaigns.get('/', async (_req, res) => {
  const list = await db.campaigns().find().sort({ _id: -1 }).toArray();
  const out = [];
  for (const c of list) {
    let template_name = null;
    if (c.template_id) {
      const _tid = oid(c.template_id);
      if (_tid) {
        const t = await db.templates().findOne({ _id: _tid }, { projection: { name: 1 } });
        template_name = t?.name || null;
      }
    }
    let sender = null;
    if (c.sender_id) {
      const sd = await db.warmupAccounts().findOne({ _id: oid(c.sender_id) });
      sender = sd ? { phone: sd.phone, label: sd.label } : { phone: null, label: '(removed number)' };
    }
    let list_name = null;
    if (c.audience_list_id) {
      const _lid = oid(c.audience_list_id);
      if (_lid) {
        const l = await db.lists().findOne({ _id: _lid }, { projection: { name: 1 } });
        list_name = l?.name || '(deleted list)';
      }
    }
    out.push({ ...pub(c), template_name, sender, list_name, progress: await progressFor(String(c._id)) });
  }
  res.json(out);
});

campaigns.get('/:id', async (req, res) => {
  const _id = oid(req.params.id);
  if (!_id) return res.status(400).json({ error: 'Bad id' });
  const c = await db.campaigns().findOne({ _id });
  if (!c) return res.status(404).json({ error: 'Not found' });
  res.json({ ...pub(c), progress: await progressFor(String(c._id)) });
});

campaigns.post('/', async (req, res) => {
  const d = {
    name: req.body.name,
    template_id: req.body.template_id ? String(req.body.template_id) : null,
    status: 'draft',
    daily_limit: req.body.daily_limit ?? getSetting('dailyLimit', 150),
    window_start: req.body.window_start ?? getSetting('windowStart', '09:00'),
    window_end: req.body.window_end ?? getSetting('windowEnd', '21:00'),
    timezone: req.body.timezone ?? getSetting('timezone', 'Asia/Karachi'),
    min_delay_sec: req.body.min_delay_sec ?? getSetting('minDelaySec', 35),
    max_delay_sec: req.body.max_delay_sec ?? getSetting('maxDelaySec', 90),
    audience_filter: req.body.audience_filter ?? '',
    audience_list_id: req.body.audience_list_id ? String(req.body.audience_list_id) : null,
    sender_id: req.body.sender_id ? String(req.body.sender_id) : null, // null = main Gateway number
    ai_rewrite: req.body.ai_rewrite ?? getSetting('aiEnabled', false),
    ai_tone: req.body.ai_tone ?? getSetting('aiTone', 'friendly'),
    scheduled_at: null,
    sent_today: 0,
    sent_today_date: null,
    created_at: nowIso(),
  };
  if (!d.name) return res.status(400).json({ error: 'Campaign name required' });

  // Optional: schedule it to auto-start at a future time.
  const when = req.body.scheduled_at ? new Date(req.body.scheduled_at) : null;
  if (when && !isNaN(when) && when.getTime() > Date.now()) {
    d.status = 'scheduled';
    d.scheduled_at = when.toISOString();
  }

  const r = await db.campaigns().insertOne(d);
  await buildTargets(String(r.insertedId), { audienceFilter: d.audience_filter, audienceListId: d.audience_list_id });
  audit('campaign', `Campaign created: ${d.name}`, { level: 'success' });
  res.json(pub({ _id: r.insertedId, ...d }));
});

campaigns.put('/:id', async (req, res) => {
  const _id = oid(req.params.id);
  if (!_id) return res.status(400).json({ error: 'Bad id' });
  const fields = [
    'name',
    'template_id',
    'daily_limit',
    'window_start',
    'window_end',
    'timezone',
    'min_delay_sec',
    'max_delay_sec',
    'ai_rewrite',
    'ai_tone',
    'sender_id',
  ];
  const set = {};
  for (const f of fields)
    if (req.body[f] !== undefined)
      set[f] =
        f === 'template_id' || f === 'sender_id'
          ? req.body[f]
            ? String(req.body[f])
            : null
          : req.body[f];
  const r = await db.campaigns().findOneAndUpdate({ _id }, { $set: set }, { returnDocument: 'after' });
  const doc = r.value || r;
  if (!doc) return res.status(404).json({ error: 'Not found' });
  res.json(pub(doc));
});

campaigns.post('/:id/start', async (req, res) => {
  const _id = oid(req.params.id);
  if (!_id) return res.status(400).json({ error: 'Bad id' });
  const c = await db.campaigns().findOne({ _id });
  if (!c) return res.status(404).json({ error: 'Not found' });
  if (!c.template_id) return res.status(400).json({ error: 'Attach a template before starting' });
  const queued = await db.targets().countDocuments({ campaign_id: String(_id), status: 'queued' });
  if (queued === 0) return res.status(400).json({ error: 'No queued recipients left' });
  await db.campaigns().updateOne({ _id }, { $set: { status: 'running', scheduled_at: null } });
  audit('campaign', `Campaign "${c.name}" started`, { level: 'success' });
  res.json({ ok: true });
});

campaigns.post('/:id/pause', async (req, res) => {
  const _id = oid(req.params.id);
  if (!_id) return res.status(400).json({ error: 'Bad id' });
  const c = await db.campaigns().findOne({ _id });
  if (!c) return res.status(404).json({ error: 'Not found' });
  await db.campaigns().updateOne({ _id }, { $set: { status: 'paused', scheduled_at: null } });
  audit('campaign', `Campaign "${c.name}" paused`);
  res.json({ ok: true });
});

// Schedule (or reschedule) a campaign to auto-start at a future time.
campaigns.post('/:id/schedule', async (req, res) => {
  const _id = oid(req.params.id);
  if (!_id) return res.status(400).json({ error: 'Bad id' });
  const c = await db.campaigns().findOne({ _id });
  if (!c) return res.status(404).json({ error: 'Not found' });
  if (!c.template_id) return res.status(400).json({ error: 'Attach a template first' });
  const when = new Date(req.body.scheduled_at || '');
  if (isNaN(when) || when.getTime() <= Date.now())
    return res.status(400).json({ error: 'Pick a future date and time' });
  const queued = await db.targets().countDocuments({ campaign_id: String(_id), status: 'queued' });
  if (queued === 0) return res.status(400).json({ error: 'No queued recipients left' });
  await db.campaigns().updateOne({ _id }, { $set: { status: 'scheduled', scheduled_at: when.toISOString() } });
  audit('campaign', `Campaign "${c.name}" scheduled for ${when.toISOString()}`);
  res.json({ ok: true });
});

campaigns.post('/:id/rebuild', async (req, res) => {
  const _id = oid(req.params.id);
  if (!_id) return res.status(400).json({ error: 'Bad id' });
  const c = await db.campaigns().findOne({ _id });
  if (!c) return res.status(404).json({ error: 'Not found' });
  const n = await buildTargets(String(_id), { audienceFilter: c.audience_filter, audienceListId: c.audience_list_id });
  res.json({ ok: true, scanned: n, progress: await progressFor(String(_id)) });
});

campaigns.delete('/:id', async (req, res) => {
  const _id = oid(req.params.id);
  if (!_id) return res.status(400).json({ error: 'Bad id' });
  await db.campaigns().deleteOne({ _id });
  await db.targets().deleteMany({ campaign_id: String(_id) });
  res.json({ ok: true });
});
