// 2B Desk server: API + realtime + routing engine + the dashboard files.
import http from 'node:http';
import { config as baseConfig } from './config.js';
import { createDb } from './db.js';
import { migrate } from './migrate.js';
import { createSettings } from './settings.js';
import { createDesk } from './desk.js';
import { createHub } from './hub.js';
import { createOutbound } from './outbound.js';
import { createApi } from './api.js';
import { hashPassword } from './auth.js';

async function bootstrapAdmin(db, admin, log) {
  const { n } = await db.one('SELECT count(*)::int AS n FROM desk.users');
  if (n > 0) return;
  if (!admin.username || !admin.password) {
    log.warn?.(
      '[setup] There are no users yet. Set ADMIN_USERNAME and ADMIN_PASSWORD and restart, ' +
        'or run: npm run users:create -- --role admin',
    );
    return;
  }
  if (admin.password.length < 8) {
    log.warn?.('[setup] ADMIN_PASSWORD must be at least 8 characters; no admin was created.');
    return;
  }
  await db.q(
    `INSERT INTO desk.users (employee_id, username, full_name, role, password_hash)
     VALUES ($1, lower($2), $3, 'admin', $4)`,
    [admin.employeeId, admin.username, admin.fullName, await hashPassword(admin.password)],
  );
  log.info?.(`[setup] Created the first admin "${admin.username}". Change the password after signing in.`);
}

export async function createServer(opts = {}) {
  const config = { ...baseConfig, ...(opts.config || {}) };
  const clock = opts.clock ?? { now: () => new Date() };
  const log = opts.log ?? console;
  const db = opts.db ?? createDb(config.databaseUrl, { ssl: config.databaseSsl });
  await migrate(db, log);
  const settings = createSettings(db);
  const hub = createHub({ log });
  const outbound =
    opts.outbound ?? createOutbound({ url: config.n8nSendUrl, secret: config.n8nSendSecret, log });
  const desk = createDesk({ db, clock, hub, outbound, settings, log });
  const api = createApi({ db, desk, settings, clock, config, hub, log });
  const server = http.createServer((req, res) => {
    api.handle(req, res).catch((err) => {
      log.error?.('[http]', err);
      if (!res.headersSent) res.writeHead(500);
      res.end();
    });
  });
  server.requestTimeout = 30_000;
  server.headersTimeout = 20_000;
  hub.attach(server, { desk, canView: api.canView, allowedOrigins: config.corsOrigins, clock });
  await bootstrapAdmin(db, config.bootstrapAdmin, log);

  return {
    server, db, desk, hub, settings, clock, config,
    listen(port = config.port) {
      return new Promise((resolve) => server.listen(port, () => resolve(server.address().port)));
    },
    async close() {
      desk.stop();
      hub.close();
      await new Promise((resolve) => server.close(() => resolve()));
      if (!opts.db) await db.end();
    },
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const app = await createServer();
  const port = await app.listen();
  app.desk.start(app.config.tickMs);
  if (process.env.DEMO_MODE === 'true') {
    const { startDemo } = await import('./demo.js');
    await startDemo({ desk: app.desk, db: app.db, clock: app.clock });
  }
  console.log(`2B Desk listening on http://localhost:${port}`);
  if (!app.config.ingestSecret) console.warn('[setup] DESK_INGEST_SECRET is empty: n8n cannot send chats yet.');
  if (!app.config.n8nSendUrl) console.warn('[setup] N8N_SEND_URL is empty: replies are NOT sent to customers (demo mode).');
  let stopping = false;
  const shutdown = async (signal) => {
    if (stopping) return;
    stopping = true;
    console.log(`${signal} received, shutting down…`);
    const force = setTimeout(() => process.exit(1), 10_000);
    force.unref();
    await app.close().catch(() => {});
    process.exit(0);
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}
