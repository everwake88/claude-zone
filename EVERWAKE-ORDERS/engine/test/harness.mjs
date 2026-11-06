// Runs the engine's n8n Code nodes exactly as n8n does ($input, $('Node'),
// $runIndex, Buffer), against a real database built from the migrations.
// The calls to OpenAI are answered by a stand-in that speaks the Responses
// API (each test scripts the plan, the tool calls and the reply), so every
// other step — the Brain and Agent loop nodes, SQL, code, tools, the cost
// records — is the real thing.
import { readFileSync, readdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { expand, fill } from '../build.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const DB_DIR = join(HERE, '..', '..', 'database');
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;

export const DB_NAME = process.env.ENGINE_TEST_DB || 'everwake_engine_test';
const conn = { host: process.env.PGHOST || 'localhost', user: process.env.PGUSER || 'tester',
               password: process.env.PGPASSWORD || 'tester' };

const pgEnv = () => ({ ...process.env, PGHOST: conn.host, PGUSER: conn.user, PGPASSWORD: conn.password });

// a SQL file from database/, run with psql against the test database
export function psqlFile(path) {
  execFileSync('psql', ['-X', '-q', '-v', 'ON_ERROR_STOP=1', '-d', DB_NAME, '-f', join(DB_DIR, path)], { env: pgEnv() });
}

export function freshDatabase() {
  execFileSync('psql', ['-X', '-q', '-d', 'postgres', '-c', `drop database if exists ${DB_NAME}`, '-c', `create database ${DB_NAME}`], { env: pgEnv() });
  psqlFile(join('tests', 'fixtures', 'vault_stub.sql'));      // Supabase Vault's stand-in (local only)
  const files = readdirSync(join(DB_DIR, 'migrations')).filter(f => /^0[0-8]\d_.*\.sql$/.test(f)).sort();
  for (const f of files) psqlFile(join('migrations', f));
  psqlFile(join('seed', 'demo_restaurant.sql'));
  psqlFile(join('tools', 'import_legacy.sql'));
}

export async function connect() {
  const client = new pg.Client({ ...conn, database: DB_NAME });
  await client.connect();
  return client;
}

const unb64 = (s) => JSON.parse(Buffer.from(s, 'base64').toString('utf8'));
export { unb64 };

// one Code node: returns the items it outputs (the .json of each)
export async function runCode(file, { input = {}, nodes = {}, runIndex = 0 } = {}) {
  const src = fill(expand(readFileSync(join(HERE, '..', 'src', file), 'utf8')));
  const $input = { first: () => ({ json: input }), all: () => [{ json: input }], item: { json: input } };
  const $ = (name) => {
    if (!(name in nodes)) throw new Error(`Referenced node "${name}" is unexecuted`);
    return { first: () => ({ json: nodes[name] }), all: () => [{ json: nodes[name] }], item: { json: nodes[name] }, isExecuted: true };
  };
  const out = await new AsyncFunction('$input', '$', '$runIndex', 'Buffer', src)($input, $, runIndex, Buffer);
  return (out || []).map(i => i.json);
}

// one Postgres node: select everwake.fn(...) as r → { r }
export async function sql(db, query, params = []) {
  const res = await db.query(query, params);
  return res.rows[0] || {};
}
export const callB64 = (db, fn, b64) => sql(db, `select everwake.${fn}(convert_from(decode($1::text, 'base64'), 'UTF8')::jsonb) as r`, [b64]);

// an Evolution "messages.upsert" webhook as n8n's Webhook node hands it over
export function evolutionPayload({ text, phone, lid, pushName = 'Test', id, fromMe = false, location, instance = 'nilegrill',
                                   token = 'demo-token', type, event = 'messages.upsert', quoted }) {
  const key = { id: id || 'MSG' + Math.random().toString(36).slice(2, 10), fromMe };
  if (phone) key.remoteJid = phone + '@s.whatsapp.net';
  if (lid) { if (!phone) key.remoteJid = lid + '@lid'; else key.remoteJidAlt = lid + '@lid'; }
  const message = location ? { locationMessage: { degreesLatitude: location.lat, degreesLongitude: location.lng } }
    : type === 'image' ? { imageMessage: { mimetype: 'image/jpeg', ...(text ? { caption: text } : {}) } }
    : (type === 'audio' ? { audioMessage: { seconds: 4, mimetype: 'audio/ogg; codecs=opus' } } : (type === 'reaction' ? { reactionMessage: { text: '👍' } }
    // a swipe-reply: WhatsApp sends the text with the message it answers attached
    : quoted ? { extendedTextMessage: { text, contextInfo: { stanzaId: quoted.id, quotedMessage: quoted.message || { conversation: quoted.text || '' } } } }
    : { conversation: text }));
  return { headers: {}, params: {}, query: { token },
           body: { event, instance, data: { key, pushName, message, messageType: Object.keys(message)[0] } } };
}

// ---- the tool sub-workflows, wired exactly like n8n -----------------------
// stands in for the dashboard's /api/pay/link (which calls Paymob): the same
// database steps, with a made-up checkout address. Tests may swap it.
export const payLinks = {
  async make(db, tenant, orderNo) {
    const p = (await sql(db, 'select everwake.payment_prepare($1::uuid, $2::text) as r', [tenant, orderNo])).r;
    if (!p.ok) return { ok: false, status: p.error, reason: p.reason, fact: p.fact };
    return (await sql(db, 'select everwake.payment_link_saved($1::bigint, $2::text, $3::text, $4::bigint, false) as r',
                      [p.payment_id, `https://eg.checkout.paymob.com/?publicKey=pk&clientSecret=cs_${p.ref}`, `pi_${p.ref}`, 900000 + p.payment_id])).r;
  }
};

export async function manageCart(db, intake, action, items = [], branch = '') {
  const args = (await runCode('cart/read_args.js', { input: { tenant_id: intake.tenant_id, wa_id: intake.wa_id, action,
    items_json: typeof items === 'string' ? items : JSON.stringify(items), branch_id: branch } }))[0];
  const ctx = await sql(db, 'select everwake.cart_context($1::uuid, $2::text, $3::text) as r', [args.tenant_id, args.wa_id, args.branch_id || '']);
  const applied = (await runCode('cart/apply_recalculate.js', { input: ctx, nodes: { 'Read Args': args } }))[0];
  const nodes = { 'Read Args': args, 'Apply + Recalculate': applied };
  if (!applied.ok) return JSON.parse((await runCode('cart/format_tool_error.js', { input: applied }))[0].response);
  if (applied.is_place) {
    nodes['Place Order'] = await callB64(db, 'place_order', applied.b64_place);
    const no = (nodes['Place Order'].r || {}).order_no || '';
    nodes['Payment Needed?'] = await sql(db, 'select everwake.payment_after_place($1::uuid, $2::text) as r', [args.tenant_id, no]);
    if (nodes['Payment Needed?'].r && nodes['Payment Needed?'].r.needed) nodes['Create Payment Link'] = await payLinks.make(db, args.tenant_id, no);
  } else if (!applied.is_quote) await callB64(db, 'persist_cart', applied.b64_cart);   // a quote saves nothing
  return JSON.parse((await runCode('cart/format_tool_response.js', { input: {}, nodes }))[0].response);
}

export async function saveDetails(db, intake, details) {
  const trigger = { tenant_id: intake.tenant_id, wa_id: intake.wa_id, details_json: JSON.stringify(details) };
  const ctx = await sql(db, 'select everwake.details_context($1::uuid, $2::text) as r', [intake.tenant_id, intake.wa_id]);
  const v = (await runCode('details/validate_patch.js', { input: ctx, nodes: { 'Tool Called By Agent': trigger } }))[0];
  if (!v.ok) return JSON.parse(v.response);
  const persisted = await callB64(db, 'persist_details', v.b64_persist);
  return JSON.parse((await runCode('details/return_to_agent.js', { input: persisted, nodes: { 'Validate + Patch': v } }))[0].response);
}

export async function manageReservation(db, intake, action, details = '') {
  const args = (await runCode('reservation/read_args.js', { input: { tenant_id: intake.tenant_id, wa_id: intake.wa_id, action,
    details_json: details } }))[0];
  const res = await sql(db, "select everwake.reservation_tool($1::uuid, $2::text, $3::text, convert_from(decode($4::text, 'base64'), 'UTF8')) as r",
                        [args.tenant_id, args.wa_id, args.action, args.details_b64]);
  return JSON.parse((await runCode('reservation/return_to_agent.js', { input: res }))[0].response);
}

// ---- the stand-in for OpenAI ------------------------------------------------------
// an HTTP Request node's full response to a Responses API call, with usage as OpenAI reports it
export const BRAIN_USAGE = { input_tokens: 10240, input_tokens_details: { cached_tokens: 8960 }, output_tokens: 2311, output_tokens_details: { reasoning_tokens: 1987 } };
export const AGENT_USAGE = { input_tokens: 12001, input_tokens_details: { cached_tokens: 11904 }, output_tokens: 180, output_tokens_details: { reasoning_tokens: 64 } };
export function fakeResponse(output, usage, model = 'gpt-6-luna-2026-10-01') {
  return { statusCode: 200, headers: {}, body: { id: 'resp_' + Math.random().toString(36).slice(2, 10), object: 'response', status: 'completed',
                                                model, output, usage } };
}

// ---- one whole turn of the Main workflow ----------------------------------------
// script(brief) → { plan, tools: async (call) => [...steps], reply }
export async function turn(db, payload, script, opts = {}) {
  const nodes = {};
  const norm = (await runCode('main/normalize_inbound.js', { input: payload }))[0];
  nodes['Normalize Inbound'] = norm;
  if (norm.is_ignorable) return { route: 'ignored', norm };
  const intake = await callB64(db, 'intake', norm.b64_intake);
  nodes.Intake = intake;
  const r = intake.r;
  if (r.route !== 'agent') return { route: r.route, intake: r, norm, nodes };

  nodes['Load AI Settings'] = await sql(db, 'select everwake.ai_settings($1::uuid) as r', [r.tenant_id]);
  const claim = await sql(db, 'select everwake.claim_window($1::uuid, $2::text, $3::text, $4::bigint) as r',
                          [r.tenant_id, r.wa_id, norm.run_id, String(r.buffer_id)]);
  nodes['Claim Debounce Window'] = claim;
  if (!(claim.r.is_newest && claim.r.lock_acquired)) return { route: 'superseded', claim: claim.r, nodes };

  if (claim.r.has_location) {
    const geo = opts.geo || {};
    nodes['Reverse Geocode (Google)'] = { ok: true, street: geo.street || 'شارع تجريبي', district: geo.district || '',
                                         city: 'القاهرة', governorate: 'القاهرة', formatted: 'test' };
    const resolved = (await runCode('main/resolve_location.js', { input: {}, nodes }))[0];
    nodes['Resolve Location'] = resolved;
    nodes['Save Pin + Zone'] = await callB64(db, 'save_pin', resolved.b64_pin);
  }
  // the turn's context, its brief, and the way it takes: a ❤️, a detail read by code, or the AI (018)
  const prepare = async () => {
    const ctx = await sql(db, 'select everwake.turn_context($1::uuid, $2::text) as r', [r.tenant_id, r.wa_id]);
    nodes['Load Turn Context'] = ctx;
    nodes['Build Brief'] = (await runCode('main/build_brief.js', { input: ctx, nodes }))[0];
    nodes['Route Without AI'] = (await runCode('main/route_without_ai.js', { input: nodes['Build Brief'], nodes }))[0];
    return nodes['Route Without AI'];
  };
  let routed = await prepare();
  let byCode = null;
  if (routed.no_ai === 'details') {
    nodes['Save Details (code)'] = { response: JSON.stringify(await saveDetails(db, r, routed.details_by_code)) };
    const rep = (await runCode('main/details_by_code_reply.js', { input: nodes['Save Details (code)'], nodes }))[0];
    nodes['Details By Code — Reply'] = rep;
    if (rep.ai_again) routed = await prepare(); else byCode = rep;
  }
  const brief = nodes['Build Brief'];
  if (byCode || routed.no_ai === 'react') {
    return finish(db, r, nodes, byCode || routed, { route: 'agent', no_ai: byCode ? 'details' : 'react', intake: r, brief, steps: [], opts });
  }

  const s = await script(brief, r);
  // the Brain: its request, the stand-in's answer, its result (as n8n would run them)
  nodes['Brain Request'] = (await runCode('main/brain_request.js', { input: routed, nodes }))[0];
  const brainAnswer = s.brainFail ? { error: { message: s.brainFail } }
    : fakeResponse([{ type: 'message', content: [{ type: 'output_text', text: JSON.stringify(s.plan || {}) }] }], s.brainUsage || BRAIN_USAGE);
  nodes['Brain Result'] = (await runCode('main/brain_result.js', { input: brainAnswer, nodes }))[0];
  const plan = (await runCode('main/attach_plan.js', { input: nodes['Brain Result'], nodes }))[0];
  nodes['Attach Plan'] = plan;

  // the Agent's tool loop: each scripted tool call is a round, the reply ends it; the tools are the real workflows
  const steps = [];
  const calls = [...(s.tools || [])];
  let reqIn = plan, round = 0;
  const bodies = [];
  for (;;) {
    nodes['Agent Request'] = (await runCode('main/agent_request.js', { input: reqIn, nodes }))[0];
    bodies.push(nodes['Agent Request'].body);
    round++;
    let answer;
    const call = calls[0];
    if (s.agentFail && round >= (s.agentFailRound || 1)) answer = { error: { message: s.agentFail } };
    else if (call && round <= 12) {
      calls.shift();
      const args = call.raw !== undefined ? call.raw : JSON.stringify({ action: call.action, branch: call.branch, items: call.items, details: call.details });
      answer = fakeResponse([{ type: 'reasoning', id: 'rs_' + round, summary: [], encrypted_content: 'enc' + round },
                             { type: 'function_call', id: 'fc_' + round, call_id: 'call_' + round, name: call.tool, arguments: args }], s.agentUsage || AGENT_USAGE);
    } else {
      const reply = typeof s.reply === 'function' ? s.reply(steps) : s.reply;
      answer = fakeResponse([{ type: 'message', content: [{ type: 'output_text', text: typeof reply === 'string' ? reply : JSON.stringify(reply) }] }], s.agentUsage || AGENT_USAGE);
    }
    const step = (await runCode('main/agent_step.js', { input: answer, nodes }))[0];
    nodes['Agent Step'] = step;
    if (step.next === 'done') break;
    if (step.next === 'again') { reqIn = step; continue; }
    const a = step.tool_args;
    let toolOut;
    try {
      const result = call.fail ? null
        : step.next === 'manage_cart' ? await manageCart(db, r, a.action, a.items, a.branch === 'none' ? '' : a.branch)
        : step.next === 'manage_reservation' ? await manageReservation(db, r, a.action, typeof a.details === 'string' ? a.details : JSON.stringify(a.details))
        : await saveDetails(db, r, a.details);
      // a call the tool workflow failed on: the Execute Workflow node hands on { error }
      toolOut = call.fail ? { error: call.fail } : { response: JSON.stringify(result) };
      steps.push({ action: { tool: step.next }, observation: toolOut.response || JSON.stringify(toolOut), result: call.fail ? { error: call.fail } : result });
    } catch (e) { toolOut = { error: e.message }; steps.push({ action: { tool: step.next }, observation: JSON.stringify(toolOut), result: toolOut }); }
    nodes['Agent Tool Result'] = (await runCode('main/agent_tool_result.js', { input: toolOut, nodes }))[0];
    reqIn = nodes['Agent Tool Result'];
  }
  nodes.Agent = (await runCode('main/agent_finish.js', { input: nodes['Agent Step'], nodes }))[0];
  // Record AI Usage, as the workflow's Postgres node runs it
  const usage = await sql(db, "select everwake.record_ai_usage($1::uuid, nullif($2::text, '')::bigint, $3::text, $4::text, convert_from(decode($5::text, 'base64'), 'UTF8')::jsonb) as r",
                          [r.tenant_id, String(r.message_id || ''), norm.run_id || '', norm.is_test ? 'test' : 'text', nodes.Agent.b64_usage]);
  const readBack = await sql(db, 'select everwake.read_back($1::uuid, $2::text) as r', [r.tenant_id, r.wa_id]);
  nodes['Read Back State'] = readBack;
  let checked = (await runCode('main/check_reply.js', { input: readBack, nodes }))[0];
  nodes['Check Reply'] = checked;
  if (checked.needs_rewrite) checked = (await runCode('main/repair_reply.js', { input: checked, nodes }))[0];
  return finish(db, r, nodes, checked, { route: 'agent', intake: r, brief, plan, steps, s, bodies, recorded: usage.r });
}

// the turn's own record and its messages, however it was answered
async function finish(db, r, nodes, checked, out) {
  const s = out.s || {};
  const persistPayload = (await runCode('main/build_persist_payload.js', { input: checked, nodes }))[0];
  nodes['Build Persist Payload'] = persistPayload;
  if (s.beforePersist) await s.beforePersist();
  const persisted = await callB64(db, 'persist_turn', persistPayload.b64_persist);
  nodes['Persist Turn + Unlock'] = persisted;
  const media = await callB64(db, 'reply_media', persistPayload.b64_media);
  const outbound = await runCode('main/prepare_outbound.js', { input: media, nodes });

  let ticket = [];
  if (persistPayload.order_placed_no) {
    const t = await sql(db, 'select everwake.order_ticket($1::uuid, $2::text) as r', [r.tenant_id, persistPayload.order_placed_no]);
    ticket = await runCode('main/build_order_ticket.js', { input: t, nodes });
  }
  // what Evolution would answer, logged like the real loop does
  for (const item of outbound) {
    nodes['Outbound Loop'] = item;
    const rec = (await runCode('main/record_reply_send.js', { input: { body: { key: { id: 'OUT' + Math.random().toString(36).slice(2, 10) } } }, nodes }))[0];
    await callB64(db, 'log_outbound', rec.b64_log);
  }
  return { ...out, s: undefined, checked, persisted: persisted.r, outbound, ticket, nodes };
}
