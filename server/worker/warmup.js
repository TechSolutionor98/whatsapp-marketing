import { db, audit, getSetting, nowIso, dayKey, listWorkspaces, isWsSuspended } from '../db/mongo.js';
import { emit } from '../events.js';
import { connectedAccounts, sendFromTo, reconnectPoolAccounts } from '../whatsapp/pool.js';
import { resumeApiQueues } from '../developer.js';
import { isMongoUp } from '../db/mongo.js';
import { DEFAULT_WS, currentWs, runInWs } from '../tenant.js';
import { getLimits } from '../limits.js';
import { aiAvailable, warmupOpener, warmupReply } from '../ai.js';
import { spin, randInt, sleep, nowInTz, withinWindow, WARMUP_POOL, WARMUP_REPLIES } from '../utils.js';

// One warm-up loop per workspace: a workspace's numbers only ever chat with each other.
const loops = new Map(); // ws -> { timer, running }
const loopOf = (ws) => {
  let L = loops.get(ws);
  if (!L) {
    L = { timer: null, running: false };
    loops.set(ws, L);
  }
  return L;
};
let reconnected = false;

async function sentToday() {
  return db.warmupLog().countDocuments({ day_key: dayKey() });
}

async function warmupDay() {
  const first = await db
    .warmupLog()
    .find({}, { projection: { created_at: 1 } })
    .sort({ _id: 1 })
    .limit(1)
    .toArray();
  if (!first.length) return 0;
  const t = new Date(first[0].created_at).getTime();
  return Math.max(0, Math.floor((Date.now() - t) / 86400000));
}

export async function dailyTarget() {
  const start = getSetting('warmupDailyStart', 5);
  const step = getSetting('warmupDailyStep', 3);
  const cap = getLimits().warmupMaxPerDay; // the super admin's cap for every workspace
  const max = cap ? Math.min(getSetting('warmupDailyMax', 40), cap) : getSetting('warmupDailyMax', 40);
  return Math.min(max, start + step * (await warmupDay()));
}

export async function warmupStatus() {
  const [today, target, day, total] = await Promise.all([
    sentToday(),
    dailyTarget(),
    warmupDay(),
    db.warmupLog().countDocuments({}),
  ]);
  const accts = connectedAccounts();
  return {
    active: getSetting('warmupActive', false),
    sentToday: today,
    dailyTarget: target,
    day: day + 1,
    total,
    connected: accts.length,
    windowStart: getSetting('warmupWindowStart', '10:00'),
    windowEnd: getSetting('warmupWindowEnd', '20:00'),
  };
}

async function logMsg(from, to, body) {
  await db.warmupLog().insertOne({
    from_id: from.id,
    to_id: to.id,
    from_phone: from.me.phone,
    to_phone: to.me.phone,
    body,
    created_at: nowIso(),
    day_key: dayKey(),
  });
  emit('stats:dirty', {});
  emit('warmup:update', {});
}

function pick(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

const firstName = (n) => (n || '').split(' ')[0] || '';
const useAi = () => aiAvailable() && getSetting('warmupUseAi', true);
// Gaps between warm-up chats, never shorter than the super admin allows.
function warmupGap() {
  const min = Math.max(getSetting('warmupMinGap', 180), getLimits().warmupMinGap || 0);
  return { min, max: Math.max(getSetting('warmupMaxGap', 900), min) };
}

async function makeOpener(toName) {
  if (useAi()) {
    try {
      const t = (await warmupOpener(firstName(toName))).trim();
      if (t) return t;
    } catch {
      /* fall back to pool */
    }
  }
  return spin(pick(WARMUP_POOL)).replace(/\{\{first_name\}\}/g, firstName(toName));
}

async function makeReply(incoming, toName) {
  if (useAi()) {
    try {
      const t = (await warmupReply(incoming, firstName(toName))).trim();
      if (t) return t;
    } catch {
      /* fall back to pool */
    }
  }
  return spin(pick(WARMUP_REPLIES)).replace(/\{\{first_name\}\}/g, firstName(toName));
}

// One mini-conversation between two of this workspace's numbers: A -> B, then B -> A.
async function tick() {
  const L = loopOf(currentWs() || DEFAULT_WS);
  if (L.running) return { skipped: true };
  if (!getSetting('warmupActive', false)) return { inactive: true };
  if (isWsSuspended(currentWs() || DEFAULT_WS)) return { inactive: true };
  L.running = true;
  try {
    const target = await dailyTarget();
    if ((await sentToday()) >= target) return { done_for_today: true };

    const tz = getSetting('timezone', 'Asia/Karachi');
    const { hhmm } = nowInTz(tz);
    if (!withinWindow(hhmm, getSetting('warmupWindowStart', '10:00'), getSetting('warmupWindowEnd', '20:00')))
      return { outside_window: true };

    const accts = connectedAccounts();
    if (accts.length < 2) return { need_two: true, connected: accts.length };

    // Pick a distinct ordered pair.
    const a = pick(accts);
    let b = pick(accts);
    let guard = 0;
    while (b.id === a.id && guard++ < 10) b = pick(accts);
    if (b.id === a.id) return { need_two: true };

    // A greets B.
    const opener = await makeOpener(b.me.name);
    try {
      await sendFromTo(a.id, b.me.phone, opener);
      await logMsg(a, b, opener);
    } catch (e) {
      return { error: e.message };
    }

    // Short, human pause, then B replies to A — only if we're still under target.
    if ((await sentToday()) < target) {
      await sleep(randInt(5000, 14000));
      const reply = await makeReply(opener, a.me.name);
      try {
        await sendFromTo(b.id, a.me.phone, reply);
        await logMsg(b, a, reply);
      } catch {
        /* reply is best-effort */
      }
    }

    audit('warmup', `Warm-up chat: ${a.me.name || a.me.phone} ↔ ${b.me.name || b.me.phone}`);
    const { min, max } = warmupGap();
    return { sent: true, delayMs: randInt(min, max) * 1000 };
  } finally {
    L.running = false;
  }
}

function scheduleNext(ws, ms) {
  const L = loopOf(ws);
  clearTimeout(L.timer);
  L.timer = setTimeout(() => runInWs(ws, () => loop(ws)), ms);
}

async function loop(ws) {
  let delay = 60000;
  try {
    const res = await tick();
    if (res.sent) delay = res.delayMs;
  } catch (err) {
    audit('system', `Warm-up worker error: ${err.message}`, { level: 'error' });
  }
  if (loops.has(ws)) scheduleNext(ws, delay);
}

// Once Mongo is ready: reconnect every saved number (each in its own workspace), then keep
// one warm-up loop per workspace.
function supervise() {
  if (!isMongoUp()) return;
  if (!reconnected) {
    reconnected = true;
    reconnectPoolAccounts();
    resumeApiQueues().catch(() => {}); // the Developer API's queued messages go out once numbers are back
  }
  const ids = new Set(listWorkspaces().map((w) => w.id));
  for (const id of ids) if (!loops.has(id)) scheduleNext(id, 6000);
  for (const [id, L] of loops) {
    if (!ids.has(id)) {
      clearTimeout(L.timer);
      loops.delete(id);
    }
  }
}

export function startWarmupWorker() {
  setTimeout(supervise, 6000);
  setInterval(supervise, 15000);
}

// "Run now" on the Warmup page — for the current workspace.
export async function runWarmupNow() {
  const ws = currentWs() || DEFAULT_WS;
  const res = await tick();
  if (res.sent && loops.has(ws)) scheduleNext(ws, res.delayMs);
  return res;
}
