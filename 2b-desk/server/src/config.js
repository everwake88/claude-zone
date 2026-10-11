// Every setting the server reads from its environment, in one place.
// See .env.example for what each one means.
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const env = process.env;

function int(v, fallback) {
  const n = Number.parseInt(v, 10);
  return Number.isFinite(n) ? n : fallback;
}

function list(v) {
  return String(v || '')
    .split(',')
    .map((s) => s.trim().replace(/\/+$/, ''))
    .filter(Boolean);
}

export const config = {
  port: int(env.PORT, 8080),
  databaseUrl: env.DATABASE_URL || 'postgres://postgres:postgres@127.0.0.1:5432/desk_dev',
  databaseSsl: env.DATABASE_SSL === 'true',

  // n8n -> desk. Sent by n8n in the X-Desk-Secret header on /api/ingest/*.
  ingestSecret: env.DESK_INGEST_SECRET || '',

  // desk -> n8n. The webhook of the "2B — Desk Outbound Sender" workflow.
  // Empty = demo mode: replies are marked sent without leaving the server.
  n8nSendUrl: env.N8N_SEND_URL || '',
  n8nSendSecret: env.N8N_SEND_SECRET || '',

  // Only needed when the dashboard is hosted somewhere else (Vercel, Cloudflare).
  corsOrigins: list(env.CORS_ORIGINS),

  serveWeb: env.SERVE_WEB !== 'false',
  webDir: env.WEB_DIR || path.resolve(here, '../../web'),

  tickMs: int(env.TICK_MS, 5000),
  trustProxy: env.TRUST_PROXY !== 'false',

  // Creates the first admin on start-up if there are no users yet.
  bootstrapAdmin: {
    username: env.ADMIN_USERNAME || '',
    password: env.ADMIN_PASSWORD || '',
    fullName: env.ADMIN_NAME || 'Desk Admin',
    employeeId: env.ADMIN_EMPLOYEE_ID || 'ADMIN-1',
  },
};
