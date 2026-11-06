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
    { uid: String(user._id), email: user.email, role: user.role, name: user.name },
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

// Gate: valid session required.
export function requireAuth(req, res, next) {
  const token = readToken(req);
  if (!token) return res.status(401).json({ error: 'Not authenticated' });
  try {
    req.user = jwt.verify(token, SECRET);
    next();
  } catch {
    return res.status(401).json({ error: 'Session expired' });
  }
}

// Gate: must be an admin/owner.
export function requireAdmin(req, res, next) {
  requireAuth(req, res, () => {
    if (req.user.role !== 'owner' && req.user.role !== 'admin') {
      return res.status(403).json({ error: 'Admin access required' });
    }
    next();
  });
}
