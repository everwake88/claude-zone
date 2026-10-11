// Postgres access: a pool, plain query helpers and a transaction wrapper.
import pg from 'pg';

// COUNT(*) and bigserial ids arrive as int8 strings by default. Every value
// this app stores fits comfortably in a JS number, so parse them as numbers.
pg.types.setTypeParser(20, (v) => Number.parseInt(v, 10));
pg.types.setTypeParser(1700, (v) => Number.parseFloat(v));

function helpers(runner) {
  return {
    async q(text, params) {
      const res = await runner.query(text, params);
      return res.rows;
    },
    async one(text, params) {
      const res = await runner.query(text, params);
      return res.rows[0] ?? null;
    },
  };
}

export function createDb(url, { ssl = false, max = 10 } = {}) {
  const pool = new pg.Pool({
    connectionString: url,
    max,
    ssl: ssl ? { rejectUnauthorized: false } : undefined,
  });
  pool.on('error', (err) => console.error('[db] idle client error', err.message));

  return {
    pool,
    ...helpers(pool),
    // Runs fn inside BEGIN/COMMIT; any throw rolls everything back.
    async tx(fn) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const result = await fn(helpers(client));
        await client.query('COMMIT');
        return result;
      } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        throw err;
      } finally {
        client.release();
      }
    },
    end: () => pool.end(),
  };
}
