import 'server-only';
import { Pool, types, type QueryResultRow } from 'pg';

// a DATE column stays the text it is ("2026-10-01"): a JS Date would shift it by the time zone
types.setTypeParser(1082, (v) => v);
// bigint ids and counts fit a JS number here
types.setTypeParser(20, (v) => Number(v));

// One small pool per server instance (a Vercel function keeps it between requests).
const globalForPool = globalThis as unknown as { __salaryPool?: Pool };

function makePool() {
  const ssl = process.env.DATABASE_SSL === 'disable' ? false : { rejectUnauthorized: process.env.DATABASE_SSL !== 'no-verify' };
  return new Pool({ connectionString: process.env.DATABASE_URL, ssl, max: 5, idleTimeoutMillis: 10_000 });
}
export const pool = globalForPool.__salaryPool ?? (globalForPool.__salaryPool = makePool());

export async function q<T extends QueryResultRow = QueryResultRow>(text: string, values: unknown[] = []): Promise<T[]> {
  const r = await pool.query<T>(text, values);
  return r.rows;
}
export async function one<T extends QueryResultRow = QueryResultRow>(text: string, values: unknown[] = []): Promise<T | null> {
  const rows = await q<T>(text, values);
  return rows[0] ?? null;
}
