import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export const ROOT = path.resolve(__dirname, '..');

// Load a .env file (KEY=VALUE per line) if present — no extra dependency.
(function loadEnv() {
  try {
    const envPath = path.join(ROOT, '.env');
    if (!fs.existsSync(envPath)) return;
    for (const line of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
      const t = line.trim();
      if (!t || t.startsWith('#')) continue;
      const i = t.indexOf('=');
      if (i === -1) continue;
      const key = t.slice(0, i).trim();
      let val = t.slice(i + 1).trim();
      if (
        (val.startsWith('"') && val.endsWith('"')) ||
        (val.startsWith("'") && val.endsWith("'"))
      ) {
        val = val.slice(1, -1);
      }
      if (!(key in process.env)) process.env[key] = val;
    }
  } catch {
    /* ignore */
  }
})();
export const DATA_DIR = path.join(ROOT, 'data');
export const WA_AUTH_DIR = path.join(DATA_DIR, 'wa_auth');

export const PORT = process.env.PORT || 4000;

// MongoDB (authentication store). Point MONGODB_URI at a local server or Atlas.
export const MONGODB_URI =
  process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017';
export const MONGODB_DB = process.env.MONGODB_DB || 'pulse_wa';

// Where the signed-session (JWT) secret is persisted if JWT_SECRET isn't set.
export const JWT_SECRET_PATH = path.join(DATA_DIR, '.jwt_secret');
export const AUTH_COOKIE = 'pulse_token';
export const TOKEN_TTL_DAYS = 7;

// Safe defaults tuned to keep the number healthy. All editable in Settings.
export const DEFAULTS = {
  dailyLimit: 150, // messages per day per campaign
  windowStart: '09:00', // local sending window
  windowEnd: '21:00',
  timezone: 'Asia/Karachi',
  minDelaySec: 35, // randomized pause between two sends (anti-ban pacing)
  maxDelaySec: 90,
  warmupEnabled: true, // ramp volume up over first days on a fresh number
  warmupStart: 20, // day-1 cap
  warmupStep: 20, // daily increase until dailyLimit reached
  typingSimulation: true, // show "typing…" presence before sending
  handoffOnReply: true, // pause automation the moment a lead replies
  stopKeywords: ['stop', 'unsubscribe', 'remove', 'optout', 'opt out', 'no more'],

  // --- Number warm-up: build organic activity on a fresh number ---
  warmupActive: false, // is the warm-up engine running
  warmupDailyStart: 5, // messages on day 1
  warmupDailyStep: 3, // add this many to the daily target each day
  warmupDailyMax: 40, // never exceed this many warm-up messages/day
  warmupMinGap: 180, // min seconds between warm-up messages (long, human)
  warmupMaxGap: 900, // max seconds between warm-up messages
  warmupWindowStart: '10:00',
  warmupWindowEnd: '20:00',
  warmupUseAi: true, // use AI (if configured) for natural, non-repeating warm-up chats

  // --- AI message variation (anti-ban): rewrite each send uniquely ---
  // Uses any OpenAI-compatible endpoint. Default: Groq (free, fast).
  aiEnabled: false, // master switch for AI rewriting at send time
  aiProvider: 'groq', // groq | gemini | ollama | custom
  aiBaseUrl: '', // only used when aiProvider = 'custom'
  aiModel: 'openai/gpt-oss-20b', // Groq default; change per provider in Settings
  aiTone: 'friendly', // friendly | professional | casual | enthusiastic
  aiInstructions: '', // optional extra guidance for the rewriter

  // --- AI auto-reply: let AI answer incoming replies automatically ---
  autoReplyEnabled: false,
  autoReplyInstructions: '', // business context: who you are, what to say/not say
};
