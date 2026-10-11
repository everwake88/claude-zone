// Builds a demo desk: the 2B team (25 agents, 2 supervisors, 1 admin) and
// one or more simulated days of chats, so every screen has something to show.
//
// It WIPES the "desk" schema of DATABASE_URL first. Demo / local use only.
//   npm run demo:seed -- --yes-wipe [--days 2]
import { config } from '../src/config.js';
import { createDb } from '../src/db.js';
import { migrate } from '../src/migrate.js';
import { createSettings } from '../src/settings.js';
import { createDesk } from '../src/desk.js';
import { hashPassword } from '../src/auth.js';
import { createSimulation, demoPeople, DEMO_PASSWORD, HUMANS } from '../src/demo.js';

const args = process.argv.slice(2);
const where = config.databaseUrl.replace(/\/\/[^@]*@/, '//***@');
if (!args.includes('--yes-wipe')) {
  console.error(`This deletes all 2B Desk data in ${where} and fills it with demo data.\nRun again with --yes-wipe to continue.`);
  process.exit(1);
}
const days = Math.max(1, Math.min(7, Number(args[args.indexOf('--days') + 1]) || 2));

const db = createDb(config.databaseUrl, { ssl: config.databaseSsl });
await db.q('DROP SCHEMA IF EXISTS desk CASCADE');
await migrate(db, { info: () => {} });

const hash = await hashPassword(DEMO_PASSWORD);
for (const p of demoPeople()) {
  await db.q(
    `INSERT INTO desk.users (employee_id, username, full_name, role, password_hash) VALUES ($1, $2, $3, $4, $5)`,
    [p.employee_id, p.username, p.full_name, p.role, hash],
  );
}

let t = 0;
const clock = { now: () => new Date(t) };
const quiet = { info() {}, warn() {}, error: (...a) => console.error(...a) };
const settings = createSettings(db);
const desk = createDesk({
  db, clock, settings, log: quiet, hub: null,
  outbound: { send: async () => ({ ok: true, external_id: null }) },
});
const sim = createSimulation({ desk, db, clock, seed: 42 });
await sim.load();

const tz = (await settings.get()).timezone;
const end = Date.now();
const startDay = new Date(end - (days - 1) * 86400_000);
const { start } = await db.one(
  `SELECT (date_trunc('day', $1::timestamptz AT TIME ZONE $2) + interval '8 hours 30 minutes') AT TIME ZONE $2 AS start`,
  [startDay, tz],
);
const hourOf = (ms) => Number(new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: '2-digit', hour12: false }).format(new Date(ms)));

const STEP = 30_000;
t = new Date(start).getTime();
let lastHour = -1;
console.log(`Simulating ${days} day(s) of the 2B desk (${tz}) — this takes a few minutes…`);
while (t < end) {
  const h = hourOf(t);
  if (h >= 0 && h < 8) {
    // Nights are quiet: jump to 08:30 the same morning.
    const { next } = await db.one(
      `SELECT (date_trunc('day', $1::timestamptz AT TIME ZONE $2) + interval '8 hours 30 minutes') AT TIME ZONE $2 AS next`,
      [new Date(t), tz],
    );
    t = Math.min(end, new Date(next).getTime());
    continue;
  }
  await sim.step(STEP);
  await desk.tick();
  if (h !== lastHour) {
    lastHour = h;
    const { n } = await db.one(`SELECT count(*)::int AS n FROM desk.conversations`);
    process.stdout.write(`  ${new Date(t).toLocaleString('en-GB', { timeZone: tz })} · ${n} chats so far\n`);
  }
  t += STEP;
}
const totals = await db.one(
  `SELECT count(*)::int AS chats, count(*) FILTER (WHERE status <> 'closed')::int AS open,
          (SELECT count(*) FROM desk.messages)::int AS messages FROM desk.conversations`,
);
console.log(`Done: ${totals.chats} chats (${totals.open} still open), ${totals.messages} messages.`);
console.log(`\nSign in with password "${DEMO_PASSWORD}" as:`);
console.log(`  agent       ${HUMANS.agent.username}`);
console.log(`  supervisor  ${HUMANS.supervisor.username}`);
console.log(`  admin       ${HUMANS.admin.username}`);
console.log(`\nStart the server with DEMO_MODE=true to keep the virtual team working live.`);
await db.end();
