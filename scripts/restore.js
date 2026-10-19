'use strict';
// Restores ballots from a backup JSON into the database (adds missing ballots, never deletes anything).
//   npm run restore -- backups/rabbit-rabbi-<timestamp>.json

try { process.loadEnvFile?.(require('path').join(__dirname, '..', '.env')); } catch { /* optional */ }
const fs = require('fs');
const store = require('../server/db');

(async () => {
  const file = process.argv[2];
  if (!file) throw new Error('Usage: npm run restore -- <backup.json>');
  const data = JSON.parse(fs.readFileSync(file, 'utf8'));
  await store.init();
  const client = await store.getPool().connect();
  try {
    await client.query('BEGIN');
    let added = 0;
    for (const b of data.ballots) {
      await client.query('INSERT INTO ballot_tokens (token_hash, used_at) VALUES ($1, $2) ON CONFLICT DO NOTHING', [b.token_hash, b.submitted_at]);
      const r = await client.query('INSERT INTO ballots (id, token_hash, submitted_at) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING', [b.id, b.token_hash, b.submitted_at]);
      added += r.rowCount;
    }
    for (const v of data.votes) {
      await client.query('INSERT INTO ballot_votes (ballot_id, category_id, nominee_id) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING', [v.ballot_id, v.category_id, v.nominee_id]);
    }
    await client.query('COMMIT');
    console.log(`Restore complete: ${added} ballot(s) added.`);
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
    await store.close();
  }
})().catch((e) => { console.error('Restore failed:', e.message); process.exit(1); });
