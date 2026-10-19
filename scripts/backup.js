'use strict';
// Exports every ballot to a JSON file you can keep anywhere.
//   npm run backup                 -> backups/rabbit-rabbi-<timestamp>.json
//   npm run backup -- /some/folder -> writes there instead
// Needs DATABASE_URL (from .env or the environment).

try { process.loadEnvFile?.(require('path').join(__dirname, '..', '.env')); } catch { /* optional */ }
const fs = require('fs');
const path = require('path');
const store = require('../server/db');

(async () => {
  const pool = store.getPool();
  const ballots = (await pool.query('SELECT id, token_hash, submitted_at FROM ballots ORDER BY submitted_at')).rows;
  const votes = (await pool.query('SELECT ballot_id, category_id, nominee_id FROM ballot_votes')).rows;
  const dir = path.resolve(process.argv[2] || path.join(__dirname, '..', 'backups'));
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `rabbit-rabbi-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
  fs.writeFileSync(file, JSON.stringify({ exportedAt: new Date().toISOString(), ballots, votes }, null, 2));
  console.log(`Backup written: ${file} (${ballots.length} ballots)`);
  await store.close();
})().catch((e) => { console.error('Backup failed:', e.message); process.exit(1); });
