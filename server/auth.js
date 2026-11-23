import fs from 'node:fs';
import crypto from 'node:crypto';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import {
  JWT_SECRET_PATH,
  AUTH_COOKIE,
  TOKEN_TTL_DAYS,
  DATA_DIR,
} from './config.js';
import { isMongoUp, getPlatform, workspaceOf } from './db/mongo.js';
import { loadUser, pagesOf } from './access.js';
import { DEFAULT_WS, runInWs } from './tenant.js';

// A stable secret: env var wins, else a persisted random one (created on first boot).
function loadSecret() {
  if (process.env.JWT_SECRET) return process.env.JWT_SECRET;
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    if (fs.existsSync(JWT_SECRET_PATH)) {
      return fs.readFileSync(JWT_SECRET_PATH, 'utf8').trim();
    }
    const secret = crypto.randomBytes(48).toString('hex');
    fs.writeFileSync(JWT_SECRET_PATH, secret, { mode: 0o600 });
    return secret;
  } catch {
    // Last resort: ephemeral secret (sessions reset on restart).
    return crypto.randomBytes(48).toString('hex');
  }
}

const SECRET = loadSecret();

// A hash only this server can make (for the one-time email codes).
export const keyedHash = (text) => crypto.createHmac('sha256', SECRET).update(String(text)).digest('hex');

export async function hashPassword(plain) {
  return bcrypt.hash(plain, 10);
}

export async function verifyPassword(plain, hash) {
  return bcrypt.compare(plain, hash);
}

export function signToken(user) {
  return jwt.sign(
    // tv: the user's session version — bumping it (sign out everywhere, password reset,
    // suspension) ends every session signed before.
    { uid: String(user._id), email: user.email, role: user.role, name: user.name, tv: user.tokenVersion || 0 },
    SECRET,
    { expiresIn: `${TOKEN_TTL_DAYS}d` }
  );
}

export function setAuthCookie(res, token) {
  res.cookie(AUTH_COOKIE, token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    maxAge: TOKEN_TTL_DAYS * 24 * 60 * 60 * 1000,
    path: '/',
  });
}

export function clearAuthCookie(res) {
  res.clearCookie(AUTH_COOKIE, { path: '/' });
}

function readToken(req) {
  if (req.cookies?.[AUTH_COOKIE]) return req.cookies[AUTH_COOKIE];
  const h = req.headers.authorization;
  if (h?.startsWith('Bearer ')) return h.slice(7);
  return null;
}

// Why a signed-in user can't use the app right now (null = they can).
export function blockedReason(u) {
  if (u.suspended) return 'This account is suspended. Ask the super admin.';
  if (u.role === 'owner') return null;
  if (getPlatform('teamLocked', false)) return 'Sign-in is paused by the super admin.';
  const w = workspaceOf(u.ws || DEFAULT_WS);
  if (!w) return 'Your workspace no longer exists. Ask the super admin.';
  if (w.pending) return `Thanks for signing up! ${w.name} is waiting for approval — you can sign in as soon as it's approved.`;
  if (w.suspended) return `${w.name} is suspended. Ask the super admin.`;
  return null;
}

// Public sign-up (the super admin's choice on the Super Admin page).
export const SIGNUP_MODES = ['open', 'approval', 'off'];
export function signupMode() {
  const m = getPlatform('signup', 'open');
  return SIGNUP_MODES.includes(m) ? m : 'open';
}

// The workspace a request works in. Everyone works in their own workspace; the super admin
// picks one (the page sends it as X-Workspace, or ?ws= for the live event stream).
export function workspaceFor(req, u) {
  if (u?.role !== 'owner') return u?.ws || DEFAULT_WS;
  const asked = String(req.get?.('x-workspace') || req.query?.ws || '');
  return asked && workspaceOf(asked) ? asked : DEFAULT_WS;
}

// Gate: valid session required. The account is re-read (cached a few seconds) so a removed,
// suspended or signed-out user, or a changed role/page access, takes effect immediately.
export async function requireAuth(req, res, next) {
  const token = readToken(req);
  if (!token) return res.status(401).json({ error: 'Not authenticated' });
  let claims;
  try {
    claims = jwt.verify(token, SECRET);
  } catch {
    return res.status(401).json({ error: 'Session expired' });
  }
  if (!isMongoUp()) {
    // Can't check the account: only the super admin's own session carries on.
    if (claims.role !== 'owner') return res.status(503).json({ error: 'Database unavailable — try again in a moment' });
    req.user = { ...claims, pages: pagesOf(claims) };
    req.ws = workspaceFor(req, claims);
    return runInWs(req.ws, next);
  }
  let u;
  try {
    u = await loadUser(claims.uid);
  } catch {
    return res.status(503).json({ error: 'Database unavailable — try again in a moment' });
  }
  if (!u) return res.status(401).json({ error: 'Account no longer exists' });
  const blocked = blockedReason(u); // checked first so a suspended person is told why
  if (blocked) return res.status(401).json({ error: blocked });
  if ((u.tokenVersion || 0) !== (claims.tv || 0)) return res.status(401).json({ error: 'You were signed out. Please sign in again.' });
  req.user = { uid: String(u._id), email: u.email, name: u.name, role: u.role, pages: pagesOf(u), ws: u.ws || null };
  req.ws = workspaceFor(req, u);
  // Everything this request does — queries, settings, events, audit — is in this workspace.
  runInWs(req.ws, next);
}

// Gate: must be an admin or the super admin.
export function requireAdmin(req, res, next) {
  requireAuth(req, res, () => {
    if (req.user.role !== 'owner' && req.user.role !== 'admin') {
      return res.status(403).json({ error: 'Admin access required' });
    }
    next();
  });
}

// Gate: super admin only.
export function requireOwner(req, res, next) {
  const check = () => {
    if (req.user.role !== 'owner') return res.status(403).json({ error: 'Only the super admin can do this', noAccess: true });
    next();
  };
  if (req.user) return check(); // already signed in by the /api gate
  requireAuth(req, res, check);
}
