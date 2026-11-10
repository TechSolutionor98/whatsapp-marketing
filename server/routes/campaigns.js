import { Router } from 'express';
import { db, audit, getSetting, oid, pub, nowIso } from '../db/mongo.js';
import { isConnected } from '../whatsapp/client.js';
import { isAccountConnected, accountRole } from '../whatsapp/pool.js';

export const campaigns = Router();

// Is the number this campaign sends from actually connected right now?
function senderConnected(c) {
  return c.sender_id ? isAccountConnected(c.sender_id) : isConnected();
}

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

// Resolve the human-readable template / sender / list names for a campaign.
async function namesFor(c) {
  let template_name = null;
  if (c.template_id) {
    const _tid = oid(c.template_id);
    if (_tid) template_name = (await db.templates().findOne({ _id: _tid }, { projection: { name: 1 } }))?.name || null;
  }
  let sender = null;
  if (c.sender_id) {
    const sd = await db.warmupAccounts().findOne({ _id: oid(c.sender_id) });
    sender = sd ? { phone: sd.phone, label: sd.label } : { phone: null, label: '(removed number)' };
  }
  let list_name = null;
  if (c.audience_list_id) {
    const _lid = oid(c.audience_list_id);
    if (_lid) list_name = (await db.lists().findOne({ _id: _lid }, { projection: { name: 1 } }))?.name || '(deleted list)';
  }
  return { template_name, sender, list_name };
}

campaigns.get('/:id', async (req, res) => {
  const _id = oid(req.params.id);
  if (!_id) return res.status(400).json({ error: 'Bad id' });
  const c = await db.campaigns().findOne({ _id });
  if (!c) return res.status(404).json({ error: 'Not found' });
  res.json({ ...pub(c), progress: await progressFor(String(c._id)) });
});

// Full detail: campaign + names + progress + the per-recipient list.
campaigns.get('/:id/detail', async (req, res) => {
  const _id = oid(req.params.id);
  if (!_id) return res.status(400).json({ error: 'Bad id' });
  const c = await db.campaigns().findOne({ _id });
  if (!c) return res.status(404).json({ error: 'Not found' });

  const targets = await db.targets().find({ campaign_id: String(_id) }).sort({ _id: 1 }).limit(2000).toArray();
  const cids = targets.map((t) => oid(t.contact_id)).filter(Boolean);
  const contacts = await db.contacts().find({ _id: { $in: cids } }).toArray();
  const cmap = new Map(contacts.map((x) => [String(x._id), x]));

  // Latest outbound delivery status per contact for this campaign.
  const msgs = await db
    .messages()
    .find({ campaign_id: String(_id), direction: 'out' }, { projection: { contact_id: 1, status: 1 } })
    .sort({ _id: 1 })
    .toArray();
  const dmap = new Map();
  for (const m of msgs) dmap.set(m.contact_id, m.status);

  const recipients = targets.map((t) => {
    const ct = cmap.get(t.contact_id);
    return {
      contact_id: t.contact_id,
      name: ct?.name || '',
      phone: ct?.phone || '',
      status: t.status, // queued | sent | failed | replied | skipped
      delivery: dmap.get(t.contact_id) || null, // sent | delivered | read
      error: t.error || null,
      sent_at: t.sent_at || null,
    };
  });

  res.json({
    ...pub(c),
    ...(await namesFor(c)),
    progress: await progressFor(String(c._id)),
    recipients,
  });
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

  // Changing the audience list re-scans members into the queue.
  const existing = await db.campaigns().findOne({ _id });
  if (!existing) return res.status(404).json({ error: 'Not found' });
  let rebuild = false;
  if (req.body.audience_list_id !== undefined) {
    const newListId = req.body.audience_list_id ? String(req.body.audience_list_id) : null;
    if (newListId !== (existing.audience_list_id || null)) {
      set.audience_list_id = newListId;
      rebuild = true;
    }
  }

  const r = await db.campaigns().findOneAndUpdate({ _id }, { $set: set }, { returnDocument: 'after' });
  const doc = r.value || r;
  if (!doc) return res.status(404).json({ error: 'Not found' });
  if (rebuild) await buildTargets(String(_id), { audienceFilter: doc.audience_filter, audienceListId: doc.audience_list_id });
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
  if (c.sender_id && accountRole(c.sender_id) === 'warmup')
    return res.status(400).json({ error: 'This campaign is set to a warm-up number. Edit it to send from your main or a linked number.' });
  // The assigned sending number must be connected to start.
  if (!senderConnected(c))
    return res.status(400).json({
      error: c.sender_id
        ? "This campaign's sending number isn't connected — connect it on the Warmup page, then start."
        : 'Your main WhatsApp number isn\'t connected — link it on the Gateway page, then start.',
    });
  await db.campaigns().updateOne({ _id }, { $set: { status: 'running', scheduled_at: null }, $unset: { pause_reason: '' } });
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
