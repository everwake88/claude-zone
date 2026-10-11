// Applies migrations/*.sql in name order, each exactly once.
// Run directly with `npm run migrate`; the server also runs it on start-up.
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const dir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../migrations');

export async function migrate(db, log = console) {
  await db.q('CREATE SCHEMA IF NOT EXISTS desk');
  await db.q(`CREATE TABLE IF NOT EXISTS desk.migrations (
                name text PRIMARY KEY,
                applied_at timestamptz NOT NULL DEFAULT now())`);
  const done = new Set((await db.q('SELECT name FROM desk.migrations')).map((r) => r.name));
  const files = (await fs.readdir(dir)).filter((f) => f.endsWith('.sql')).sort();
  for (const file of files) {
    if (done.has(file)) continue;
    const sql = await fs.readFile(path.join(dir, file), 'utf8');
    await db.tx(async (c) => {
      // Serialise concurrent start-ups so two containers never race a migration.
      await c.q('SELECT pg_advisory_xact_lock(727274)');
      const again = await c.one('SELECT 1 AS x FROM desk.migrations WHERE name = $1', [file]);
      if (again) return;
      await c.q(sql);
      await c.q('INSERT INTO desk.migrations (name) VALUES ($1)', [file]);
    });
    log.info?.(`[migrate] applied ${file}`);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const { config } = await import('./config.js');
  const { createDb } = await import('./db.js');
  const db = createDb(config.databaseUrl, { ssl: config.databaseSsl });
  try {
    await migrate(db);
    console.log('Migrations up to date.');
  } finally {
    await db.end();
  }
}
