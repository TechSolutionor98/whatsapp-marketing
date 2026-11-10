import { db, audit, getSetting, oid, nowIso, dayKey } from '../db/mongo.js';
import { emit, bus } from '../events.js';
import fs from 'node:fs';
import path from 'node:path';
import { isConnected, sendText, sendTyping, sendImage, checkOnWhatsApp } from '../whatsapp/client.js';
import { isAccountConnected, sendFromTo, sendMediaFromTo, checkOnWhatsAppVia, accountRole } from '../whatsapp/pool.js';
import { aiAvailable, rewriteMessage } from '../ai.js';
import { UPLOADS_DIR } from '../routes/uploads.js';
import { renderTemplate, randInt, nowInTz, withinWindow } from '../utils.js';

// A campaign sends either from the main Gateway number (sender_id null) or a warm-up pool number.
function senderFor(campaign) {
  if (campaign.sender_id) {
    const id = campaign.sender_id;
    return {
      connected: () => isAccountConnected(id),
      check: (phone) => checkOnWhatsAppVia(id, phone),
      send: (phone, text) => sendFromTo(id, phone, text),
      sendMedia: (phone, buf, caption) => sendMediaFromTo(id, phone, buf, caption),
      typing: async () => {}, // pool send already sets "composing"
    };
  }
  return {
    connected: () => isConnected(),
    check: (phone) => checkOnWhatsApp(phone),
    send: (phone, text) => sendText(phone, text),
    sendMedia: (phone, buf, caption) => sendImage(phone, buf, caption),
    typing: (phone, ms) => sendTyping(phone, ms),
  };
}

// Load a template's image (if any) as a Buffer, or null.
function loadMedia(template) {
  if (!template.media_url) return null;
  try {
    return fs.readFileSync(path.join(UPLOADS_DIR, path.basename(template.media_url)));
  } catch {
    return null;
  }
}

let running = false;
let loopTimer = null;
let paused = false;

async function globalSentToday() {
  return db.messages().countDocuments({ direction: 'out', day_key: dayKey() });
}

async function daysSinceFirstSend() {
  const first = await db
    .messages()
    .find({ direction: 'out' }, { projection: { created_at: 1 } })
    .sort({ _id: 1 })
    .limit(1)
    .toArray();
  if (!first.length) return 0;
  const t = new Date(first[0].created_at).getTime();
  return Math.max(0, Math.floor((Date.now() - t) / 86400000));
}

async function warmupCeiling() {
  const hardCap = getSetting('dailyLimit', 150);
  if (!getSetting('warmupEnabled', true)) return hardCap;
  const start = getSetting('warmupStart', 20);
  const step = getSetting('warmupStep', 20);
  return Math.min(hardCap, start + step * (await daysSinceFirstSend()));
}

async function resetDaily(c) {
  const { date } = nowInTz(c.timezone);
  if (c.sent_today_date !== date) {
    await db.campaigns().updateOne({ _id: c._id }, { $set: { sent_today: 0, sent_today_date: date } });
    c.sent_today = 0;
    c.sent_today_date = date;
  }
}

// Promote scheduled campaigns whose start time has arrived.
async function promoteScheduled() {
  const nowIso = new Date().toISOString();
  const due = await db
    .campaigns()
    .find({ status: 'scheduled', scheduled_at: { $lte: nowIso } })
    .toArray();
  for (const c of due) {
    await db.campaigns().updateOne({ _id: c._id }, { $set: { status: 'running', scheduled_at: null } });
    audit('campaign', `Scheduled campaign "${c.name}" started automatically`, { level: 'success' });
    emit('campaign:update', { id: String(c._id) });
  }
}

async function nextEligibleTarget() {
  await promoteScheduled();
  const campaigns = await db.campaigns().find({ status: 'running' }).sort({ _id: 1 }).toArray();

  const ceiling = await warmupCeiling();
  const globalSent = await globalSentToday();
  if (globalSent >= ceiling) return { reason: 'global_cap', ceiling, globalSent };

  for (const c of campaigns) {
    await resetDaily(c);
    // Warm-up numbers are isolated — they can't send campaigns.
    if (c.sender_id && accountRole(c.sender_id) === 'warmup') {
      await db.campaigns().updateOne({ _id: c._id }, { $set: { status: 'paused', pause_reason: 'warmup_sender' } });
      audit('campaign', `Campaign "${c.name}" paused — its number is a warm-up number. Edit the campaign to send from your main or a linked number.`, { level: 'warn' });
      emit('campaign:update', { id: String(c._id) });
      continue;
    }
    // A campaign must send from its assigned number. If that number isn't connected,
    // stop the campaign and tell the user to reconnect it (don't silently do nothing).
    if (!senderFor(c).connected()) {
      await db.campaigns().updateOne({ _id: c._id }, { $set: { status: 'paused', pause_reason: 'sender_offline' } });
      audit(
        'campaign',
        `Campaign "${c.name}" paused — ${c.sender_id ? 'its sending number' : 'the main WhatsApp number'} is not connected. Reconnect it, then press Start.`,
        { level: 'warn' }
      );
      emit('campaign:update', { id: String(c._id) });
      continue;
    }
    const { hhmm } = nowInTz(c.timezone);
    if (!withinWindow(hhmm, c.window_start, c.window_end)) continue;
    if (c.sent_today >= c.daily_limit) continue;

    const queued = await db
      .targets()
      .find({ campaign_id: String(c._id), status: 'queued' })
      .sort({ _id: 1 })
      .limit(100)
      .toArray();

    for (const t of queued) {
      const _cid = oid(t.contact_id);
      const contact = _cid ? await db.contacts().findOne({ _id: _cid }) : null;
      if (!contact) {
        await db.targets().updateOne({ _id: t._id }, { $set: { status: 'failed', error: 'contact removed' } });
        continue;
      }
      if (contact.status === 'opted_out' || contact.status === 'bounced') {
        await db.targets().updateOne({ _id: t._id }, { $set: { status: 'skipped' } });
        continue;
      }
      if (contact.handoff === 1) continue; // in a human conversation
      return { campaign: c, target: t, contact };
    }

    // Nothing left to send -> complete the campaign.
    const remaining = await db.targets().countDocuments({ campaign_id: String(c._id), status: 'queued' });
    if (remaining === 0) {
      await db.campaigns().updateOne({ _id: c._id }, { $set: { status: 'completed' } });
      audit('campaign', `Campaign "${c.name}" completed`, { level: 'success' });
      emit('campaign:update', { id: String(c._id) });
    }
  }
  return null;
}

async function sendOne(campaign, target, contact) {
  const template = campaign.template_id
    ? await db.templates().findOne({ _id: oid(campaign.template_id) })
    : null;
  if (!template) {
    await db.targets().updateOne({ _id: target._id }, { $set: { status: 'failed', error: 'no template' } });
    return;
  }

  const sender = senderFor(campaign);

  // Verify the number is on WhatsApp before spending a send.
  const check = await sender.check(contact.phone);
  if (!check.exists) {
    await db.targets().updateOne({ _id: target._id }, { $set: { status: 'failed', error: 'not_on_whatsapp' } });
    await db.contacts().updateOne({ _id: contact._id }, { $set: { status: 'bounced' } });
    audit('send', `${contact.phone} is not on WhatsApp — skipped`, {
      level: 'warn',
      meta: { contactId: String(contact._id) },
    });
    emit('stats:dirty', {});
    return;
  }

  let text = renderTemplate(template.body, contact);

  // AI variation: rewrite uniquely per recipient so no two sends match (anti-ban).
  const useAi = campaign.ai_rewrite ?? getSetting('aiEnabled', false);
  if (useAi && aiAvailable()) {
    text = await rewriteMessage(text, contact, { tone: campaign.ai_tone });
  }

  const media = loadMedia(template);
  try {
    if (getSetting('typingSimulation', true)) await sender.typing(contact.phone, randInt(900, 2200));
    const waId = media
      ? await sender.sendMedia(contact.phone, media, text)
      : await sender.send(contact.phone, text);

    await db.targets().updateOne(
      { _id: target._id },
      { $set: { status: 'sent', sent_at: nowIso(), wa_message_id: waId } }
    );
    await db.messages().insertOne({
      contact_id: String(contact._id),
      campaign_id: String(campaign._id),
      account_id: campaign.sender_id || 'main', // which number this went out from
      direction: 'out',
      body: text,
      media_url: template.media_url || null,
      status: 'sent',
      wa_message_id: waId,
      created_at: nowIso(),
      day_key: dayKey(),
    });
    await db.contacts().updateOne({ _id: contact._id }, { $set: { last_outbound_at: nowIso() } });
    await db.campaigns().updateOne({ _id: campaign._id }, { $inc: { sent_today: 1 } });

    audit('send', `Sent to ${contact.name || contact.phone}`, {
      meta: { campaignId: String(campaign._id), contactId: String(contact._id) },
    });
    emit('message:out', { contactId: String(contact._id), campaignId: String(campaign._id) });
    emit('stats:dirty', {});
  } catch (err) {
    await db.targets().updateOne({ _id: target._id }, { $set: { status: 'failed', error: err.message } });
    audit('send', `Failed to ${contact.phone}: ${err.message}`, {
      level: 'error',
      meta: { contactId: String(contact._id) },
    });
    emit('stats:dirty', {});
  }
}

export async function tick() {
  if (running) return { skipped: true };
  if (paused) return { paused: true };
  running = true;
  try {
    const next = await nextEligibleTarget();
    if (!next || !next.target) return { idle: true, info: next };
    await sendOne(next.campaign, next.target, next.contact);
    const min = next.campaign.min_delay_sec || getSetting('minDelaySec', 35);
    const max = next.campaign.max_delay_sec || getSetting('maxDelaySec', 90);
    return { sent: true, delayMs: randInt(min, max) * 1000 };
  } catch (err) {
    audit('system', `Worker tick error: ${err.message}`, { level: 'error' });
    return { error: err.message };
  } finally {
    running = false;
  }
}

function scheduleNext(delayMs) {
  clearTimeout(loopTimer);
  loopTimer = setTimeout(loop, delayMs);
}

async function loop() {
  let delay = 15000;
  try {
    const res = await tick();
    if (res.sent) delay = res.delayMs;
    else if (res.reason === 'not_connected') delay = 10000;
  } catch (err) {
    audit('system', `Worker error: ${err.message}`, { level: 'error' });
  }
  scheduleNext(delay);
}

export function startWorker() {
  audit('system', 'Paced sender worker started', { level: 'info' });
  scheduleNext(3000);
  bus.on('wa:status', (s) => {
    if (s.status === 'connected') scheduleNext(1500);
  });
}

export async function runCycleNow() {
  const res = await tick();
  if (res.sent) scheduleNext(res.delayMs);
  return res;
}

export function setPaused(v) {
  paused = !!v;
}
export function isPaused() {
  return paused;
}
