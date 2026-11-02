// Runs the engine's n8n Code nodes exactly as n8n does ($input, $('Node'),
// $runIndex, Buffer), against a real database built from the migrations.
// The model calls (Brain, Agent, staff assistant) are scripted by each test,
// so every other step — SQL, code, tools — is the real thing.
import { readFileSync, readdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { expand } from '../build.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const DB_DIR = join(HERE, '..', '..', 'database');
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
export const DB_NAME = process.env.ENGINE_TEST_DB || 'clinic_engine_test';
const conn = { host: process.env.PGHOST || 'localhost', user: process.env.PGUSER || 'postgres', password: process.env.PGPASSWORD || 'postgres' };
const pgEnv = () => ({ ...process.env, PGHOST: conn.host, PGUSER: conn.user, PGPASSWORD: conn.password });

export function psqlFile(path) {
  execFileSync('psql', ['-X', '-q', '-v', 'ON_ERROR_STOP=1', '-1', '-d', DB_NAME, '-f', join(DB_DIR, path)], { env: pgEnv() });
}
export function freshDatabase() {
  execFileSync('psql', ['-X', '-q', '-d', 'postgres', '-c', `drop database if exists ${DB_NAME}`, '-c', `create database ${DB_NAME}`], { env: pgEnv() });
  psqlFile(join('tests', 'fixtures', 'vault_stub.sql'));
  for (const f of readdirSync(join(DB_DIR, 'migrations')).filter(f => /^0\d\d_.*\.sql$/.test(f) && !f.startsWith('090')).sort()) psqlFile(join('migrations', f));
  psqlFile(join('seed', 'demo_clinic.sql'));
}
export async function connect() {
  const client = new pg.Client({ ...conn, database: DB_NAME });
  await client.connect();
  return client;
}
export const unb64 = (s) => JSON.parse(Buffer.from(s, 'base64').toString('utf8'));

export async function runCode(file, { input = {}, nodes = {}, runIndex = 0 } = {}) {
  const src = expand(readFileSync(join(HERE, '..', 'src', file), 'utf8'));
  const $input = { first: () => ({ json: input }), all: () => [{ json: input }], item: { json: input } };
  const $ = (name) => {
    if (!(name in nodes)) throw new Error(`Referenced node "${name}" is unexecuted`);
    return { first: () => ({ json: nodes[name] }), all: () => [{ json: nodes[name] }], item: { json: nodes[name] } };
  };
  const out = await new AsyncFunction('$input', '$', '$runIndex', 'Buffer', src)($input, $, runIndex, Buffer);
  return (out || []).map(i => i.json);
}
export async function sql(db, query, params = []) { return (await db.query(query, params)).rows[0] || {}; }
export const callB64 = (db, fn, b64) => sql(db, `select clinic.${fn}(convert_from(decode($1::text, 'base64'), 'UTF8')::jsonb) as r`, [b64]);

export function evolutionPayload({ text, phone, lid, pushName = 'Test', id, fromMe = false, instance = 'nileclinic', token = 'demo-token',
                                   type, event = 'messages.upsert', quoted }) {
  const key = { id: id || 'MSG' + Math.random().toString(36).slice(2, 10), fromMe };
  if (phone) key.remoteJid = phone + '@s.whatsapp.net';
  if (lid) { if (!phone) key.remoteJid = lid + '@lid'; else key.remoteJidAlt = lid + '@lid'; }
  const message = type === 'image' ? { imageMessage: { mimetype: 'image/jpeg', ...(text ? { caption: text } : {}) } }
    : type === 'audio' ? { audioMessage: { seconds: 6, mimetype: 'audio/ogg; codecs=opus' } }
    : type === 'pdf' ? { documentMessage: { mimetype: 'application/pdf', fileName: 'cbc.pdf' } }
    : quoted ? { extendedTextMessage: { text, contextInfo: { stanzaId: quoted.id, quotedMessage: { conversation: quoted.text || '' } } } }
    : { conversation: text };
  return { headers: {}, params: {}, query: { token }, body: { event, instance, data: { key, pushName, message, messageType: Object.keys(message)[0] } } };
}

// the tool sub-workflows, wired exactly like n8n
export async function manageBooking(db, intake, action, details = {}) {
  const args = (await runCode('booking/read_args.js', { input: { tenant_id: intake.tenant_id, wa_id: intake.wa_id, action, details } }))[0];
  const res = await sql(db, "select clinic.booking_tool($1::uuid, $2::text, $3::text, convert_from(decode($4::text, 'base64'), 'UTF8')) as r",
                        [args.tenant_id, args.wa_id, args.action, args.details_b64]);
  return JSON.parse((await runCode('booking/return_to_agent.js', { input: res }))[0].response);
}
export async function staffAction(db, intake, action, details = {}) {
  const args = (await runCode('staff/read_args.js', { input: { tenant_id: intake.tenant_id, wa_id: intake.wa_id, staff: JSON.stringify(intake.staff),
                                                               action, details } }))[0];
  const res = await sql(db, 'select clinic.staff_tool($1::uuid, $2::text, $3::jsonb, $4::text, $5::text) as r',
                        [args.tenant_id, args.wa_id, args.staff_json, args.action, args.details_json]);
  return JSON.parse((await runCode('staff/return_to_agent.js', { input: res }))[0].response);
}

// media: the models' answers are scripted (media.heard for a voice note, media.seen for a photo or a PDF)
async function understandMedia(db, nodes, media) {
  const prep = (await runCode('main/prepare_media.js', { input: { body: { base64: 'x'.repeat(200), mimetype: media.mime } }, nodes }))[0];
  nodes['Prepare Media'] = prep;
  const modelOut = prep.kind === 'audio' ? { text: media.heard || '' } : { choices: [{ message: { content: media.seen || '' } }] };
  const u = (await runCode('main/media_understood.js', { input: modelOut, nodes }))[0];
  nodes['Media Understood'] = u;
  await callB64(db, 'media_understood', u.b64_media);
  if (u.b64_doc) nodes['Keep On The Record'] = await callB64(db, 'save_document', u.b64_doc);
  return u;
}

// one whole turn of Main. script(brief, intake) → { plan, tools: [{action, details}], reply }
export async function turn(db, payload, script, opts = {}) {
  const nodes = {};
  const norm = (await runCode('main/normalize_inbound.js', { input: payload }))[0];
  nodes['Normalize Inbound'] = norm;
  if (norm.is_ignorable) return { route: 'ignored', norm };
  const intake = await callB64(db, 'intake', norm.b64_intake);
  nodes.Intake = intake;
  const r = intake.r;
  if (r.route !== 'agent' && r.route !== 'staff') return { route: r.route, intake: r, norm, nodes };
  let media = null;
  if (norm.media) media = await understandMedia(db, nodes, opts.media || {});
  const claim = await sql(db, 'select clinic.claim_window($1::uuid, $2::text, $3::text, $4::bigint) as r',
                          [r.tenant_id, r.wa_id, norm.run_id, String(r.buffer_id)]);
  nodes['Claim Debounce Window'] = claim;
  if (!(claim.r.is_newest && claim.r.lock_acquired)) return { route: 'superseded', claim: claim.r, nodes };

  if (r.route === 'staff') {
    nodes['Load Staff Context'] = await sql(db, 'select clinic.staff_context($1::uuid, $2::text, $3::jsonb) as r', [r.tenant_id, r.wa_id, JSON.stringify(r.staff)]);
    const brief = (await runCode('staff/build_staff_brief.js', { input: nodes['Load Staff Context'], nodes }))[0];
    nodes['Build Staff Brief'] = brief;
    const s = await script(brief, r);
    const steps = [];
    for (const call of s.tools || []) {
      const result = await staffAction(db, r, call.action, call.details || {});
      steps.push({ action: { tool: 'staff_action' }, observation: JSON.stringify({ response: JSON.stringify(result) }), result });
    }
    const reply = typeof s.reply === 'function' ? s.reply(steps) : s.reply;
    const checked = (await runCode('staff/check_staff_reply.js', { input: { output: reply, intermediateSteps: steps.map(({ action, observation }) => ({ action, observation })) }, nodes }))[0];
    const persistP = (await runCode('staff/build_staff_persist.js', { input: checked, nodes }))[0];
    nodes['Build Staff Persist'] = persistP;
    const persisted = await callB64(db, 'persist_turn', persistP.b64_persist);
    const outbound = await runCode('staff/prepare_staff_outbound.js', { input: persisted, nodes });
    for (const item of outbound) {
      nodes['Outbound Loop'] = item;
      const rec = (await runCode('main/record_reply_send.js', { input: { body: { key: { id: 'OUT' + Math.random().toString(36).slice(2, 10) } } }, nodes }))[0];
      await callB64(db, 'log_outbound', rec.b64_log);
    }
    return { route: 'staff', intake: r, brief, steps, checked, outbound, nodes };
  }

  const ctx = await sql(db, 'select clinic.turn_context($1::uuid, $2::text) as r', [r.tenant_id, r.wa_id]);
  nodes['Load Turn Context'] = ctx;
  const brief = (await runCode('main/build_brief.js', { input: ctx, nodes }))[0];
  nodes['Build Brief'] = brief;
  const s = await script(brief, r);
  const plan = (await runCode('main/attach_plan.js', { input: { text: JSON.stringify(s.plan || {}) }, nodes }))[0];
  nodes['Attach Plan'] = plan;
  const steps = [];
  for (const call of s.tools || []) {
    const result = call.fail ? { error: call.fail } : await manageBooking(db, r, call.action, call.details || {});
    steps.push({ action: { tool: 'manage_booking', toolInput: { action: call.action, details: call.details } },
                 observation: JSON.stringify({ response: JSON.stringify(result) }), result });
  }
  const reply = typeof s.reply === 'function' ? s.reply(steps) : s.reply;
  nodes.Agent = { output: reply, intermediateSteps: steps.map(({ action, observation }) => ({ action, observation })),
                  tokenUsage: { promptTokens: 1000, completionTokens: 200 } };
  const readBack = await sql(db, 'select clinic.read_back($1::uuid, $2::text) as r', [r.tenant_id, r.wa_id]);
  nodes['Read Back State'] = readBack;
  let checked = (await runCode('main/check_reply.js', { input: readBack, nodes }))[0];
  nodes['Check Reply'] = checked;
  if (checked.needs_rewrite) checked = (await runCode('main/repair_reply.js', { input: checked, nodes }))[0];
  const persistPayload = (await runCode('main/build_persist_payload.js', { input: checked, nodes }))[0];
  nodes['Build Persist Payload'] = persistPayload;
  const persisted = await callB64(db, 'persist_turn', persistPayload.b64_persist);
  nodes['Persist Turn + Unlock'] = persisted;
  const outbound = await runCode('main/prepare_outbound.js', { input: persisted, nodes });
  for (const item of outbound) {
    nodes['Outbound Loop'] = item;
    const rec = (await runCode('main/record_reply_send.js', { input: { body: { key: { id: 'OUT' + Math.random().toString(36).slice(2, 10) } } }, nodes }))[0];
    await callB64(db, 'log_outbound', rec.b64_log);
  }
  return { route: 'agent', intake: r, brief, plan, steps, checked, persisted: persisted.r, outbound, media, nodes };
}
