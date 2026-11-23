// One-time 6-digit codes sent by email: confirming a new account's email, and resetting a
// forgotten password. Only a keyed hash of a code is stored; a code works once, for 15
// minutes, and 5 wrong tries end it. One code per email and purpose (a new one replaces it).
import crypto from 'node:crypto';
import { col } from './db/mongo.js';
import { keyedHash } from './auth.js';
import { sendMail, codeEmail } from './mail.js';

export const CODE_MINUTES = 15;
const MAX_TRIES = 5;
const RESEND_GAP_SEC = 60;
const MAX_SENDS_HOUR = 5;
const KEEP_MS = { signup: 24 * 3600 * 1000, reset: 3600 * 1000 }; // how long the request itself lasts

export class CodeError extends Error {
  constructor(status, code, message, extra = {}) {
    super(message);
    this.status = status;
    this.code = code;
    Object.assign(this, extra);
  }
}

const codes = () => col('auth_codes');
const idOf = (purpose, email) => `${purpose}:${email}`;
const hashOf = (id, code) => keyedHash(`${id}:${code}`);

// Seconds until another code may be sent to this email (0 = now).
export async function waitBeforeSend(purpose, email) {
  const d = await codes().findOne({ _id: idOf(purpose, email) });
  if (!d) return 0;
  const now = Date.now();
  const gap = d.sent_at ? Math.ceil((d.sent_at.getTime() + RESEND_GAP_SEC * 1000 - now) / 1000) : 0;
  const recent = (d.sends || []).filter((t) => now - t.getTime() < 3600 * 1000);
  if (recent.length >= MAX_SENDS_HOUR) return Math.ceil((recent[0].getTime() + 3600 * 1000 - now) / 1000);
  return Math.max(0, gap);
}

// Make a new code, email it, then save it (nothing is saved if the email couldn't be sent).
// `data` is kept with the code (a sign-up's details until the email is confirmed).
export async function sendCode(purpose, email, { data = null, mail = {} } = {}) {
  const wait = await waitBeforeSend(purpose, email);
  if (wait > 0) throw new CodeError(429, 'wait', wait > RESEND_GAP_SEC ? `Too many codes sent to this email. Try again in ${Math.ceil(wait / 60)} minutes.` : `Wait ${wait} seconds before asking for a new code.`, { wait });
  const id = idOf(purpose, email);
  const code = String(crypto.randomInt(0, 1_000_000)).padStart(6, '0');
  await sendMail({ to: email, ...codeEmail(purpose, { code, minutes: CODE_MINUTES, email, ...mail }) });
  const now = new Date();
  const old = await codes().findOne({ _id: id }, { projection: { sends: 1 } });
  const sends = [...(old?.sends || []).filter((t) => now - t < 3600 * 1000), now];
  await codes().updateOne(
    { _id: id },
    {
      $set: {
        purpose,
        email,
        code_hash: hashOf(id, code),
        code_expires: new Date(now.getTime() + CODE_MINUTES * 60 * 1000),
        tries: 0,
        sent_at: now,
        sends,
        expires_at: new Date(now.getTime() + KEEP_MS[purpose]), // removed by the database after this
        ...(data ? { data } : {}),
      },
    },
    { upsert: true }
  );
}

// The saved request (with its data) for this email, if it hasn't run out.
export async function pendingCode(purpose, email) {
  const d = await codes().findOne({ _id: idOf(purpose, email) });
  return d && d.expires_at > new Date() ? d : null;
}

// Check a code. Right → the request is used up and returned. Wrong → a clear reason.
export async function useCode(purpose, email, code) {
  const id = idOf(purpose, email);
  const typed = String(code || '').replace(/\D/g, '');
  const d = await codes().findOne({ _id: id });
  if (!d || d.expires_at <= new Date()) throw new CodeError(400, 'no_code', purpose === 'signup' ? 'This sign-up has run out. Please sign up again.' : 'This code has run out. Ask for a new one.');
  if (!d.code_hash || d.code_expires <= new Date()) throw new CodeError(400, 'expired', 'This code has run out. Ask for a new one.');
  if ((d.tries || 0) >= MAX_TRIES) throw new CodeError(400, 'too_many', 'Too many wrong tries. Ask for a new code.');
  const good = typed.length === 6 && crypto.timingSafeEqual(Buffer.from(hashOf(id, typed)), Buffer.from(d.code_hash));
  if (!good) {
    const r = await codes().findOneAndUpdate({ _id: id }, { $inc: { tries: 1 } }, { returnDocument: 'after' });
    const left = MAX_TRIES - (r?.tries || MAX_TRIES);
    throw new CodeError(400, 'wrong_code', left > 0 ? `That code isn't right. ${left} ${left === 1 ? 'try' : 'tries'} left.` : 'Too many wrong tries. Ask for a new code.');
  }
  // Used once: only the request that removes it goes on (two taps at once can't both succeed).
  const used = await codes().findOneAndDelete({ _id: id, code_hash: d.code_hash });
  if (!used) throw new CodeError(400, 'expired', 'This code was already used. Ask for a new one.');
  return used;
}

export async function dropCode(purpose, email) {
  await codes().deleteOne({ _id: idOf(purpose, email) });
}
