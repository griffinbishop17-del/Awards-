'use strict';
// Admin authentication: scrypt password verification, brute-force lockout,
// session cookies, CSRF checks. The password itself is never stored or logged.

const crypto = require('crypto');
const store = require('./db');

const IS_PROD = process.env.NODE_ENV === 'production';
const SESSION_COOKIE = 'rra_admin';
const SESSION_HOURS = 8;

// ---- Password hash -----------------------------------------------------------
// Format: scrypt$N$r$p$saltHex$hashHex   (generate with `npm run hash`)
function parseHash(str) {
  const parts = String(str || '').split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return null;
  const [, N, r, p, salt, hash] = parts;
  return { N: +N, r: +r, p: +p, salt: Buffer.from(salt, 'hex'), hash: Buffer.from(hash, 'hex') };
}

function makeHash(password) {
  const salt = crypto.randomBytes(16);
  const N = 16384, r = 8, p = 1;
  const h = crypto.scryptSync(password, salt, 64, { N, r, p });
  return `scrypt$${N}$${r}$${p}$${salt.toString('hex')}$${h.toString('hex')}`;
}

let adminHash = parseHash(process.env.ADMIN_PASSWORD_HASH);
if (!adminHash && process.env.ADMIN_PASSWORD) {
  // Convenience for hosts where you only want to set one secret. The plain
  // value lives only in the environment; we hash it immediately.
  adminHash = parseHash(makeHash(process.env.ADMIN_PASSWORD));
}
const adminConfigured = !!adminHash;

function verifyPassword(candidate) {
  if (!adminHash || typeof candidate !== 'string' || candidate.length === 0 || candidate.length > 200) return false;
  const h = crypto.scryptSync(candidate, adminHash.salt, adminHash.hash.length, {
    N: adminHash.N, r: adminHash.r, p: adminHash.p,
  });
  return crypto.timingSafeEqual(h, adminHash.hash);
}

// ---- Brute-force protection (in memory, per client address) ------------------------
const MAX_FAILS = 5;
const WINDOW_MS = 15 * 60 * 1000;
const LOCK_MS = 15 * 60 * 1000;
const attempts = new Map(); // ip -> { fails: number[], lockedUntil }

function lockState(ip) {
  const a = attempts.get(ip);
  if (a && a.lockedUntil > Date.now()) return Math.ceil((a.lockedUntil - Date.now()) / 1000);
  return 0;
}
function recordFail(ip) {
  const t = Date.now();
  const a = attempts.get(ip) || { fails: [], lockedUntil: 0 };
  a.fails = a.fails.filter((x) => t - x < WINDOW_MS);
  a.fails.push(t);
  if (a.fails.length >= MAX_FAILS) {
    a.lockedUntil = t + LOCK_MS;
    a.fails = [];
  }
  attempts.set(ip, a);
}
function recordSuccess(ip) {
  attempts.delete(ip);
}
setInterval(() => {
  const t = Date.now();
  for (const [ip, a] of attempts) {
    if (a.lockedUntil < t && a.fails.every((x) => t - x >= WINDOW_MS)) attempts.delete(ip);
  }
}, 10 * 60 * 1000).unref();

// ---- Cookies -------------------------------------------------------------------
function parseCookies(header) {
  const out = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

function cookieString(name, value, { maxAgeSec, clear } = {}) {
  const bits = [`${name}=${clear ? '' : encodeURIComponent(value)}`, 'Path=/', 'HttpOnly', 'SameSite=Strict'];
  if (IS_PROD) bits.push('Secure');
  bits.push(clear ? 'Max-Age=0' : `Max-Age=${maxAgeSec}`);
  return bits.join('; ');
}

// ---- Request guards -----------------------------------------------------------------
/** Reject cross-site state-changing requests (CSRF defense in depth alongside SameSite=Strict). */
function sameOriginOnly(req, res, next) {
  if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS') return next();
  const origin = req.get('origin');
  if (origin) {
    let host;
    try { host = new URL(origin).host; } catch { host = null; }
    if (host !== req.get('host')) return res.status(403).json({ error: 'Request blocked.' });
  } else if (req.get('sec-fetch-site') && !['same-origin', 'none'].includes(req.get('sec-fetch-site'))) {
    return res.status(403).json({ error: 'Request blocked.' });
  }
  if (!req.is('application/json')) return res.status(415).json({ error: 'Unsupported request.' });
  next();
}

async function sessionFromReq(req) {
  const token = parseCookies(req.headers.cookie)[SESSION_COOKIE];
  const session = await store.getAdminSession(token);
  return session ? { token, ...session } : null;
}

function safeEqual(a, b) {
  const x = Buffer.from(String(a)), y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

/** Protects every admin API route: valid session + (for writes) matching CSRF token. */
async function requireAdmin(req, res, next) {
  let s;
  try { s = await sessionFromReq(req); } catch { return res.status(503).json({ error: 'Service temporarily unavailable.' }); }
  if (!s) return res.status(401).json({ error: 'Please sign in.' });
  if (!['GET', 'HEAD'].includes(req.method) && !safeEqual(req.get('x-csrf-token') || '', s.csrf)) {
    return res.status(403).json({ error: 'Session check failed. Please reload the page.' });
  }
  req.admin = s;
  next();
}

/** Protects the dashboard HTML/JS: redirects visitors without a session to the login page. */
async function requireAdminPage(req, res, next) {
  let s = null;
  try { s = await sessionFromReq(req); } catch { /* treated as signed out */ }
  if (!s) return res.redirect(302, '/admin');
  req.admin = s;
  next();
}

async function startSession(res) {
  const s = await store.createAdminSession(SESSION_HOURS);
  res.append('Set-Cookie', cookieString(SESSION_COOKIE, s.token, { maxAgeSec: SESSION_HOURS * 3600 }));
  return s;
}
async function endSession(req, res) {
  const token = parseCookies(req.headers.cookie)[SESSION_COOKIE];
  await store.deleteAdminSession(token);
  res.append('Set-Cookie', cookieString(SESSION_COOKIE, '', { clear: true }));
}

module.exports = {
  adminConfigured, verifyPassword, makeHash, lockState, recordFail, recordSuccess,
  parseCookies, cookieString, sameOriginOnly, requireAdmin, requireAdminPage,
  startSession, endSession, sessionFromReq,
};
