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
import { isMongoUp, getSetting } from './db/mongo.js';
import { loadUser, pagesOf } from './access.js';

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
  if (u.role !== 'owner' && getSetting('teamLocked', false)) return 'Sign-in is paused by the super admin.';
  return null;
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
    return next();
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
  req.user = { uid: String(u._id), email: u.email, name: u.name, role: u.role, pages: pagesOf(u) };
  next();
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
  requireAuth(req, res, () => {
    if (req.user.role !== 'owner') return res.status(403).json({ error: 'Only the super admin can do this', noAccess: true });
    next();
  });
}
