'use strict';
// End-to-end acceptance tests. Runs the real app against a throwaway database.
//   npm test

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

const TEST_PASSWORD = 'test-only-password-123';
// Needs a throwaway PostgreSQL database. WARNING: its contents are erased on every run.
const TEST_DB = process.env.TEST_DATABASE_URL;
if (!TEST_DB) throw new Error('Set TEST_DATABASE_URL to an empty, disposable Postgres database to run the tests.');
process.env.DATABASE_URL = TEST_DB;
process.env.NODE_ENV = 'test';
process.env.VOTING_DEFAULT = 'open';
{
  const salt = crypto.randomBytes(16);
  const h = crypto.scryptSync(TEST_PASSWORD, salt, 64, { N: 16384, r: 8, p: 1 });
  process.env.ADMIN_PASSWORD_HASH = `scrypt$16384$8$1$${salt.toString('hex')}$${h.toString('hex')}`;
}

const app = require('../server/index.js');
const store = require('../server/db.js');
const { CATEGORIES } = require('../server/awards.js');

let server, base;
test.before(async () => {
  await store.getPool().query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  await store.init();
  await new Promise((r) => { server = app.listen(0, '127.0.0.1', r); });
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(async () => {
  server.close();
  await store.close();
});

// ---- helpers ----
const J = { 'Content-Type': 'application/json' };
function cookieFrom(res, name) {
  const all = res.headers.getSetCookie?.() || [];
  const c = all.find((x) => x.startsWith(name + '='));
  return c ? c.split(';')[0] : null;
}
async function newVoter() {
  const res = await fetch(`${base}/api/ballot`);
  const body = await res.json();
  return { cookie: cookieFrom(res, 'rra_ballot'), body, res };
}
function choicesFor(pickIndex = 0) {
  const c = {};
  for (const cat of CATEGORIES) c[cat.id] = cat.nominees[pickIndex % cat.nominees.length].id;
  return c;
}
async function vote(voter, choices) {
  const res = await fetch(`${base}/api/ballot`, { method: 'POST', headers: { ...J, Cookie: voter.cookie || '' }, body: JSON.stringify({ choices }) });
  return { status: res.status, body: await res.json() };
}
let adminCookie, csrf;
async function login(password = TEST_PASSWORD) {
  const res = await fetch(`${base}/api/admin/login`, { method: 'POST', headers: J, body: JSON.stringify({ password }) });
  return { res, body: await res.json() };
}
const admin = (p, opts = {}) => fetch(base + p, { ...opts, headers: { Cookie: adminCookie, 'X-CSRF-Token': csrf, ...J, ...(opts.headers || {}) } });

// ---- 1. Content ----
test('all 13 categories with the exact nominees (61 placements)', () => {
  const expected = {
    'Most Athletic': ['Griffin', 'Sam', 'Josh', 'Stephen', 'Hawkin'],
    'Best Entrance': ['Sam', 'Hawkin', 'Gage', 'Griffin'],
    'Most Like Marlon': ['Sam', 'Josh', 'Gage', 'Ian', 'Stephen', 'Hawkin'],
    'Most Reels Scrolled': ['Quinn', 'Sam', 'Griffin', 'Stephen', 'Hawkin', 'Morgan'],
    'Best Gamer': ['Gage', 'Hawkin', 'Griffin', 'Sam', 'Morgan'],
    'Driver of the Year': ['Hawkin', 'Gage', 'Griffin', 'Josh', 'Stephen'],
    'GOAT of the Year': ['Sam', 'Gage', 'Ian', 'Griffin', 'Hawkin'],
    'Bum of the Year': ['Quinn', 'Sam', 'Gage', 'Hawkin', 'Morgan'],
    'Chad of the Year': ['Quinn', 'Sam', 'Gage', 'Hawkin', 'Morgan'],
    'Tsundere of the Year': ['Griffin', 'Gage', 'Sam', 'Ian'],
    'Crashout of the Year': ['Griffin', 'Gage', 'Sam', 'Ian'],
    'Duo of the Year': ['Sam & Griffin', 'Stephen & Josh', 'Hawkin & Morgan', 'Ian & Gage'],
    'Rabbit Rabbi of the Year': ['Gage', 'Griffin', 'Ian'],
  };
  assert.equal(CATEGORIES.length, 13);
  assert.deepEqual(Object.fromEntries(CATEGORIES.map((c) => [c.name, c.nominees.map((n) => n.name)])), expected);
  assert.equal(CATEGORIES.reduce((s, c) => s + c.nominees.length, 0), 61);
});

test('public ballot endpoint exposes categories, never counts, and sets an HttpOnly token cookie', async () => {
  const v = await newVoter();
  assert.equal(v.body.open, true);
  assert.equal(v.body.ballot, 'ready');
  assert.equal(v.body.categories.length, 13);
  assert.ok(!/votes|percent|leader|total/i.test(JSON.stringify(v.body)));
  const raw = v.res.headers.getSetCookie().find((c) => c.startsWith('rra_ballot='));
  assert.match(raw, /HttpOnly/i);
  assert.match(raw, /SameSite=Strict/i);
});

// ---- 2. Validation ----
test('incomplete and invalid ballots are rejected by the server', async () => {
  const v = await newVoter();
  const full = choicesFor(0);
  const missing = { ...full }; delete missing['best-gamer'];
  assert.equal((await vote(v, missing)).status, 400);
  assert.equal((await vote(v, { ...full, 'most-athletic': 'morgan' })).status, 400); // not nominated there
  assert.equal((await vote(v, { ...full, 'made-up': 'sam' })).status, 400);
  assert.equal((await vote(v, { ...full, 'best-gamer': ['gage'] })).status, 400);
  assert.equal((await vote(v, null)).status, 400);
  assert.equal((await vote(v, {})).status, 400);
  // token must still be unused after all those failures
  const ok = await vote(v, full);
  assert.equal(ok.status, 201);
});

test('missing / forged ballot token cannot vote', async () => {
  assert.equal((await vote({ cookie: '' }, choicesFor(0))).status, 400);
  assert.equal((await vote({ cookie: 'rra_ballot=' + 'x'.repeat(43) }, choicesFor(0))).status, 400);
});

// ---- 3. Duplicate prevention ----
test('a used token is rejected, and parallel double-submits create exactly one ballot', async () => {
  const v = await newVoter();
  const results = await Promise.all(Array.from({ length: 10 }, () => vote(v, choicesFor(1))));
  assert.equal(results.filter((r) => r.status === 201).length, 1);
  assert.equal(results.filter((r) => r.status === 409).length, 9);
  assert.equal((await vote(v, choicesFor(2))).status, 409);
  const again = await fetch(`${base}/api/ballot`, { headers: { Cookie: v.cookie } });
  assert.equal((await again.json()).ballot, 'used');
});

// ---- 4. Admin protection ----
test('unauthenticated users cannot reach admin pages or APIs', async () => {
  for (const p of ['/api/admin/results', '/api/admin/results.csv']) assert.equal((await fetch(base + p)).status, 401, p);
  assert.equal((await fetch(`${base}/api/admin/voting`, { method: 'POST', headers: J, body: JSON.stringify({ open: false }) })).status, 401);
  for (const p of ['/admin/dashboard', '/admin/dashboard.js']) {
    const r = await fetch(base + p, { redirect: 'manual' });
    assert.equal(r.status, 302, p);
    assert.equal(r.headers.get('location'), '/admin');
  }
  assert.equal((await fetch(`${base}/dashboard.js`)).status, 404);
  assert.equal((await fetch(`${base}/private/dashboard.html`)).status, 404);
  assert.equal((await fetch(`${base}/.env`)).status, 404);
  assert.equal((await fetch(`${base}/server/db.js`)).status, 404);
});

test('cross-site requests are blocked', async () => {
  const r = await fetch(`${base}/api/ballot`, { method: 'POST', headers: { ...J, Origin: 'https://evil.example' }, body: '{}' });
  assert.equal(r.status, 403);
  const r2 = await fetch(`${base}/api/admin/login`, { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: 'password=x' });
  assert.equal(r2.status, 415);
});

test('admin sign-in: correct password works with secure cookie flags', async () => {
  const { res, body } = await login();
  assert.equal(res.status, 200);
  const raw = res.headers.getSetCookie().find((c) => c.startsWith('rra_admin='));
  assert.match(raw, /HttpOnly/i);
  assert.match(raw, /SameSite=Strict/i);
  adminCookie = raw.split(';')[0];
  csrf = body.csrf;
  assert.ok(csrf && !JSON.stringify(body).includes(TEST_PASSWORD));
  const page = await fetch(`${base}/admin/dashboard`, { headers: { Cookie: adminCookie } });
  assert.equal(page.status, 200);
  assert.equal((await fetch(`${base}/admin`, { headers: { Cookie: adminCookie }, redirect: 'manual' })).status, 302);
});

test('state-changing admin calls require the CSRF token', async () => {
  const r = await fetch(`${base}/api/admin/voting`, { method: 'POST', headers: { Cookie: adminCookie, ...J }, body: JSON.stringify({ open: false }) });
  assert.equal(r.status, 403);
  const still = await (await admin('/api/admin/results')).json();
  assert.equal(still.voting.open, true);
});

// ---- 5. Results accuracy ----
test('results are computed from real stored ballots, with ties and zero-vote nominees', async () => {
  // Add a few more ballots with known picks. Existing so far: ballot A (index 0 picks), ballot B (index 1 picks).
  for (let i = 0; i < 2; i++) assert.equal((await vote(await newVoter(), choicesFor(0))).status, 201); // now 3 ballots of index 0
  assert.equal((await vote(await newVoter(), choicesFor(1))).status, 201);                           // now 2 ballots of index 1
  const { results, voting } = await (await admin('/api/admin/results')).json();
  assert.equal(voting.open, true);
  assert.equal(results.totalBallots, 5);
  const ath = results.categories.find((c) => c.id === 'most-athletic');
  const byName = Object.fromEntries(ath.nominees.map((n) => [n.name, n]));
  assert.equal(byName.Griffin.votes, 3);
  assert.equal(byName.Sam.votes, 2);
  assert.equal(byName.Josh.votes, 0);            // zero-vote nominee still listed
  assert.equal(byName.Stephen.votes, 0);
  assert.equal(ath.nominees.length, 4);
  assert.equal(byName.Griffin.percent, 60);
  assert.deepEqual(ath.leaders, ['griffin']);
  assert.equal(ath.tie, false);
  for (const cat of results.categories) {
    const sum = cat.nominees.reduce((s, n) => s + n.percent, 0);
    assert.ok(Math.abs(sum - 100) < 0.001, `${cat.name} percentages sum to ${sum}`);
  }
  // Create a tie in Most Athletic: add 1 ballot choosing Sam => Griffin 3 vs Sam 3
  const tieChoices = { ...choicesFor(0), 'most-athletic': 'sam' };
  assert.equal((await vote(await newVoter(), tieChoices)).status, 201);
  const r2 = (await (await admin('/api/admin/results')).json()).results;
  const ath2 = r2.categories.find((c) => c.id === 'most-athletic');
  assert.equal(ath2.tie, true);
  assert.deepEqual([...ath2.leaders].sort(), ['griffin', 'sam']);
  assert.ok(r2.generatedAt);
});

// ---- 6. Close / reopen ----
test('closing voting blocks submissions immediately (direct API too); reopening keeps all ballots and used tokens stay used', async () => {
  const waiting = await newVoter();                       // token minted while open
  const used = await newVoter(); assert.equal((await vote(used, choicesFor(0))).status, 201);
  const before = (await (await admin('/api/admin/results')).json()).results.totalBallots;

  let r = await admin('/api/admin/voting', { method: 'POST', body: JSON.stringify({ open: false }) });
  assert.equal(r.status, 200);
  assert.equal((await r.json()).voting.open, false);

  const blocked = await vote(waiting, choicesFor(0));
  assert.equal(blocked.status, 403);
  assert.equal(blocked.body.code, 'CLOSED');
  const page = await (await fetch(`${base}/api/ballot`)).json();
  assert.equal(page.open, false);
  assert.equal(page.ballot, 'closed');                    // visitors without a token don't get one while closed
  // admin can still view results while closed
  assert.equal((await admin('/api/admin/results')).status, 200);

  r = await admin('/api/admin/voting', { method: 'POST', body: JSON.stringify({ open: true }) });
  assert.equal((await r.json()).voting.open, true);
  const after = (await (await admin('/api/admin/results')).json()).results.totalBallots;
  assert.equal(after, before);                            // nothing lost
  assert.equal((await vote(used, choicesFor(2))).status, 409);   // reopening doesn't revive a used token
  assert.equal((await vote(waiting, choicesFor(0))).status, 201); // an unused token works again
  const last = (await (await admin('/api/admin/results')).json()).voting;
  assert.ok(last.lastOpenedAt && last.lastClosedAt);
});

// ---- 7. CSV ----
test('CSV export contains every nominee with counts and percentages', async () => {
  // Make Most Athletic a tie again (earlier tests added more Griffin votes), so the CSV has a tie to mark.
  const cur = (await (await admin('/api/admin/results')).json()).results.categories.find((c) => c.id === 'most-athletic');
  const g = cur.nominees.find((n) => n.id === 'griffin').votes, sm = cur.nominees.find((n) => n.id === 'sam').votes;
  for (let i = 0; i < g - sm; i++) assert.equal((await vote(await newVoter(), { ...choicesFor(0), 'most-athletic': 'sam' })).status, 201);
  const res = await admin('/api/admin/results.csv');
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /text\/csv/);
  assert.match(res.headers.get('content-disposition'), /attachment/);
  const text = (await res.text()).replace(/^﻿/, '');
  const lines = text.trim().split('\r\n');
  assert.equal(lines[0].split(',')[0], 'Category');
  assert.equal(lines.length, 1 + 61);
  assert.ok(lines.some((l) => l.startsWith('Most Athletic,Josh,0,0.0%')));
  assert.ok(lines.some((l) => l.startsWith('Most Athletic,Griffin,') && l.includes('Tied for lead')));
  assert.ok(lines.some((l) => l.startsWith('Most Athletic,Sam,') && l.includes('Tied for lead')));
  assert.ok(lines.some((l) => l.startsWith('Rabbit Rabbi of the Year,Gage,') && l.includes(',Leader,')));
});

// ---- 8. No secrets in public assets ----
test('no secrets or admin credentials appear in anything served publicly', async () => {
  const urls = ['/', '/index.html', '/js/app.js', '/js/admin-login.js', '/admin', '/css/site.css', '/css/admin.css', '/api/ballot'];
  for (const u of urls) {
    const body = await (await fetch(base + u)).text();
    assert.ok(!body.includes(TEST_PASSWORD), u);
    assert.ok(!/scrypt\$/.test(body), u);
  }
  const h = (await fetch(base + '/')).headers;
  assert.ok(h.get('content-security-policy'));
  assert.equal(h.get('x-powered-by'), null);
});

test('logout invalidates the session', async () => {
  const out = await admin('/api/admin/logout', { method: 'POST', body: '{}' });
  assert.equal(out.status, 200);
  assert.equal((await fetch(`${base}/api/admin/results`, { headers: { Cookie: adminCookie } })).status, 401);
});

// ---- 9. Brute-force protection (keep last: it locks this client out) ----
test('wrong passwords are rejected and repeated failures lock the client out', async () => {
  for (let i = 0; i < 5; i++) {
    const { res } = await login('wrong-password-' + i);
    assert.equal(res.status, 401);
  }
  const locked = await login(TEST_PASSWORD);   // even the right password is refused during lockout
  assert.equal(locked.res.status, 429);
  assert.ok(locked.res.headers.get('retry-after'));
});
