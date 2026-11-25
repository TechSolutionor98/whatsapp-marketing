// Platform rules — set by the super admin on the Super Admin page, they apply to EVERY
// workspace: nobody can set a value outside them (Settings, campaigns, warm-up) and the workers
// enforce them even on campaigns saved before a rule changed. Plus the settings every new
// workspace starts with.
import { getPlatform, setPlatform, getSetting, getAllSettings, setSetting, col, db, isMongoUp } from './db/mongo.js';
import { DEFAULTS } from './config.js';
import { DEFAULT_WS, currentWs, runInWs } from './tenant.js';

// 0 / '' = no limit.
export const LIMIT_DEFAULTS = {
  minDelaySec: 60, // at least this many seconds between two campaign messages
  maxPerNumberDay: 100, // campaign messages one WhatsApp number may send a day
  windowStart: '', // campaigns may not send before this time ('' = any time)
  windowEnd: '', // …or after this time
  forceTyping: false, // always show "typing…" before a campaign message
  forceRamp: false, // a fresh number's daily volume always ramps up slowly
  warmupMaxPerDay: 0, // warm-up messages a day (0 = no cap)
  warmupMinGap: 0, // seconds between warm-up messages (0 = no floor)
  maxNumbers: 0, // WhatsApp numbers one workspace may link (0 = unlimited)
  maxTeam: 0, // people in one workspace (0 = unlimited)
  allowAi: true, // workspaces may use AI (message variation, auto-reply, warm-up chats)
  sharePlatformKey: false, // workspaces without their own AI key may use the server's (.env) key
  // Official WhatsApp API numbers (Meta Cloud API) can't be banned for volume the way QR-linked
  // numbers can — Meta sets their limits. Off: the minimum gap and per-number daily cap above
  // don't apply to them. On: they follow these rules too.
  officialFollowRules: false,
  // Developer API (POS buttons, websites, other software sending through a workspace's number).
  allowApi: true, // workspaces may create API keys and send through the API
  apiMaxPerNumberDay: 500, // API messages one QR-linked number may send a day (0 = no cap; official numbers: Meta's limits)
  // The Developer page's sending settings (each workspace sets its own, inside these):
  apiMaxPerBatch: 0, // most API messages sent at a time (0 = up to 50)
  apiMinGapSec: 0, // fewest seconds between API batches (0 = none)
  apiMaxQueue: 0, // most API messages that may wait in a workspace's queue (0 = up to 5,000)
};

const hhmm = (v) => (/^([01]\d|2[0-3]):[0-5]\d$/.test(String(v || '')) ? String(v) : '');
const nonNeg = (v) => Math.max(0, Math.floor(Number(v) || 0));

export function getLimits() {
  return { ...LIMIT_DEFAULTS, ...(getPlatform('limits', null) || {}) };
}

// Clean what the Super Admin page sent.
export function cleanLimits(b = {}) {
  const cur = getLimits();
  const out = { ...cur };
  for (const k of ['minDelaySec', 'maxPerNumberDay', 'warmupMaxPerDay', 'warmupMinGap', 'maxNumbers', 'maxTeam', 'apiMaxPerNumberDay', 'apiMaxPerBatch', 'apiMinGapSec', 'apiMaxQueue']) if (k in b) out[k] = nonNeg(b[k]);
  for (const k of ['windowStart', 'windowEnd']) if (k in b) out[k] = hhmm(b[k]);
  for (const k of ['forceTyping', 'forceRamp', 'allowAi', 'sharePlatformKey', 'officialFollowRules', 'allowApi']) if (k in b) out[k] = !!b[k];
  if (out.windowStart && out.windowEnd && out.windowStart >= out.windowEnd) throw new Error('Sending hours: the start must be before the end');
  return out;
}

// ---- Keeping values inside the rules ----

// Workspace settings → inside the rules. Returns the changed keys with a short reason.
export function clampSettings(s, L = getLimits()) {
  const out = { ...s };
  const notes = [];
  const fix = (k, v, why) => {
    if (out[k] !== v) {
      out[k] = v;
      notes.push(why);
    }
  };
  const num = (k, d) => (out[k] === undefined ? d : Number(out[k]) || 0);
  if ('minDelaySec' in out || 'maxDelaySec' in out) {
    const min = Math.max(num('minDelaySec', 0), L.minDelaySec || 0);
    if ('minDelaySec' in out) fix('minDelaySec', min, `Gap between messages is at least ${L.minDelaySec} sec`);
    if ('maxDelaySec' in out) fix('maxDelaySec', Math.max(num('maxDelaySec', 0), min), 'The longest gap can\'t be shorter than the shortest');
  }
  if ('dailyLimit' in out && L.maxPerNumberDay) fix('dailyLimit', Math.min(num('dailyLimit', 0), L.maxPerNumberDay), `At most ${L.maxPerNumberDay} messages a day`);
  if ('windowStart' in out && L.windowStart && String(out.windowStart) < L.windowStart) fix('windowStart', L.windowStart, `Sending starts no earlier than ${L.windowStart}`);
  if ('windowEnd' in out && L.windowEnd && String(out.windowEnd) > L.windowEnd) fix('windowEnd', L.windowEnd, `Sending ends no later than ${L.windowEnd}`);
  if ('typingSimulation' in out && L.forceTyping) fix('typingSimulation', true, '"Typing…" is always on');
  if ('warmupEnabled' in out && L.forceRamp) fix('warmupEnabled', true, 'Gradual warm-up is always on');
  if ('warmupDailyMax' in out && L.warmupMaxPerDay) fix('warmupDailyMax', Math.min(num('warmupDailyMax', 0), L.warmupMaxPerDay), `At most ${L.warmupMaxPerDay} warm-up messages a day`);
  if ('warmupMinGap' in out && L.warmupMinGap) fix('warmupMinGap', Math.max(num('warmupMinGap', 0), L.warmupMinGap), `Warm-up gap is at least ${L.warmupMinGap} sec`);
  if ('warmupMaxGap' in out && 'warmupMinGap' in out) fix('warmupMaxGap', Math.max(num('warmupMaxGap', 0), num('warmupMinGap', 0)), 'The longest warm-up gap can\'t be shorter than the shortest');
  // The Developer API's sending settings (one object) → inside the API rules.
  if (out.apiSending && typeof out.apiSending === 'object') {
    const b = apiSendingBounds(L);
    const cur = out.apiSending;
    const next = { ...cur };
    const into = (k, [lo, hi], why) => {
      if (cur[k] == null) return;
      const v = Math.min(hi, Math.max(lo, Number(cur[k]) || 0));
      if (v !== Number(cur[k])) {
        next[k] = v;
        notes.push(why);
      }
    };
    into('per_batch', b.per_batch, `At most ${b.per_batch[1]} API messages at a time`);
    into('gap_seconds', b.gap_seconds, `At least ${b.gap_seconds[0]} seconds between API batches`);
    into('max_queue', b.max_queue, `An API queue holds at most ${b.max_queue[1]} messages`);
    if (JSON.stringify(next) !== JSON.stringify(cur)) out.apiSending = next;
  }
  if (!L.allowAi) {
    if ('aiEnabled' in out) fix('aiEnabled', false, 'AI is switched off by the super admin');
    if ('autoReplyEnabled' in out) fix('autoReplyEnabled', false, 'AI is switched off by the super admin');
    if ('warmupUseAi' in out) fix('warmupUseAi', false, 'AI is switched off by the super admin');
  }
  return { settings: out, notes: [...new Set(notes)] };
}

// What a workspace may set on its Developer page: [lowest, highest] for each sending setting,
// narrowed by the super admin's API rules.
export function apiSendingBounds(L = getLimits()) {
  const perBatchHi = L.apiMaxPerBatch ? Math.min(50, L.apiMaxPerBatch) : 50;
  const gapLo = Math.min(3600, L.apiMinGapSec || 0);
  const queueHi = L.apiMaxQueue ? Math.min(5000, L.apiMaxQueue) : 5000;
  return { per_batch: [1, Math.max(1, perBatchHi)], gap_seconds: [gapLo, 3600], max_queue: [Math.min(10, queueHi), Math.max(1, queueHi)] };
}

// Do the anti-ban gap and daily cap apply to this campaign? (Not to official API numbers,
// unless the super admin says so.)
export const antiBanApplies = (official, L = getLimits()) => !official || !!L.officialFollowRules;

// A campaign's own pacing fields → inside the rules. Sending hours apply to every number.
export function clampCampaign(c, L = getLimits(), { official = false } = {}) {
  const out = { ...c };
  if (!antiBanApplies(official, L)) {
    if ('window_start' in out && L.windowStart && String(out.window_start) < L.windowStart) out.window_start = L.windowStart;
    if ('window_end' in out && L.windowEnd && String(out.window_end) > L.windowEnd) out.window_end = L.windowEnd;
    return out;
  }
  if ('daily_limit' in out && L.maxPerNumberDay) out.daily_limit = Math.min(Number(out.daily_limit) || 0, L.maxPerNumberDay);
  if ('min_delay_sec' in out) out.min_delay_sec = Math.max(Number(out.min_delay_sec) || 0, L.minDelaySec || 0);
  if ('max_delay_sec' in out) out.max_delay_sec = Math.max(Number(out.max_delay_sec) || 0, Number(out.min_delay_sec ?? L.minDelaySec) || 0, L.minDelaySec || 0);
  if ('window_start' in out && L.windowStart && String(out.window_start) < L.windowStart) out.window_start = L.windowStart;
  if ('window_end' in out && L.windowEnd && String(out.window_end) > L.windowEnd) out.window_end = L.windowEnd;
  return out;
}

// What the sender actually uses for a campaign (stored values, then the rules on top).
export function campaignPacing(c, L = getLimits(), { official = false } = {}) {
  if (!antiBanApplies(official, L)) {
    const min = Math.max(1, Number(c.min_delay_sec) || getSetting('minDelaySec', 35));
    return { min, max: Math.max(Number(c.max_delay_sec) || getSetting('maxDelaySec', 90), min), daily: Number(c.daily_limit) || 0 };
  }
  const min = Math.max(Number(c.min_delay_sec) || getSetting('minDelaySec', 35), L.minDelaySec || 0);
  const max = Math.max(Number(c.max_delay_sec) || getSetting('maxDelaySec', 90), min);
  const daily = L.maxPerNumberDay ? Math.min(Number(c.daily_limit) || 0, L.maxPerNumberDay) : Number(c.daily_limit) || 0;
  return { min, max, daily };
}

// Is now inside the platform's sending hours (in the campaign's time zone)?
export function insidePlatformHours(hm, L = getLimits()) {
  if (L.windowStart && hm < L.windowStart) return false;
  if (L.windowEnd && hm > L.windowEnd) return false;
  return true;
}

// Rules just changed → bring every workspace's stored settings and campaigns inside them, so
// every page shows the values that really apply.
export async function enforceEverywhere(L = getLimits()) {
  if (!isMongoUp()) return { settings: 0, campaigns: 0 };
  let settingsChanged = 0;
  for (const d of await col('settings').find({ _id: { $ne: 'platform' } }).toArray()) {
    const ws = d._id === 'global' ? DEFAULT_WS : String(d._id).startsWith('ws:') ? String(d._id).slice(3) : null;
    if (!ws) continue;
    await runInWs(ws, async () => {
      const { settings, notes } = clampSettings(getAllSettings(), L);
      if (!notes.length) return;
      for (const [k, v] of Object.entries(settings)) if (getSetting(k) !== v) await setSetting(k, v);
      settingsChanged++;
    });
  }
  const C = col('campaigns');
  let n = 0;
  const qr = L.officialFollowRules ? {} : { official: { $ne: true } }; // official-number campaigns follow Meta's limits
  if (L.maxPerNumberDay) n += (await C.updateMany({ ...qr, daily_limit: { $gt: L.maxPerNumberDay } }, { $set: { daily_limit: L.maxPerNumberDay } })).modifiedCount;
  if (L.minDelaySec) {
    n += (await C.updateMany({ ...qr, min_delay_sec: { $lt: L.minDelaySec } }, { $set: { min_delay_sec: L.minDelaySec } })).modifiedCount;
    n += (await C.updateMany({ ...qr, max_delay_sec: { $lt: L.minDelaySec } }, { $set: { max_delay_sec: L.minDelaySec } })).modifiedCount;
  }
  if (L.windowStart) n += (await C.updateMany({ window_start: { $lt: L.windowStart } }, { $set: { window_start: L.windowStart } })).modifiedCount;
  if (L.windowEnd) n += (await C.updateMany({ window_end: { $gt: L.windowEnd } }, { $set: { window_end: L.windowEnd } })).modifiedCount;
  return { settings: settingsChanged, campaigns: n };
}

// ---- Workspace limits (numbers, team) ----

// Can the current workspace link one more number?
export async function canLinkNumber() {
  const L = getLimits();
  if (!L.maxNumbers) return null;
  const linked = (await db.warmupAccounts().countDocuments({})) + ((currentWs() || DEFAULT_WS) === DEFAULT_WS && getSetting('mainPhone', null) ? 1 : 0);
  return linked >= L.maxNumbers ? `This workspace can link up to ${L.maxNumbers} WhatsApp number${L.maxNumbers === 1 ? '' : 's'} (set by the super admin). Unlink one first.` : null;
}

// Can this workspace have one more person?
export async function canAddPerson(ws) {
  const L = getLimits();
  if (!L.maxTeam) return null;
  const n = await col('users').countDocuments({ ws, role: { $ne: 'owner' } });
  return n >= L.maxTeam ? `A workspace can have up to ${L.maxTeam} ${L.maxTeam === 1 ? 'person' : 'people'} (set by the super admin).` : null;
}

// ---- Settings every new workspace starts with ----
export const DEFAULT_KEYS = [
  'dailyLimit', 'minDelaySec', 'maxDelaySec', 'typingSimulation', 'windowStart', 'windowEnd', 'timezone',
  'warmupEnabled', 'warmupStart', 'warmupStep', 'handoffOnReply', 'stopKeywords',
  'warmupDailyStart', 'warmupDailyStep', 'warmupDailyMax', 'warmupMinGap', 'warmupMaxGap', 'warmupWindowStart', 'warmupWindowEnd', 'warmupUseAi',
  'aiEnabled', 'aiProvider', 'aiModel', 'aiTone', 'autoReplyMinSec', 'autoReplyMaxSec',
];
const pick = (o) => Object.fromEntries(DEFAULT_KEYS.filter((k) => k in o).map((k) => [k, o[k]]));

export function getWsDefaults() {
  return clampSettings({ ...pick(DEFAULTS), ...(getPlatform('wsDefaults', null) || {}) }).settings;
}
export async function saveWsDefaults(b = {}) {
  const clean = {};
  for (const k of DEFAULT_KEYS) {
    if (!(k in b)) continue;
    const def = DEFAULTS[k];
    const v = b[k];
    if (typeof def === 'number') clean[k] = Math.max(0, Number(v) || 0);
    else if (typeof def === 'boolean') clean[k] = !!v;
    else if (Array.isArray(def)) clean[k] = (Array.isArray(v) ? v : String(v || '').split(',')).map((x) => String(x).trim().toLowerCase()).filter(Boolean);
    else clean[k] = String(v ?? '').trim();
  }
  const { settings, notes } = clampSettings({ ...getWsDefaults(), ...clean });
  await setPlatform('wsDefaults', settings);
  return { defaults: settings, notes };
}

// The settings of one workspace that the defaults cover (for "copy from a workspace").
export function defaultsOf() {
  return pick(getAllSettings());
}
