#!/usr/bin/env node
// =====================================================================
// Everwake Clinic · engine builder
//
// The engine's code lives in src/ (one file per n8n Code node) and its
// prompts in prompts/. This script assembles them into the workflows you
// import into n8n (dist/*.json):
//
//   Everwake Clinic — Main (Brain + Agent)     the WhatsApp webhook, every clinic:
//                                              patients → Brain → Agent; the team's own
//                                              numbers → the staff assistant
//   Everwake Clinic — Tool: manage_booking     called by the Agent
//   Everwake Clinic — Tool: staff_action       called by the staff assistant
//   Everwake Clinic — Outbox + Housekeeping    reminders, delay notices, staff replies,
//                                              every minute
//   Everwake Clinic — Test Runner              chat with a clinic's assistant as a
//                                              pretend patient; nothing goes on WhatsApp
//
//   node build.mjs
//
// Optional environment:
//   EW_MODEL            OpenAI chat model           (default gpt-5.6-luna)
//   EW_PG_CRED_ID       n8n Postgres credential id  (default EVERWAKE_CLINIC_DB)
//   EW_OPENAI_CRED_ID   n8n OpenAI credential id
//   EW_BRAIN            'off' drops the planning Brain (the Agent then thinks for itself)
//   EW_AGENT_EFFORT     the Agent's reasoning effort (default low behind the Brain, medium alone)
//   EW_TRANSCRIBE_MODEL hears a voice note (default gpt-transcribe)
//   EW_VISION_MODEL     reads a photo or a PDF (default gpt-5-mini); EW_VISION_EFFORT its reasoning (default low)
//   EW_DASHBOARD_URL    the dashboard's address, for the hourly deletion of visit audio past its days
//                       (default http://localhost:3000)
//
// n8n-ids.json (optional): { "main": "…", "booking": "…", "staff": "…" } — the ids
// n8n gave the workflows, so the tool nodes and the Test Runner are linked after a re-import.
// =====================================================================
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(fileURLToPath(import.meta.url));
const IDS = existsSync(join(ROOT, 'n8n-ids.json')) ? JSON.parse(readFileSync(join(ROOT, 'n8n-ids.json'), 'utf8')) : {};
const WF = { main: 'Everwake Clinic — Main (Brain + Agent)', booking: 'Everwake Clinic — Tool: manage_booking',
             staff: 'Everwake Clinic — Tool: staff_action', outbox: 'Everwake Clinic — Outbox + Housekeeping',
             test: 'Everwake Clinic — Test Runner' };
const wfRef = (key) => {
  const id = IDS[key];
  return id ? { __rl: true, value: id, mode: 'list', cachedResultName: WF[key], cachedResultUrl: `/workflow/${id}` }
            : { __rl: true, value: 'SET_AFTER_IMPORT', mode: 'list', cachedResultName: WF[key] };
};
const MODEL = process.env.EW_MODEL || 'gpt-5.6-luna';
const USE_BRAIN = process.env.EW_BRAIN !== 'off';
const AGENT_EFFORT = process.env.EW_AGENT_EFFORT || (USE_BRAIN ? 'low' : 'medium');
const TRANSCRIBE_MODEL = process.env.EW_TRANSCRIBE_MODEL || 'gpt-transcribe';
const VISION_MODEL = process.env.EW_VISION_MODEL || 'gpt-5-mini';
const VISION_EFFORT = process.env.EW_VISION_EFFORT ?? 'low';
const DASHBOARD_URL = (process.env.EW_DASHBOARD_URL || 'http://localhost:3000').replace(/\/+$/, '');
const PG = { postgres: { id: process.env.EW_PG_CRED_ID || 'EVERWAKE_CLINIC_DB', name: 'Everwake Clinic DB' } };
const OPENAI = { openAiApi: { id: process.env.EW_OPENAI_CRED_ID || 'OPENAI', name: 'OpenAi account' } };
const OUTBOX_AUTH = { httpHeaderAuth: { id: 'EVERWAKE_CLINIC_OUTBOX', name: 'Everwake Clinic Outbox Secret' } };

// ---- sources -----------------------------------------------------------
export function expand(code) {
  return code.replace(/^\/\/ @include (\S+)\s*$/gm, (_, f) => readFileSync(join(ROOT, 'src', f), 'utf8').trim());
}
const src = (p) => expand(readFileSync(join(ROOT, 'src', p), 'utf8')).trim()
  .replace(/__TRANSCRIBE_MODEL__/g, TRANSCRIBE_MODEL).replace(/__VISION_MODEL__/g, VISION_MODEL)
  .replace(/__VISION_EFFORT__/g, VISION_EFFORT) + '\n';
const prompt = (p) => readFileSync(join(ROOT, 'prompts', p), 'utf8').trim();
const b64sql = (fn) => `select clinic.${fn}(convert_from(decode($1::text, 'base64'), 'UTF8')::jsonb) as r;`;

// ---- node builders ----------------------------------------------------------
function uuidOf(s) {
  const h = createHash('sha1').update(s).digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-5${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`;
}
class Workflow {
  constructor(name) { this.name = name; this.nodes = []; this.connections = {}; }
  add(node) {
    node.id = uuidOf(this.name + '::' + node.name);
    if (['n8n-nodes-base.webhook', 'n8n-nodes-base.wait', '@n8n/n8n-nodes-langchain.chatTrigger'].includes(node.type)) node.webhookId = uuidOf(this.name + '::hook::' + node.name);
    this.nodes.push(node);
    return node.name;
  }
  link(from, to, output = 0, type = 'main', input = 0) {
    const c = (this.connections[from] = this.connections[from] || {});
    const outs = (c[type] = c[type] || []);
    while (outs.length <= output) outs.push([]);
    outs[output].push({ node: to, type, index: input });
  }
  chain(...names) { for (let i = 0; i < names.length - 1; i++) this.link(names[i], names[i + 1]); }
  json() {
    return { name: this.name, nodes: this.nodes, pinData: {}, connections: this.connections, active: false,
             settings: { executionOrder: 'v1', binaryMode: 'separate' }, meta: { templateCredsSetupCompleted: false }, tags: [] };
  }
}
const sticky = (name, content, [x, y], width, height, color = 4) => ({
  name, type: 'n8n-nodes-base.stickyNote', typeVersion: 1, position: [x, y], parameters: { content, width, height, color } });
const code = (name, file, pos) => ({ name, type: 'n8n-nodes-base.code', typeVersion: 2, position: pos, parameters: { jsCode: src(file) } });
const pg = (name, query, params, pos, extra = {}) => ({
  name, type: 'n8n-nodes-base.postgres', typeVersion: 2.6, position: pos, credentials: PG,
  parameters: { operation: 'executeQuery', query, options: params ? { queryReplacement: params } : {} }, ...extra });
const iff = (name, expr, pos) => ({
  name, type: 'n8n-nodes-base.if', typeVersion: 2.3, position: pos,
  parameters: { conditions: { options: { caseSensitive: true, leftValue: '', typeValidation: 'loose', version: 3 },
                              conditions: [{ id: uuidOf(name + expr), leftValue: `={{ ${expr} }}`, rightValue: '',
                                             operator: { type: 'boolean', operation: 'true', singleValue: true } }],
                              combinator: 'and' }, looseTypeValidation: true, options: {} } });
const noop = (name, pos) => ({ name, type: 'n8n-nodes-base.noOp', typeVersion: 1, position: pos, parameters: {} });
const wait = (name, seconds, pos) => ({ name, type: 'n8n-nodes-base.wait', typeVersion: 1.1, position: pos, parameters: { amount: seconds } });
const evo = (name, path, body, pos, { timeout = 20000, retry = true } = {}) => ({
  name, type: 'n8n-nodes-base.httpRequest', typeVersion: 4.4, position: pos,
  parameters: { method: 'POST', url: `={{ $json.base_url }}/${path}/{{ $json.instance }}`, sendHeaders: true,
                headerParameters: { parameters: [{ name: 'apikey', value: '={{ $json.api_key }}' }] },
                sendBody: true, specifyBody: 'json', jsonBody: `={{ JSON.stringify(${body}) }}`,
                options: { response: { response: { fullResponse: true, neverError: true, responseFormat: 'json' } }, timeout } },
  ...(retry ? { retryOnFail: true, maxTries: 2, waitBetweenTries: 1500 } : {}),
  onError: 'continueRegularOutput', alwaysOutputData: true });
const model = (name, maxTokens, effort, timeout, pos) => ({
  name, type: '@n8n/n8n-nodes-langchain.lmChatOpenAi', typeVersion: 1.3, position: pos, credentials: OPENAI,
  parameters: { model: { __rl: true, value: MODEL, mode: 'list', cachedResultName: MODEL }, builtInTools: {},
                options: { maxTokens, reasoningEffort: effort, timeout, maxRetries: 1 } } });
const chainLlm = (name, textExpr, system, pos) => ({
  name, type: '@n8n/n8n-nodes-langchain.chainLlm', typeVersion: 1.5, position: pos, onError: 'continueRegularOutput',
  parameters: { promptType: 'define', text: textExpr, messages: { messageValues: [{ message: system }] } } });
const agentNode = (name, textExpr, system, pos) => ({
  name, type: '@n8n/n8n-nodes-langchain.agent', typeVersion: 3.1, position: pos, onError: 'continueRegularOutput',
  parameters: { promptType: 'define', text: textExpr, hasOutputParser: false,
                options: { systemMessage: system, maxIterations: 10, returnIntermediateSteps: true, enableStreaming: false } } });
// JSON-shaped tool inputs are typed 'any': a list typed into a "string" field made n8n refuse the call
const ANY = ['details', 'staff'];
const toolInputSchema = (ids) => ids.map(id => ({ id, displayName: id, required: false, defaultMatch: false, display: true,
                                                  canBeUsedToMatch: true, type: ANY.includes(id) ? 'any' : 'string' }));
const tool = (name, key, description, values, pos) => ({
  name, type: '@n8n/n8n-nodes-langchain.toolWorkflow', typeVersion: 2.2, position: pos, onError: 'continueRegularOutput',
  parameters: { description, workflowId: wfRef(key),
                workflowInputs: { mappingMode: 'defineBelow', value: values, matchingColumns: [], schema: toolInputSchema(Object.keys(values)),
                                  attemptToConvertTypes: false, convertFieldsToString: false } } });
const trigger = (name, inputs, pos) => ({
  name, type: 'n8n-nodes-base.executeWorkflowTrigger', typeVersion: 1.1, position: pos,
  parameters: { workflowInputs: { values: inputs.map(n => ANY.includes(n) ? { name: n, type: 'any' } : { name: n }) } } });
const sendNodes = (w, prefix, toExpr, [x, y]) => {
  w.add(evo(`${prefix}Send Text`, 'message/sendText', `{ number: ${toExpr}, text: $json.text, delay: $json.delay_ms, linkPreview: /https?:\\/\\//.test($json.text) }`, [x, y - 120]));
  w.add(evo(`${prefix}Send Location`, 'message/sendLocation',
            `{ number: ${toExpr}, name: $json.place || undefined, address: $json.address || undefined, latitude: $json.lat, longitude: $json.lng }`, [x, y]));
  w.add(evo(`${prefix}Send Media`, 'message/sendMedia',
            `{ number: ${toExpr}, mediatype: $json.kind === 'document' ? 'document' : 'image', mimetype: $json.mime, media: $json.media_url, fileName: $json.file_name, caption: $json.text || undefined, delay: $json.delay_ms }`,
            [x, y + 120], { timeout: 30000 }));
};

const I = "$('Intake').first().json.r";
const TEST = "$('Normalize Inbound').first().json.is_test === true";
const N = "$('Normalize Inbound').first().json";

// =========================================================================
// Main
// =========================================================================
function buildMain() {
  const w = new Workflow(WF.main);
  w.add(sticky('Sticky — Overview', [
    '## EVERWAKE CLINIC — one WhatsApp assistant for every clinic',
    '**Intake** finds the clinic from the Evolution instance (and its webhook token), the person from any identity (number or private id), and routes the message: **agent** (a patient) · **staff** (a team member\'s own number: the doctor\'s commands) · **human** (someone took over) · **paused** (the agent is OFF) · **not live** · **from the phone**.',
    'Photos, PDFs and voice notes are understood first (and a photo or a file is kept on the patient\'s record). **Build Brief** turns the clinic\'s rows into FACTS — dates and red flags are worked out in code. **Brain** plans; **Agent** runs manage_booking and writes; **Check Reply** enforces hard rails (no invented price or time, no false "booked", no dose, the emergency guidance first).',
    'Webhook: **POST /webhook/clinic-evo?token=<channel webhook token>** — Settings → WhatsApp in the dashboard shows the exact URL.'
  ].join('\n'), [-2400, 120], 2400, 330));
  w.add(sticky('Sticky — Setup', [
    '### After import',
    '1. Pick the **Everwake Clinic DB** Postgres credential on every Postgres node (Supabase: Settings → Database → connection string, port 5432).',
    '2. Pick your OpenAI credential on the model nodes and the two OpenAI HTTP nodes.',
    '3. Import the two tool workflows, then set them on **manage_booking** and **staff_action** (they show SET_AFTER_IMPORT).',
    '4. Activate. Nothing here is per clinic: a new clinic is rows in the database.'
  ].join('\n'), [-2400, 1100], 1100, 220, 3));

  w.add({ name: 'WA — Evolution Webhook', type: 'n8n-nodes-base.webhook', typeVersion: 2.1, position: [-2300, 600],
          parameters: { httpMethod: 'POST', path: 'clinic-evo', options: {} } });
  w.add({ name: 'Test Runner Call', type: 'n8n-nodes-base.executeWorkflowTrigger', typeVersion: 1.1, position: [-2300, 800],
          parameters: { inputSource: 'passthrough' }, notes: 'The Test Runner: a pretend chat, nothing is sent on WhatsApp.', notesInFlow: true });
  w.add(code('Normalize Inbound', 'main/normalize_inbound.js', [-2100, 600]));
  w.add(iff('Route: Actionable?', '!$json.is_ignorable', [-1900, 600]));
  w.add(noop('Exit: Ignored', [-1700, 820]));
  w.add(pg('Intake', b64sql('intake'), '={{ [ $json.b64_intake ] }}', [-1700, 560]));
  w.add(iff('Route: To The Assistant?', "$json.r.route === 'agent' || $json.r.route === 'staff'", [-1500, 560]));

  w.add(iff('Route: Apologise (Agent OFF)?', `$json.r.route === 'paused' && $json.r.send_apology === true && !${TEST}`, [-1300, 820]));
  w.add(code('Prepare Apology', 'main/prepare_apology.js', [-1100, 760]));
  w.add(evo('Evolution — Send Apology', 'message/sendText', '{ number: $json.reply_to, text: $json.text, delay: 800, linkPreview: false }', [-900, 760]));
  w.add(code('Record Apology', 'main/record_apology_send.js', [-700, 760]));
  w.add(pg('Log Apology', b64sql('log_outbound'), '={{ [ $json.b64_log ] }}', [-500, 760]));
  w.add(iff('Route: Typed On The Phone?', "$json.r.route === 'from_me'", [-1100, 980]));
  w.add(wait('Wait For Own Echo 5s', 5, [-900, 960]));
  w.add(pg('Log Phone Reply', b64sql('log_phone_reply'), `={{ [ ${N}.b64_intake ] }}`, [-700, 960]));
  w.add(noop('Exit: Not For The Assistant', [-900, 1160]));

  w.add({ ...evo('Send Typing Presence', 'chat/sendPresence', `{ number: ${I}.reply_to, delay: 30000, presence: 'composing' }`,
                 [-1300, 460], { timeout: 1000, retry: false }), notes: 'timeout 1s on purpose: we never wait for the typing indicator.', notesInFlow: true });
  const presence = w.nodes.find(n => n.name === 'Send Typing Presence');
  presence.parameters.url = `={{ ${I}.channel.base_url }}/chat/sendPresence/{{ ${I}.channel.instance }}`;
  presence.parameters.headerParameters.parameters[0].value = `={{ ${I}.channel.api_key }}`;
  w.add(iff('Route: Real Person?', `!${TEST}`, [-1400, 360]));

  // a photo, a PDF or a voice note: fetched and understood before the turn
  w.add(iff('Route: Photo, File Or Voice Note?', `!!${N}.media`, [-1300, 160]));
  w.add(iff('Route: Fetch The File?', `!${N}.media_b64`, [-1100, 0]));
  w.add(evo('Fetch Media (Evolution)', 'chat/getBase64FromMediaMessage', `{ message: { key: { id: ${N}.external_id } }, convertToMp4: false }`, [-900, -80], { timeout: 30000 }));
  const fetchNode = w.nodes.find(n => n.name === 'Fetch Media (Evolution)');
  fetchNode.parameters.url = `={{ ${I}.channel.base_url }}/chat/getBase64FromMediaMessage/{{ ${I}.channel.instance }}`;
  fetchNode.parameters.headerParameters.parameters[0].value = `={{ ${I}.channel.api_key }}`;
  w.add(code('Prepare Media', 'main/prepare_media.js', [-700, 0]));
  w.add(iff('Route: Voice Note?', "$json.ok && $json.kind === 'audio'", [-500, 0]));
  w.add(iff('Route: Photo Or File?', "$json.ok && ($json.kind === 'image' || $json.kind === 'document')", [-300, 120]));
  const PM = "$('Prepare Media').first().json";
  w.add({ name: 'Voice Note To File', type: 'n8n-nodes-base.convertToFile', typeVersion: 1.1, position: [-300, -120],
          parameters: { operation: 'toBinary', sourceProperty: 'b64', binaryPropertyName: 'data',
                        options: { fileName: `={{ ${PM}.file_name }}`, mimeType: `={{ ${PM}.mime }}` } },
          onError: 'continueRegularOutput', alwaysOutputData: true });
  w.add({ name: 'Transcribe Voice Note (OpenAI)', type: 'n8n-nodes-base.httpRequest', typeVersion: 4.4, position: [-100, -120], credentials: OPENAI,
          parameters: { method: 'POST', url: 'https://api.openai.com/v1/audio/transcriptions', authentication: 'predefinedCredentialType',
                        nodeCredentialType: 'openAiApi', sendBody: true, contentType: 'multipart-form-data',
                        bodyParameters: { parameters: [{ parameterType: 'formBinaryData', name: 'file', inputDataFieldName: 'data' },
                                                       { name: 'model', value: `={{ ${PM}.transcribe_model }}` },
                                                       { name: 'prompt', value: `={{ ${PM}.transcribe_prompt }}` }] },
                        options: { timeout: 60000, response: { response: { neverError: true, responseFormat: 'json' } } } },
          retryOnFail: true, maxTries: 2, waitBetweenTries: 1500, onError: 'continueRegularOutput', alwaysOutputData: true });
  w.add({ name: 'Read Photo Or File (OpenAI)', type: 'n8n-nodes-base.httpRequest', typeVersion: 4.4, position: [-100, 120], credentials: OPENAI,
          parameters: { method: 'POST', url: 'https://api.openai.com/v1/chat/completions', authentication: 'predefinedCredentialType',
                        nodeCredentialType: 'openAiApi', sendBody: true, specifyBody: 'json', jsonBody: '={{ JSON.stringify($json.vision_body) }}',
                        options: { timeout: 90000, response: { response: { neverError: true, responseFormat: 'json' } } } },
          retryOnFail: true, maxTries: 2, waitBetweenTries: 1500, onError: 'continueRegularOutput', alwaysOutputData: true });
  w.add(code('Media Understood', 'main/media_understood.js', [120, 0]));
  w.add(pg('Save What It Said', b64sql('media_understood'), '={{ [ $json.b64_media ] }}', [340, 0], { alwaysOutputData: true }));
  w.add(pg('Keep On The Record', "select case when $1::text = '' then null else clinic.save_document(convert_from(decode($1::text, 'base64'), 'UTF8')::jsonb) end as r;",
           "={{ [ $('Media Understood').first().json.b64_doc ] }}", [560, 0], { alwaysOutputData: true }));
  w.add(sticky('Sticky — Media', '### Photos, PDFs and voice notes\nUnderstood before the assistant answers: a voice note is transcribed (**' + TRANSCRIBE_MODEL + '**), a photo or a PDF read (**' + VISION_MODEL + '**) — lab values and prescriptions copied, never interpreted. A photo or a file is kept on the patient\'s record for the doctor.',
               [-1320, -300], 1900, 160, 5));

  w.add(wait('Debounce Wait 2s', 2, [-1100, 460]));
  w.add(pg('Claim Debounce Window', 'select clinic.claim_window($1::uuid, $2::text, $3::text, $4::bigint) as r;',
           `={{ [ ${I}.tenant_id, ${I}.wa_id, ${N}.run_id, String(${I}.buffer_id) ] }}`, [-900, 460], { alwaysOutputData: true }));
  w.add(iff('Route: Won The Window?', '$json.r.is_newest === true && $json.r.lock_acquired === true', [-700, 460]));
  w.add(iff('Route: Retry Or Exit?', '$json.r.is_newest === true && !$json.r.blocked_reason && $runIndex < 60', [-700, 680]));
  w.add(wait('Retry Backoff 3s', 3, [-480, 800]));
  w.add(noop('Exit: Superseded', [-480, 640]));
  w.add(iff('Route: A Team Member?', `${I}.route === 'staff'`, [-480, 460]));

  // the patient's turn
  w.add(pg('Load Turn Context', 'select clinic.turn_context($1::uuid, $2::text) as r;', `={{ [ ${I}.tenant_id, ${I}.wa_id ] }}`, [-260, 360]));
  w.add(code('Build Brief', 'main/build_brief.js', [-40, 360]));
  if (USE_BRAIN) {
    w.add(chainLlm('Brain', '={{ $json.brief }}', prompt('brain.md'), [180, 360]));
    w.add(model('Brain Model', 16000, 'high', 90000, [180, 600]));
  }
  w.add(code('Attach Plan', 'main/attach_plan.js', [420, 360]));
  w.add(agentNode('Agent', '={{ $json.agent_prompt }}', prompt('agent.md'), [640, 360]));
  w.add(model('Agent Model', 6000, AGENT_EFFORT, 90000, [560, 620]));
  w.add(tool('manage_booking', 'booking', prompt('tool_manage_booking.md'), {
    tenant_id: `={{ ${I}.tenant_id }}`,
    wa_id: `={{ ${I}.wa_id }}`,
    action: "={{ $fromAI('action', 'Exactly one of: find_slots, update, summary, book, confirm, accept_delay, reschedule, cancel, take_offer, accept_plan, next_plan_session, join_waitlist, status', 'string') }}",
    details: "={{ $fromAI('details', 'An object with only what is new, e.g. {\"service\":\"تنضيف\",\"date\":\"2026-11-11\",\"band\":\"evening\"} or {\"option\":2,\"full_name\":\"يوسف أحمد\",\"age\":\"6\",\"relation\":\"child\",\"reason\":\"كحة\"} or {\"ref_no\":\"NC-1042\"}. Dates come from FACTS. Leave it out for summary, book and status.', 'json', {\"none\":true}) }}"
  }, [760, 620]));
  w.add(pg('Read Back State', 'select clinic.read_back($1::uuid, $2::text) as r;', `={{ [ ${I}.tenant_id, ${I}.wa_id ] }}`, [860, 360]));
  w.add(code('Check Reply', 'main/check_reply.js', [1080, 360]));
  w.add(iff('Route: Needs Repair?', '$json.needs_rewrite', [1300, 360]));
  w.add(code('Repair Reply', 'main/repair_reply.js', [1520, 220]));
  w.add(code('Build Persist Payload', 'main/build_persist_payload.js', [1740, 360]));
  w.add(pg('Persist Turn + Unlock', b64sql('persist_turn'), '={{ [ $json.b64_persist ] }}', [1960, 360]));
  w.add(code('Prepare Outbound Messages', 'main/prepare_outbound.js', [2180, 360]));

  // a team member's turn (their own number)
  w.add(pg('Load Staff Context', 'select clinic.staff_context($1::uuid, $2::text, $3::jsonb) as r;',
           `={{ [ ${I}.tenant_id, ${I}.wa_id, JSON.stringify(${I}.staff || {}) ] }}`, [-260, 760]));
  w.add(code('Build Staff Brief', 'staff/build_staff_brief.js', [-40, 760]));
  w.add(agentNode('Staff Assistant', '={{ $json.staff_prompt }}', prompt('staff.md'), [180, 760]));
  w.add(model('Staff Model', 3000, 'low', 60000, [120, 980]));
  w.add(tool('staff_action', 'staff', prompt('tool_staff_action.md'), {
    tenant_id: `={{ ${I}.tenant_id }}`,
    wa_id: `={{ ${I}.wa_id }}`,
    staff: `={{ JSON.stringify(${I}.staff || {}) }}`,
    action: "={{ $fromAI('action', 'Exactly one of: today, delay, cancel_session, block_time, catalog, confirm, discard, undo, patient', 'string') }}",
    details: "={{ $fromAI('details', 'An object, e.g. {\"minutes\":20} or {\"date\":\"2026-11-12\"} or {\"changes\":[{\"op\":\"set_price\",\"service\":\"تنضيف\",\"price\":700}]}. Leave it out for confirm, discard and undo.', 'json', {\"none\":true}) }}"
  }, [300, 980]));
  w.add(code('Check Staff Reply', 'staff/check_staff_reply.js', [420, 760]));
  w.add(code('Build Staff Persist', 'staff/build_staff_persist.js', [640, 760]));
  w.add(pg('Persist Staff Turn', b64sql('persist_turn'), '={{ [ $json.b64_persist ] }}', [860, 760]));
  w.add(code('Prepare Staff Outbound', 'staff/prepare_staff_outbound.js', [1080, 760]));

  // sending, for both
  w.add({ name: 'Outbound Loop', type: 'n8n-nodes-base.splitInBatches', typeVersion: 3, position: [2400, 360], parameters: { options: { reset: false } } });
  w.add(noop('Turn Complete', [2620, 160]));
  w.add(iff('Route: Test Chat?', TEST, [2620, 560]));
  w.add(code('Pretend Send (test)', 'main/pretend_send.js', [2840, 700]));
  w.add(iff('Route: Text?', "$json.kind === 'text'", [2620, 360]));
  w.add(iff('Route: Location?', "$json.kind === 'location'", [2840, 460]));
  sendNodes(w, 'Evolution — ', '$json.reply_to', [3060, 420]);
  w.add(code('Record Send', 'main/record_reply_send.js', [3300, 400]));
  w.add(pg('Log Outbound', b64sql('log_outbound'), '={{ [ $json.b64_log ] }}', [3520, 400]));

  w.chain('WA — Evolution Webhook', 'Normalize Inbound', 'Route: Actionable?');
  w.link('Test Runner Call', 'Normalize Inbound');
  w.link('Route: Actionable?', 'Intake', 0); w.link('Route: Actionable?', 'Exit: Ignored', 1);
  w.chain('Intake', 'Route: To The Assistant?');
  w.link('Route: To The Assistant?', 'Route: Real Person?', 0); w.link('Route: To The Assistant?', 'Route: Apologise (Agent OFF)?', 1);
  w.link('Route: Real Person?', 'Send Typing Presence', 0); w.link('Route: Real Person?', 'Debounce Wait 2s', 1);
  w.link('Route: Apologise (Agent OFF)?', 'Prepare Apology', 0); w.link('Route: Apologise (Agent OFF)?', 'Route: Typed On The Phone?', 1);
  w.chain('Prepare Apology', 'Evolution — Send Apology', 'Record Apology', 'Log Apology');
  w.link('Route: Typed On The Phone?', 'Wait For Own Echo 5s', 0); w.link('Route: Typed On The Phone?', 'Exit: Not For The Assistant', 1);
  w.chain('Wait For Own Echo 5s', 'Log Phone Reply');
  w.chain('Send Typing Presence', 'Route: Photo, File Or Voice Note?');
  w.link('Route: Photo, File Or Voice Note?', 'Route: Fetch The File?', 0); w.link('Route: Photo, File Or Voice Note?', 'Debounce Wait 2s', 1);
  w.link('Route: Fetch The File?', 'Fetch Media (Evolution)', 0); w.link('Route: Fetch The File?', 'Prepare Media', 1);
  w.chain('Fetch Media (Evolution)', 'Prepare Media', 'Route: Voice Note?');
  w.link('Route: Voice Note?', 'Voice Note To File', 0); w.link('Route: Voice Note?', 'Route: Photo Or File?', 1);
  w.chain('Voice Note To File', 'Transcribe Voice Note (OpenAI)', 'Media Understood');
  w.link('Route: Photo Or File?', 'Read Photo Or File (OpenAI)', 0); w.link('Route: Photo Or File?', 'Media Understood', 1);
  w.chain('Read Photo Or File (OpenAI)', 'Media Understood', 'Save What It Said', 'Keep On The Record', 'Debounce Wait 2s');
  w.chain('Debounce Wait 2s', 'Claim Debounce Window', 'Route: Won The Window?');
  w.link('Route: Won The Window?', 'Route: A Team Member?', 0); w.link('Route: Won The Window?', 'Route: Retry Or Exit?', 1);
  w.link('Route: Retry Or Exit?', 'Retry Backoff 3s', 0); w.link('Route: Retry Or Exit?', 'Exit: Superseded', 1);
  w.chain('Retry Backoff 3s', 'Claim Debounce Window');
  w.link('Route: A Team Member?', 'Load Staff Context', 0); w.link('Route: A Team Member?', 'Load Turn Context', 1);
  if (USE_BRAIN) {
    w.chain('Load Turn Context', 'Build Brief', 'Brain', 'Attach Plan', 'Agent', 'Read Back State', 'Check Reply', 'Route: Needs Repair?');
    w.link('Brain Model', 'Brain', 0, 'ai_languageModel');
  } else {
    w.chain('Load Turn Context', 'Build Brief', 'Attach Plan', 'Agent', 'Read Back State', 'Check Reply', 'Route: Needs Repair?');
  }
  w.link('Agent Model', 'Agent', 0, 'ai_languageModel');
  w.link('manage_booking', 'Agent', 0, 'ai_tool');
  w.link('Route: Needs Repair?', 'Repair Reply', 0); w.link('Route: Needs Repair?', 'Build Persist Payload', 1);
  w.chain('Repair Reply', 'Build Persist Payload');
  w.chain('Build Persist Payload', 'Persist Turn + Unlock', 'Prepare Outbound Messages', 'Outbound Loop');
  w.chain('Load Staff Context', 'Build Staff Brief', 'Staff Assistant', 'Check Staff Reply', 'Build Staff Persist', 'Persist Staff Turn',
          'Prepare Staff Outbound', 'Outbound Loop');
  w.link('Staff Model', 'Staff Assistant', 0, 'ai_languageModel');
  w.link('staff_action', 'Staff Assistant', 0, 'ai_tool');
  w.link('Outbound Loop', 'Turn Complete', 0); w.link('Outbound Loop', 'Route: Test Chat?', 1);
  w.link('Route: Test Chat?', 'Pretend Send (test)', 0); w.link('Route: Test Chat?', 'Route: Text?', 1);
  w.chain('Pretend Send (test)', 'Record Send');
  w.link('Route: Text?', 'Evolution — Send Text', 0); w.link('Route: Text?', 'Route: Location?', 1);
  w.link('Route: Location?', 'Evolution — Send Location', 0); w.link('Route: Location?', 'Evolution — Send Media', 1);
  for (const s of ['Evolution — Send Text', 'Evolution — Send Location', 'Evolution — Send Media']) w.link(s, 'Record Send');
  w.chain('Record Send', 'Log Outbound', 'Outbound Loop');
  return w;
}

// =========================================================================
// Tools
// =========================================================================
function buildBooking() {
  const w = new Workflow(WF.booking);
  w.add(sticky('Sticky — manage_booking', [
    '## Everwake Clinic · manage_booking',
    'Called BY THE AGENT. Free times come only from the database (`available_slots`: schedules, days off, delays, chairs, the doctors\' rules); a chosen time is held for a few minutes; a booking needs the summary the patient said yes to.',
    '**actions** find_slots · update · summary · book · confirm · accept_delay · reschedule · cancel · take_offer · accept_plan · next_plan_session · join_waitlist · status'
  ].join('\n'), [0, 0], 1200, 200, 5));
  w.add(trigger('Tool Called By Agent', ['tenant_id', 'wa_id', 'action', 'details'], [0, 320]));
  w.add(code('Read Args', 'booking/read_args.js', [220, 320]));
  w.add(pg('Booking', "select clinic.booking_tool($1::uuid, $2::text, $3::text, convert_from(decode($4::text, 'base64'), 'UTF8')) as r;",
           '={{ [ $json.tenant_id, $json.wa_id, $json.action, $json.details_b64 ] }}', [440, 320]));
  w.add(code('Return To Agent', 'booking/return_to_agent.js', [660, 320]));
  w.chain('Tool Called By Agent', 'Read Args', 'Booking', 'Return To Agent');
  return w;
}

function buildStaff() {
  const w = new Workflow(WF.staff);
  w.add(sticky('Sticky — staff_action', [
    '## Everwake Clinic · staff_action',
    'Called BY THE STAFF ASSISTANT for a team member writing from their own number: today\'s list, "I\'m 20 minutes late", a cancelled session, time off, and changes to prices, services, offers, answers and rules. Everything is a PREVIEW first; **confirm** does it.'
  ].join('\n'), [0, 0], 1200, 160, 5));
  w.add(trigger('Tool Called By Staff Assistant', ['tenant_id', 'wa_id', 'staff', 'action', 'details'], [0, 320]));
  w.add(code('Read Args', 'staff/read_args.js', [220, 320]));
  w.add(pg('Staff Action', 'select clinic.staff_tool($1::uuid, $2::text, $3::jsonb, $4::text, $5::text) as r;',
           '={{ [ $json.tenant_id, $json.wa_id, $json.staff_json, $json.action, $json.details_json ] }}', [440, 320]));
  w.add(code('Return To Agent', 'staff/return_to_agent.js', [660, 320]));
  w.chain('Tool Called By Staff Assistant', 'Read Args', 'Staff Action', 'Return To Agent');
  return w;
}

// =========================================================================
// Outbox + housekeeping
// =========================================================================
function buildOutbox() {
  const w = new Workflow(WF.outbox);
  w.add(sticky('Sticky — Outbox', [
    '## Everwake Clinic · Outbox',
    'Everything the clinic sends that is not the assistant\'s own reply — reminders, "the doctor is running late", cancelled sessions with new times, the front desk\'s replies, aftercare, emergencies to the doctor\'s own number — is written to `clinic.outbox` first, so nothing is lost while WhatsApp or n8n is down.',
    'Runs **every minute** (housekeeping: reminders due, delay follow-ups, holds that lapsed, no-shows, idle takeovers) and **immediately** when the dashboard pings **POST /webhook/clinic-outbox** (header auth: *Everwake Clinic Outbox Secret* = the dashboard\'s N8N_OUTBOX_SECRET).',
    'A failed send retries 3 times, 30 s apart, then shows as failed in the dashboard with the reason.',
    '**Every hour** it asks the dashboard to delete visit recordings whose audio is past the clinic\'s days (Settings → Listening to the visit; 30 by default). The transcript and the signed note stay.'
  ].join('\n'), [0, 0], 1400, 260, 5));
  w.add({ name: 'Every Minute', type: 'n8n-nodes-base.scheduleTrigger', typeVersion: 1.2, position: [0, 340],
          parameters: { rule: { interval: [{ field: 'minutes', minutesInterval: 1 }] } } });
  w.add({ name: 'Ping From Dashboard', type: 'n8n-nodes-base.webhook', typeVersion: 2.1, position: [0, 560],
          parameters: { httpMethod: 'POST', path: 'clinic-outbox', authentication: 'headerAuth', options: {} }, credentials: OUTBOX_AUTH });
  w.add(pg('Housekeeping', 'select clinic.housekeeping() as r;', null, [220, 340]));
  w.add({ name: 'Every Hour', type: 'n8n-nodes-base.scheduleTrigger', typeVersion: 1.2, position: [0, 800],
          parameters: { rule: { interval: [{ field: 'hours', hoursInterval: 1 }] } } });
  w.add({ name: 'Delete Old Visit Audio', type: 'n8n-nodes-base.httpRequest', typeVersion: 4.4, position: [220, 800], credentials: OUTBOX_AUTH,
          parameters: { method: 'POST', url: `${DASHBOARD_URL}/api/scribe/retention`, authentication: 'genericCredentialType', genericAuthType: 'httpHeaderAuth',
                        options: { response: { response: { neverError: true, responseFormat: 'json' } }, timeout: 60000 } },
          onError: 'continueRegularOutput', alwaysOutputData: true });
  w.add(pg('Claim Batch', "select clinic.outbox_claim(25, 'n8n') as r;", null, [440, 460]));
  w.add(code('One Item Per Message', 'outbox/split_batch.js', [660, 460]));
  w.add({ name: 'Send Loop', type: 'n8n-nodes-base.splitInBatches', typeVersion: 3, position: [880, 460], parameters: { options: { reset: false } } });
  w.add(noop('Done', [1100, 300]));
  w.add(iff('Route: Text?', "$json.kind === 'text'", [1100, 500]));
  w.add(iff('Route: Location?', "$json.kind === 'location'", [1320, 600]));
  sendNodes(w, 'Evolution — ', '$json.to', [1540, 560]);
  for (const n of w.nodes.filter(n => n.name.startsWith('Evolution — Send'))) { delete n.retryOnFail; delete n.maxTries; delete n.waitBetweenTries; }
  w.add(code('Record Result', 'outbox/record_result.js', [1760, 500]));
  w.add(pg('Save Result', b64sql('outbox_result'), '={{ [ $json.b64_result ] }}', [1980, 500]));
  w.chain('Every Minute', 'Housekeeping', 'Claim Batch');
  w.link('Ping From Dashboard', 'Claim Batch');
  w.link('Every Hour', 'Delete Old Visit Audio');
  w.chain('Claim Batch', 'One Item Per Message', 'Send Loop');
  w.link('Send Loop', 'Done', 0); w.link('Send Loop', 'Route: Text?', 1);
  w.link('Route: Text?', 'Evolution — Send Text', 0); w.link('Route: Text?', 'Route: Location?', 1);
  w.link('Route: Location?', 'Evolution — Send Location', 0); w.link('Route: Location?', 'Evolution — Send Media', 1);
  for (const s of ['Evolution — Send Text', 'Evolution — Send Location', 'Evolution — Send Media']) w.link(s, 'Record Result');
  w.chain('Record Result', 'Save Result', 'Send Loop');
  return w;
}

// =========================================================================
// Test Runner
// =========================================================================
function buildTestRunner() {
  const w = new Workflow(WF.test);
  w.add(sticky('Sticky — Test Runner', [
    '## Everwake Clinic · Test Runner — chat with a clinic\'s assistant, nothing goes on WhatsApp',
    'Open the chat and write as a patient. The real **Main** workflow answers from a pretend number (200000000001): you test exactly what patients get, the replies are only recorded, and it works while the clinic is still onboarding.',
    '**/reset** a brand-new patient · **/last** the latest turn again · **/later 5 <message>** 5 hours pass first · **#2 <message>** a second pretend patient · **@slug <message>** another clinic.',
    'The clinic to test is set at the top of **Read Test Command** (nile_clinics).'
  ].join('\n'), [-300, -380], 1500, 300, 6));
  w.add({ name: 'Chat With The Assistant (test)', type: '@n8n/n8n-nodes-langchain.chatTrigger', typeVersion: 1.1, position: [-260, 0], parameters: { options: {} } });
  w.add(code('Read Test Command', 'test_runner/read_command.js', [-40, 0]));
  w.add(pg('Prepare Test Chat', 'select clinic.test_chat_prepare($1::text, $2::text, $3::boolean, $4::numeric) as r;',
           '={{ [ $json.clinic, $json.wa_id, $json.reset, $json.later_hours ] }}', [180, 0]));
  w.add(iff('Route: A Message To Send?', "!$('Read Test Command').first().json.reset && !$('Read Test Command').first().json.last && !$('Read Test Command').first().json.empty", [400, 0]));
  w.add(iff('Route: Show The Last Turn?', "$('Read Test Command').first().json.last === true", [620, 140]));
  w.add(code('Fake WhatsApp Message', 'test_runner/fake_message.js', [620, -100]));
  w.add({ name: 'Run The Assistant (Main)', type: 'n8n-nodes-base.executeWorkflow', typeVersion: 1.2, position: [840, -100],
          parameters: { workflowId: wfRef('main'), workflowInputs: { mappingMode: 'defineBelow', value: {}, matchingColumns: [], schema: [],
                                                                     attemptToConvertTypes: false, convertFieldsToString: true },
                        options: { waitForSubWorkflow: true } }, alwaysOutputData: true, onError: 'continueRegularOutput' });
  w.add(pg('Load The Reply', 'select clinic.test_chat_result($1::uuid, $2::text, $3::timestamptz) as r;',
           "={{ [ $('Prepare Test Chat').first().json.r.tenant_id, $('Prepare Test Chat').first().json.r.wa_id, $('Read Test Command').first().json.last ? ($('Prepare Test Chat').first().json.r.last_message_at || $('Prepare Test Chat').first().json.r.since) : $('Prepare Test Chat').first().json.r.since ] }}",
           [1060, -100], { executeOnce: true }));
  w.add(code('Format Test Result', 'test_runner/format_result.js', [1280, 0]));
  w.chain('Chat With The Assistant (test)', 'Read Test Command', 'Prepare Test Chat', 'Route: A Message To Send?');
  w.link('Route: A Message To Send?', 'Fake WhatsApp Message', 0); w.link('Route: A Message To Send?', 'Route: Show The Last Turn?', 1);
  w.link('Route: Show The Last Turn?', 'Load The Reply', 0); w.link('Route: Show The Last Turn?', 'Format Test Result', 1);
  w.chain('Fake WhatsApp Message', 'Run The Assistant (Main)', 'Load The Reply', 'Format Test Result');
  return w;
}

export const workflows = { main: buildMain, booking: buildBooking, staff: buildStaff, outbox: buildOutbox, test: buildTestRunner };

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  mkdirSync(join(ROOT, 'dist'), { recursive: true });
  const files = { main: 'clinic-main.json', booking: 'clinic-tool-manage-booking.json', staff: 'clinic-tool-staff-action.json',
                  outbox: 'clinic-outbox.json', test: 'clinic-test-runner.json' };
  for (const [k, build] of Object.entries(workflows)) {
    const w = build();
    const names = new Set(w.nodes.map(n => n.name));
    if (names.size !== w.nodes.length) throw new Error(`${w.name}: two nodes share a name`);
    for (const [from, types] of Object.entries(w.connections)) {
      if (!names.has(from)) throw new Error(`${w.name}: connection from unknown node ${from}`);
      for (const outs of Object.values(types)) for (const out of outs) for (const c of out)
        if (!names.has(c.node)) throw new Error(`${w.name}: ${from} → unknown node ${c.node}`);
    }
    for (const n of w.nodes) JSON.stringify(n.parameters || {}, (key, v) => {
      if (typeof v === 'string' && v.includes('$fromAI(') && v.slice(v.indexOf('$fromAI('), v.trimEnd().length - 2).includes('}}'))
        throw new Error(`${w.name} · ${n.name} · ${key}: "}}" inside an expression`);
      return v;
    });
    // every Code node must at least parse
    for (const n of w.nodes.filter(n => n.type === 'n8n-nodes-base.code')) {
      try { new Function('$input', '$', '$runIndex', 'Buffer', `return (async () => {\n${n.parameters.jsCode}\n})()`); }
      catch (e) { throw new Error(`${w.name} · ${n.name}: ${e.message}`); }
    }
    writeFileSync(join(ROOT, 'dist', files[k]), JSON.stringify(w.json(), null, 2) + '\n');
    console.log(`${files[k].padEnd(36)} ${w.nodes.length} nodes`);
  }
}
