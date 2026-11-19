import { db, audit, getSetting, setSetting, getPlatform, isWsSuspended, listWorkspaces, isMongoUp, oid, nowIso, dayKey } from '../db/mongo.js';
import { emit, bus } from '../events.js';
import fs from 'node:fs';
import path from 'node:path';
import { isConnected, sendText, sendTyping, sendImage, checkOnWhatsApp } from '../whatsapp/client.js';
import { isAccountConnected, sendFromTo, sendMediaFromTo, checkOnWhatsAppVia, accountRole, phoneOfAccount } from '../whatsapp/pool.js';
import { aiAvailable, rewriteMessage } from '../ai.js';
import { UPLOADS_DIR } from '../routes/uploads.js';
import { renderTemplate, randInt, nowInTz, withinWindow } from '../utils.js';
import { hasMain, defaultSenderId } from '../numbers.js';
import { DEFAULT_WS, currentWs, runInWs } from '../tenant.js';

// The number a campaign sends from: its chosen number (sender_id), else the main Gateway
// number — or, in a workspace without one, that workspace's default number (fallbackId).
export function senderIdOf(campaign, fallbackId = null) {
  return campaign.sender_id || (hasMain() ? null : fallbackId);
}

function senderFor(campaign, fallbackId = null) {
  const id = senderIdOf(campaign, fallbackId);
  if (id) {
    return {
      connected: () => isAccountConnected(id),
      check: (phone) => checkOnWhatsAppVia(id, phone),
      send: (phone, text) => sendFromTo(id, phone, text),
      sendMedia: (phone, buf, caption) => sendMediaFromTo(id, phone, buf, caption),
      typing: async () => {}, // pool send already sets "composing"
    };
  }
  if (!hasMain()) {
    // No main number here and no linked number connected.
    const off = async () => {
      throw new Error('No WhatsApp number connected');
    };
    return { connected: () => false, check: async () => ({ exists: false, reason: 'not_connected' }), send: off, sendMedia: off, typing: async () => {} };
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

// One paced loop per workspace: each business's campaigns go out at their own pace, and one
// workspace's sending never waits on (or mixes with) another's.
const loops = new Map(); // ws -> { timer, running }
const loopOf = (ws) => {
  let L = loops.get(ws);
  if (!L) {
    L = { timer: null, running: false };
    loops.set(ws, L);
  }
  return L;
};

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

async function nextEligibleTarget(fallbackId) {
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
    if (!senderFor(c, fallbackId).connected()) {
      await db.campaigns().updateOne({ _id: c._id }, { $set: { status: 'paused', pause_reason: 'sender_offline' } });
      audit(
        'campaign',
        `Campaign "${c.name}" paused — ${c.sender_id ? 'its sending number' : hasMain() ? 'the main WhatsApp number' : 'no WhatsApp number'} is not connected. Reconnect it, then press Start.`,
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

async function sendOne(campaign, target, contact, fallbackId) {
  const template = campaign.template_id
    ? await db.templates().findOne({ _id: oid(campaign.template_id) })
    : null;
  if (!template) {
    await db.targets().updateOne({ _id: target._id }, { $set: { status: 'failed', error: 'no template' } });
    return;
  }

  const sender = senderFor(campaign, fallbackId);
  const fromId = senderIdOf(campaign, fallbackId) || 'main';

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
      account_id: fromId, // which number this went out from
      account_phone: phoneOfAccount(fromId), // shows in that number's Conversations tab
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

// One send for the current workspace.
export async function tick() {
  const L = loopOf(currentWs() || DEFAULT_WS);
  if (L.running) return { skipped: true };
  if (isPaused()) return { paused: true };
  L.running = true;
  try {
    const fallbackId = hasMain() ? null : await defaultSenderId();
    const next = await nextEligibleTarget(fallbackId);
    if (!next || !next.target) return { idle: true, info: next };
    await sendOne(next.campaign, next.target, next.contact, fallbackId);
    const min = next.campaign.min_delay_sec || getSetting('minDelaySec', 35);
    const max = next.campaign.max_delay_sec || getSetting('maxDelaySec', 90);
    return { sent: true, delayMs: randInt(min, max) * 1000 };
  } catch (err) {
    audit('system', `Worker tick error: ${err.message}`, { level: 'error' });
    return { error: err.message };
  } finally {
    L.running = false;
  }
}

function scheduleNext(ws, delayMs) {
  const L = loopOf(ws);
  clearTimeout(L.timer);
  L.timer = setTimeout(() => runInWs(ws, () => loop(ws)), delayMs);
}

async function loop(ws) {
  let delay = 15000;
  try {
    const res = await tick();
    if (res.sent) delay = res.delayMs;
    else if (res.reason === 'not_connected') delay = 10000;
  } catch (err) {
    audit('system', `Worker error: ${err.message}`, { level: 'error' });
  }
  if (loops.has(ws)) scheduleNext(ws, delay);
}

// Keep one loop per workspace (new workspaces get one; deleted ones stop).
function superviseLoops() {
  if (!isMongoUp()) return;
  const ids = new Set(listWorkspaces().map((w) => w.id));
  for (const id of ids) if (!loops.has(id)) scheduleNext(id, 3000);
  for (const [id, L] of loops) {
    if (!ids.has(id)) {
      clearTimeout(L.timer);
      loops.delete(id);
    }
  }
}

export function startWorker() {
  console.log('  Paced sender worker started (one loop per workspace)');
  setTimeout(superviseLoops, 3000);
  setInterval(superviseLoops, 15000);
  // The main number came back → its workspace's campaigns can go out right away.
  bus.on('wa:status', (s, ws) => {
    if (s?.status === 'connected' && loops.has(ws || DEFAULT_WS)) scheduleNext(ws || DEFAULT_WS, 1500);
  });
}

// "Run Worker Cycle": one send now, for the current workspace.
export async function runCycleNow() {
  const ws = currentWs() || DEFAULT_WS;
  const res = await tick();
  if (res.sent && loops.has(ws)) scheduleNext(ws, res.delayMs);
  return res;
}

// Campaign sending for the current workspace. Paused is saved, so it stays paused after a
// restart until someone resumes it. The super admin can also pause every workspace at once,
// and a suspended workspace sends nothing.
export function setPaused(v) {
  setSetting('sendingPaused', !!v).catch(() => {});
}
export function isPaused() {
  return !!getSetting('sendingPaused', false) || !!getPlatform('sendingPaused', false) || isWsSuspended(currentWs() || DEFAULT_WS);
}
