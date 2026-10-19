'use strict';

try { process.loadEnvFile?.(require('path').join(__dirname, '..', '.env')); } catch { /* no .env file: use real environment */ }

const path = require('path');
const express = require('express');
const helmet = require('helmet');
const { rateLimit } = require('express-rate-limit');

const store = require('./db');
const auth = require('./auth');
const { CATEGORIES, validateChoices } = require('./awards');

const IS_PROD = process.env.NODE_ENV === 'production';
const PORT = Number(process.env.PORT) || 3000;
const BALLOT_COOKIE = 'rra_ballot';

const app = express();
app.disable('x-powered-by');
if (process.env.TRUST_PROXY) {
  const v = process.env.TRUST_PROXY;
  app.set('trust proxy', /^\d+$/.test(v) ? Number(v) : v === 'true' ? true : v);
}

app.use(
  helmet({
    contentSecurityPolicy: {
      useDefaults: false,
      directives: {
        'default-src': ["'self'"],
        'script-src': ["'self'"],
        'style-src': ["'self'"],
        'img-src': ["'self'", 'data:'],
        'font-src': ["'self'"],
        'connect-src': ["'self'"],
        'object-src': ["'none'"],
        'base-uri': ["'self'"],
        'form-action': ["'self'"],
        'frame-ancestors': ["'none'"],
      },
    },
    hsts: IS_PROD ? { maxAge: 63072000, includeSubDomains: true } : false,
    referrerPolicy: { policy: 'same-origin' },
  })
);
app.use(express.json({ limit: '8kb' }));

// Never cache API responses (results, status, ballot state).
app.use('/api', (req, res, next) => {
  res.set('Cache-Control', 'no-store');
  next();
});
app.use('/api', auth.sameOriginOnly);

// ---- Rate limiters -----------------------------------------------------------------
// Limits are generous enough for a group sharing one Wi-Fi network, but stop scripts.
const limiterOpts = { standardHeaders: 'draft-7', legacyHeaders: false, validate: { trustProxy: false, xForwardedForHeader: false } };
const submitLimiter = rateLimit({
  ...limiterOpts, windowMs: 10 * 60 * 1000, limit: 30,
  message: { error: 'Too many attempts. Please wait a few minutes and try again.' },
});
const loginLimiter = rateLimit({
  ...limiterOpts, windowMs: 15 * 60 * 1000, limit: 30,
  message: { error: 'Too many sign-in attempts. Please wait and try again.' },
});

// New ballot tokens are the thing an abuser would farm, so cap how many one address can mint.
const mintLog = new Map(); // ip -> timestamps
const MINT_LIMIT = 40, MINT_WINDOW = 60 * 60 * 1000;
function canMint(ip) {
  const t = Date.now();
  const list = (mintLog.get(ip) || []).filter((x) => t - x < MINT_WINDOW);
  if (list.length >= MINT_LIMIT) { mintLog.set(ip, list); return false; }
  list.push(t);
  mintLog.set(ip, list);
  return true;
}
setInterval(() => {
  const t = Date.now();
  for (const [ip, l] of mintLog) if (l.every((x) => t - x >= MINT_WINDOW)) mintLog.delete(ip);
}, 10 * 60 * 1000).unref();

// ---- Public API ----------------------------------------------------------------------
app.get('/api/health', async (req, res) => {
  try { await store.health(); res.json({ ok: true }); } catch { res.status(503).json({ ok: false }); }
});

/**
 * Everything the voting page needs: categories, whether voting is open, and the
 * state of this browser's ballot token ('ready' | 'used'). Issues a token cookie
 * the first time. Never returns any vote counts.
 */
app.get('/api/ballot', async (req, res) => {
  let voting;
  try { voting = await store.getVoting(); } catch { return res.status(503).json({ error: 'The voting booth is temporarily unavailable.' }); }
  const payload = { open: voting.open, categories: CATEGORIES };
  try {
    const existing = auth.parseCookies(req.headers.cookie)[BALLOT_COOKIE];
    let state = await store.tokenState(existing);
    if (state === 'unknown') {
      if (!voting.open) return res.json({ ...payload, ballot: 'closed' });
      if (!canMint(req.ip)) return res.status(429).json({ error: 'Too many new ballots from this connection. Please try again later.' });
      const token = await store.issueToken();
      res.append('Set-Cookie', auth.cookieString(BALLOT_COOKIE, token, { maxAgeSec: 365 * 86400 }));
      state = 'ready';
    }
    res.json({ ...payload, ballot: state });
  } catch {
    res.status(503).json({ error: 'The voting booth is temporarily unavailable.' });
  }
});

app.post('/api/ballot', submitLimiter, async (req, res) => {
  const token = auth.parseCookies(req.headers.cookie)[BALLOT_COOKIE];
  const check = validateChoices(req.body?.choices);
  if (!check.ok) return res.status(400).json({ error: check.error, code: 'INVALID_BALLOT' });
  try {
    const out = await store.submitBallot(token, check.choices);
    res.status(201).json({ ok: true, submittedAt: out.submittedAt });
  } catch (err) {
    if (err instanceof store.VoteError) return res.status(err.status).json({ error: err.message, code: err.code });
    console.error('Ballot submission failed:', err.code || err.message);
    res.status(503).json({ error: 'We could not save your ballot just now. Your choices are still here, so please try again.', code: 'SERVER_ERROR' });
  }
});

// ---- Admin API --------------------------------------------------------------------------
app.post('/api/admin/login', loginLimiter, async (req, res) => {
  if (!auth.adminConfigured) return res.status(503).json({ error: 'Admin sign-in has not been configured on this server.' });
  const wait = auth.lockState(req.ip);
  if (wait) {
    res.set('Retry-After', String(wait));
    return res.status(429).json({ error: `Too many wrong passwords. Try again in ${Math.ceil(wait / 60)} minute(s).` });
  }
  const password = req.body?.password;
  if (!auth.verifyPassword(password)) {
    auth.recordFail(req.ip);
    return res.status(401).json({ error: 'Incorrect password.' });
  }
  auth.recordSuccess(req.ip);
  try {
    const s = await auth.startSession(res);
    res.json({ ok: true, csrf: s.csrf });
  } catch {
    res.status(503).json({ error: 'Could not start a session. Please try again.' });
  }
});

app.post('/api/admin/logout', async (req, res) => {
  try { await auth.endSession(req, res); } catch { /* cookie is cleared regardless */ }
  res.json({ ok: true });
});

app.get('/api/admin/session', async (req, res) => {
  try {
    const s = await auth.sessionFromReq(req);
    if (!s) return res.status(401).json({ authenticated: false });
    res.json({ authenticated: true, csrf: s.csrf });
  } catch {
    res.status(503).json({ authenticated: false });
  }
});

app.get('/api/admin/results', auth.requireAdmin, async (req, res) => {
  try {
    const v = await store.getVoting();
    res.json({ voting: { open: v.open, changedAt: v.changedAt, ...(await store.lastOpenedClosed()) }, results: await store.getResults() });
  } catch {
    res.status(503).json({ error: 'Could not read results.', systemError: true });
  }
});

app.post('/api/admin/voting', auth.requireAdmin, async (req, res) => {
  if (typeof req.body?.open !== 'boolean') return res.status(400).json({ error: 'Expected { "open": true | false }.' });
  try {
    const v = await store.setVoting(req.body.open);
    res.json({ voting: { open: v.open, changedAt: v.changedAt, ...(await store.lastOpenedClosed()) } });
  } catch {
    res.status(503).json({ error: 'Could not change the voting status.', systemError: true });
  }
});

// Spreadsheet programs run text beginning with = + - @ as a formula; neutralise that.
const csvCell = (v) => {
  let s = String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

app.get('/api/admin/results.csv', auth.requireAdmin, async (req, res) => {
  try {
    const r = await store.getResults();
    const rows = [['Category', 'Nominee', 'Votes', 'Percent of ballots', 'Result', 'Total valid ballots', 'Exported at (UTC)']];
    for (const cat of r.categories) {
      for (const n of cat.nominees) {
        const result = cat.leaders.includes(n.id) ? (cat.tie ? 'Tied for lead' : 'Leader') : '';
        rows.push([cat.name, n.name, n.votes, n.percent.toFixed(1) + '%', result, r.totalBallots, r.generatedAt]);
      }
    }
    const stamp = r.generatedAt.slice(0, 10);
    res.set({
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="rabbit-rabbi-results-${stamp}.csv"`,
    });
    res.send('﻿' + rows.map((row) => row.map(csvCell).join(',')).join('\r\n') + '\r\n');
  } catch {
    res.status(503).json({ error: 'Could not export results.' });
  }
});

app.use('/api', (req, res) => res.status(404).json({ error: 'Not found.' }));

// ---- Pages ----------------------------------------------------------------------------------
const PUBLIC = path.join(__dirname, '..', 'public');
const PRIVATE = path.join(__dirname, '..', 'private');
const noIndex = (req, res, next) => { res.set('X-Robots-Tag', 'noindex, nofollow'); next(); };

// Login page is public (and discreet); the dashboard itself is only served to a signed-in admin.
app.get('/admin', noIndex, async (req, res) => {
  let s = null;
  try { s = await auth.sessionFromReq(req); } catch { /* signed out */ }
  if (s) return res.redirect(302, '/admin/dashboard');
  res.set('Cache-Control', 'no-store');
  res.sendFile(path.join(PUBLIC, 'admin-login.html'));
});
app.get('/admin/dashboard', noIndex, auth.requireAdminPage, (req, res) => {
  res.set('Cache-Control', 'no-store');
  res.sendFile(path.join(PRIVATE, 'dashboard.html'));
});
app.get('/admin/dashboard.js', noIndex, auth.requireAdminPage, (req, res) => {
  res.set('Cache-Control', 'no-store');
  res.sendFile(path.join(PRIVATE, 'dashboard.js'));
});

// Fonts come from the installed @fontsource packages, so no font files need to be committed.
for (const pkg of ['unbounded', 'dm-sans']) {
  app.use('/fonts', express.static(path.join(__dirname, '..', 'node_modules', '@fontsource', pkg, 'files'), { maxAge: IS_PROD ? '30d' : 0 }));
}

app.use(express.static(PUBLIC, { maxAge: IS_PROD ? '1h' : 0, extensions: ['html'], index: 'index.html' }));

app.use((req, res) => res.status(404).sendFile(path.join(PUBLIC, '404.html')));

// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  if (err.type === 'entity.parse.failed' || err.type === 'entity.too.large') {
    return res.status(400).json({ error: 'Invalid request.' });
  }
  console.error('Unhandled error:', err.code || err.message);
  res.status(500).json({ error: 'Something went wrong on our end.' });
});

// ---- Housekeeping & lifecycle ---------------------------------------------------------------
async function housekeeping() {
  try { await store.purgeExpiredSessions(); await store.purgeStaleTokens(14); } catch (e) { console.error('Housekeeping failed:', e.code || e.message); }
}

if (require.main === module) {
  store.init().then(() => {
    housekeeping();
    setInterval(housekeeping, 6 * 60 * 60 * 1000).unref();
    const server = app.listen(PORT, () => {
      console.log(`Rabbit Rabbi Awards listening on port ${PORT} (${IS_PROD ? 'production' : 'development'})`);
      if (!auth.adminConfigured) console.warn('WARNING: no ADMIN_PASSWORD_HASH set — admin login is disabled.');
      if (IS_PROD && !process.env.TRUST_PROXY) console.warn('NOTE: behind a proxy/host? Set TRUST_PROXY=1 so rate limits see real client addresses.');
    });
    const shutdown = () => {
      server.close(() => store.close().finally(() => process.exit(0)));
      setTimeout(() => process.exit(0), 5000).unref();
    };
    process.on('SIGTERM', shutdown);
    process.on('SIGINT', shutdown);
  }).catch((e) => {
    console.error('Could not start: database unavailable or misconfigured (' + (e.code || e.message) + ').');
    process.exit(1);
  });
}

module.exports = app;
