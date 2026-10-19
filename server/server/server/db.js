'use strict';
// All database access lives here (PostgreSQL). Every query is parameterized.

const crypto = require('crypto');
const { Pool } = require('pg');
const { CATEGORIES } = require('./awards');

let pool = null;
function getPool() {
  if (!pool) {
    if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is not set.');
    pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 5, idleTimeoutMillis: 30000, connectionTimeoutMillis: 10000 });
    pool.on('error', (e) => console.error('Database pool error:', e.code || e.message));
  }
  return pool;
}
const q = (text, params) => getPool().query(text, params);

const iso = (d) => (d ? new Date(d).toISOString() : null);
const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');
const newToken = () => crypto.randomBytes(32).toString('base64url');

// ---- Schema (idempotent; safe to run on every start) -----------------------------
const SCHEMA = `
CREATE TABLE IF NOT EXISTS settings (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- One row per issued ballot token. Only a SHA-256 hash is stored.
-- A token is single use: used_at is set exactly once, atomically, with the ballot.
CREATE TABLE IF NOT EXISTS ballot_tokens (
  token_hash TEXT PRIMARY KEY,
  issued_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  used_at    TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS ballots (
  id           UUID PRIMARY KEY,
  token_hash   TEXT NOT NULL UNIQUE REFERENCES ballot_tokens(token_hash),
  submitted_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS ballot_votes (
  ballot_id   UUID NOT NULL REFERENCES ballots(id) ON DELETE CASCADE,
  category_id TEXT NOT NULL,
  nominee_id  TEXT NOT NULL,
  PRIMARY KEY (ballot_id, category_id)
);
CREATE INDEX IF NOT EXISTS idx_votes_cat_nom ON ballot_votes (category_id, nominee_id);

CREATE TABLE IF NOT EXISTS admin_sessions (
  token_hash TEXT PRIMARY KEY,
  csrf_token TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL
);

-- History of open/close actions.
CREATE TABLE IF NOT EXISTS voting_log (
  id         BIGSERIAL PRIMARY KEY,
  is_open    BOOLEAN NOT NULL,
  changed_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
`;

async function init() {
  const client = await getPool().connect();
  try {
    // Advisory lock so two instances starting at once don't race on first-time setup.
    await client.query('SELECT pg_advisory_lock(727001)');
    await client.query(SCHEMA);
    // First run: seed the status from VOTING_DEFAULT ("open" unless set to "closed").
    const open = (process.env.VOTING_DEFAULT || 'open').toLowerCase() !== 'closed';
    const ins = await client.query(
      `INSERT INTO settings (key, value) VALUES ('voting_open', $1) ON CONFLICT (key) DO NOTHING`,
      [open ? '1' : '0']
    );
    if (ins.rowCount === 1) await client.query('INSERT INTO voting_log (is_open) VALUES ($1)', [open]);
    await client.query('SELECT pg_advisory_unlock(727001)');
  } finally {
    client.release();
  }
}

// ---- Voting status -----------------------------------------------------------------
async function getVoting() {
  const { rows } = await q(`SELECT value, updated_at FROM settings WHERE key = 'voting_open'`);
  if (!rows.length) throw new Error('Voting status missing');
  return { open: rows[0].value === '1', changedAt: iso(rows[0].updated_at) };
}

/**
 * Changing the status updates the same row that every ballot submission locks
 * (FOR SHARE), so a close can never slip between a ballot's "is voting open?"
 * check and its save.
 */
async function setVoting(open) {
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    await client.query(`UPDATE settings SET value = $1, updated_at = now() WHERE key = 'voting_open'`, [open ? '1' : '0']);
    await client.query('INSERT INTO voting_log (is_open) VALUES ($1)', [open]);
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
  return getVoting();
}

async function lastOpenedClosed() {
  const { rows } = await q(
    `SELECT max(changed_at) FILTER (WHERE is_open) AS o, max(changed_at) FILTER (WHERE NOT is_open) AS c FROM voting_log`
  );
  return { lastOpenedAt: iso(rows[0].o), lastClosedAt: iso(rows[0].c) };
}

// ---- Ballot tokens -------------------------------------------------------------------
/** Create a new unused ballot token. Returns the raw token (never stored). */
async function issueToken() {
  const token = newToken();
  await q('INSERT INTO ballot_tokens (token_hash) VALUES ($1)', [sha256(token)]);
  return token;
}

/** 'ready' | 'used' | 'unknown' */
async function tokenState(token) {
  if (typeof token !== 'string' || token.length < 20 || token.length > 100) return 'unknown';
  const { rows } = await q('SELECT used_at FROM ballot_tokens WHERE token_hash = $1', [sha256(token)]);
  if (!rows.length) return 'unknown';
  return rows[0].used_at ? 'used' : 'ready';
}

/** Remove abandoned, never-used tokens so the table doesn't grow forever. */
async function purgeStaleTokens(days = 14) {
  const r = await q(`DELETE FROM ballot_tokens WHERE used_at IS NULL AND issued_at < now() - ($1 || ' days')::interval`, [String(days)]);
  return r.rowCount;
}

// ---- Ballot submission -----------------------------------------------------------------
class VoteError extends Error {
  constructor(code, message, status) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

/**
 * Atomically: confirm voting is open, consume the token, store the ballot.
 * One transaction, so two concurrent requests with the same token cannot both
 * succeed, and a ballot can never be saved after the admin closes voting.
 * `choices` must already be validated by awards.validateChoices.
 */
async function submitBallot(token, choices) {
  if (typeof token !== 'string' || token.length < 20 || token.length > 100) {
    // Still honour "closed" first so the voter gets the most useful message.
    if (!(await getVoting()).open) throw new VoteError('CLOSED', 'Voting has ended.', 403);
    throw new VoteError('TOKEN_INVALID', 'Your ballot session expired. Please refresh and try again.', 400);
  }
  const hash = sha256(token);
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    const st = await client.query(`SELECT value FROM settings WHERE key = 'voting_open' FOR SHARE`);
    if (!st.rows.length || st.rows[0].value !== '1') throw new VoteError('CLOSED', 'Voting has ended.', 403);

    const used = await client.query('UPDATE ballot_tokens SET used_at = now() WHERE token_hash = $1 AND used_at IS NULL', [hash]);
    if (used.rowCount !== 1) {
      const exists = await client.query('SELECT 1 FROM ballot_tokens WHERE token_hash = $1', [hash]);
      if (!exists.rowCount) throw new VoteError('TOKEN_INVALID', 'Your ballot session expired. Please refresh and try again.', 400);
      throw new VoteError('ALREADY_VOTED', 'A ballot has already been submitted from this browser.', 409);
    }

    const id = crypto.randomUUID();
    const ins = await client.query('INSERT INTO ballots (id, token_hash) VALUES ($1, $2) RETURNING submitted_at', [id, hash]);
    const params = [id];
    const values = CATEGORIES.map((cat, i) => {
      params.push(cat.id, choices[cat.id]);
      return `($1, $${i * 2 + 2}, $${i * 2 + 3})`;
    });
    await client.query(`INSERT INTO ballot_votes (ballot_id, category_id, nominee_id) VALUES ${values.join(', ')}`, params);
    await client.query('COMMIT');
    return { ballotId: id, submittedAt: iso(ins.rows[0].submitted_at) };
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

// ---- Results ---------------------------------------------------------------------------------
async function getResults() {
  const total = Number((await q('SELECT COUNT(*) AS n FROM ballots')).rows[0].n);
  const counts = new Map();
  const { rows } = await q('SELECT category_id, nominee_id, COUNT(*) AS n FROM ballot_votes GROUP BY category_id, nominee_id');
  for (const r of rows) counts.set(`${r.category_id}\u0000${r.nominee_id}`, Number(r.n));
  const categories = CATEGORIES.map((cat) => {
    const nominees = cat.nominees.map((n) => {
      const votes = counts.get(`${cat.id}\u0000${n.id}`) || 0;
      return { id: n.id, name: n.name, image: n.image, votes, percent: total ? (votes / total) * 100 : 0 };
    });
    const max = Math.max(...nominees.map((n) => n.votes));
    const leaders = max > 0 ? nominees.filter((n) => n.votes === max).map((n) => n.id) : [];
    nominees.sort((a, b) => b.votes - a.votes);
    return { id: cat.id, name: cat.name, nominees, leaders, tie: leaders.length > 1 };
  });
  return { generatedAt: new Date().toISOString(), totalBallots: total, categories };
}

// ---- Admin sessions ----------------------------------------------------------------------------
async function createAdminSession(hours = 8) {
  const token = newToken();
  const csrf = newToken();
  const expires = new Date(Date.now() + hours * 3600000);
  await q('INSERT INTO admin_sessions (token_hash, csrf_token, expires_at) VALUES ($1, $2, $3)', [sha256(token), csrf, expires]);
  return { token, csrf, expires };
}

async function getAdminSession(token) {
  if (typeof token !== 'string' || token.length < 20 || token.length > 100) return null;
  const { rows } = await q('SELECT csrf_token, expires_at FROM admin_sessions WHERE token_hash = $1 AND expires_at > now()', [sha256(token)]);
  return rows.length ? { csrf: rows[0].csrf_token, expiresAt: iso(rows[0].expires_at) } : null;
}

async function deleteAdminSession(token) {
  if (typeof token === 'string') await q('DELETE FROM admin_sessions WHERE token_hash = $1', [sha256(token)]);
}

async function purgeExpiredSessions() {
  await q('DELETE FROM admin_sessions WHERE expires_at <= now()');
}

async function health() {
  await q('SELECT 1');
  return true;
}

async function close() {
  if (pool) { await pool.end(); pool = null; }
}

module.exports = {
  getPool, init, close, VoteError, getVoting, setVoting, lastOpenedClosed, issueToken, tokenState,
  purgeStaleTokens, submitBallot, getResults, createAdminSession, getAdminSession,
  deleteAdminSession, purgeExpiredSessions, health,
};
