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
  for (const k of ['minDelaySec', 'maxPerNumberDay', 'warmupMaxPerDay', 'warmupMinGap', 'maxNumbers', 'maxTeam']) if (k in b) out[k] = nonNeg(b[k]);
  for (const k of ['windowStart', 'windowEnd']) if (k in b) out[k] = hhmm(b[k]);
  for (const k of ['forceTyping', 'forceRamp', 'allowAi']) if (k in b) out[k] = !!b[k];
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
  if (!L.allowAi) {
    if ('aiEnabled' in out) fix('aiEnabled', false, 'AI is switched off by the super admin');
    if ('autoReplyEnabled' in out) fix('autoReplyEnabled', false, 'AI is switched off by the super admin');
    if ('warmupUseAi' in out) fix('warmupUseAi', false, 'AI is switched off by the super admin');
  }
  return { settings: out, notes: [...new Set(notes)] };
}

// A campaign's own pacing fields → inside the rules.
export function clampCampaign(c, L = getLimits()) {
  const out = { ...c };
  if ('daily_limit' in out && L.maxPerNumberDay) out.daily_limit = Math.min(Number(out.daily_limit) || 0, L.maxPerNumberDay);
  if ('min_delay_sec' in out) out.min_delay_sec = Math.max(Number(out.min_delay_sec) || 0, L.minDelaySec || 0);
  if ('max_delay_sec' in out) out.max_delay_sec = Math.max(Number(out.max_delay_sec) || 0, Number(out.min_delay_sec ?? L.minDelaySec) || 0, L.minDelaySec || 0);
  if ('window_start' in out && L.windowStart && String(out.window_start) < L.windowStart) out.window_start = L.windowStart;
  if ('window_end' in out && L.windowEnd && String(out.window_end) > L.windowEnd) out.window_end = L.windowEnd;
  return out;
}

// What the sender actually uses for a campaign (stored values, then the rules on top).
export function campaignPacing(c, L = getLimits()) {
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
  if (L.maxPerNumberDay) n += (await C.updateMany({ daily_limit: { $gt: L.maxPerNumberDay } }, { $set: { daily_limit: L.maxPerNumberDay } })).modifiedCount;
  if (L.minDelaySec) {
    n += (await C.updateMany({ min_delay_sec: { $lt: L.minDelaySec } }, { $set: { min_delay_sec: L.minDelaySec } })).modifiedCount;
    n += (await C.updateMany({ max_delay_sec: { $lt: L.minDelaySec } }, { $set: { max_delay_sec: L.minDelaySec } })).modifiedCount;
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
