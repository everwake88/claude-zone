#!/usr/bin/env node
// =====================================================================
// Everwake Orders · engine builder
//
// The engine's code lives in src/ (one file per n8n Code node) and its
// prompts in prompts/. This script assembles them into six workflows
// you import into n8n (dist/*.json):
//
//   Everwake — Main (Brain + Agent)            the WhatsApp webhook, every restaurant
//   Everwake — Tool: manage_cart               called by the Agent
//   Everwake — Tool: save_customer_details     called by the Agent
//   Everwake — Tool: manage_reservation        called by the Agent (table bookings)
//   Everwake — Outbox + Housekeeping           staff replies, status messages,
//                                              "we're back", every minute
//   Everwake — Test Runner                     chat with an agent as a pretend
//                                              customer; nothing goes on WhatsApp
//
//   node build.mjs
//
// Optional environment:
//   EW_MODEL            OpenAI chat model           (default gpt-5.6-luna)
//   EW_PG_CRED_ID       n8n Postgres credential id  (default EVERWAKE_DB)
//   EW_OPENAI_CRED_ID   n8n OpenAI credential id    (default the Seagull one)
//   EW_GEOCODE_URL      Google reverse-geocoder (Apps Script) URL
//
// n8n-ids.json (optional) holds the ids n8n gave the workflows, so the
// tool nodes and the Test Runner are linked already after a re-import:
//   { "main": "…", "cart": "…", "details": "…", "reservation": "…" }
// (the id is in the workflow's address: …/workflow/<id>)
// =====================================================================
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(fileURLToPath(import.meta.url));
const IDS = existsSync(join(ROOT, 'n8n-ids.json')) ? JSON.parse(readFileSync(join(ROOT, 'n8n-ids.json'), 'utf8')) : {};
const WF_KEY = { 'Everwake — Main (Brain + Agent)': 'main', 'Everwake — Tool: manage_cart': 'cart',
                 'Everwake — Tool: save_customer_details': 'details', 'Everwake — Tool: manage_reservation': 'reservation' };
const wfRef = (workflowName) => {
  const id = IDS[WF_KEY[workflowName]];
  return id ? { __rl: true, value: id, mode: 'list', cachedResultName: workflowName, cachedResultUrl: `/workflow/${id}` }
            : { __rl: true, value: 'SET_AFTER_IMPORT', mode: 'list', cachedResultName: workflowName };
};
const MODEL = process.env.EW_MODEL || 'gpt-5.6-luna';
const PG = { postgres: { id: process.env.EW_PG_CRED_ID || 'EVERWAKE_DB', name: 'Everwake DB' } };
const OPENAI = { openAiApi: { id: process.env.EW_OPENAI_CRED_ID || 'CkjJoUDZ38ndmkPM', name: 'OpenAi account' } };
const GEOCODE_URL = process.env.EW_GEOCODE_URL
  || 'https://script.google.com/macros/s/AKfycbz50Sz7MYH7bCF8QQMA1geEXTNzPHqs-nek44lbeuprBt8ThuUwS5APij9lONqo22G-iA/exec';

// ---- sources -----------------------------------------------------------
export function expand(code) {
  return code.replace(/^\/\/ @include (\S+)\s*$/gm, (_, f) => readFileSync(join(ROOT, 'src', f), 'utf8').trim());
}
const src = (p) => expand(readFileSync(join(ROOT, 'src', p), 'utf8')).trim() + '\n';
const prompt = (p) => readFileSync(join(ROOT, 'prompts', p), 'utf8').trim();
const b64sql = (fn) => `select everwake.${fn}(convert_from(decode($1::text, 'base64'), 'UTF8')::jsonb) as r;`;

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
const code = (name, file, pos) => ({
  name, type: 'n8n-nodes-base.code', typeVersion: 2, position: pos, parameters: { jsCode: src(file) } });
const pg = (name, query, params, pos, extra = {}) => ({
  name, type: 'n8n-nodes-base.postgres', typeVersion: 2.6, position: pos, credentials: PG,
  parameters: { operation: 'executeQuery', query, options: params ? { queryReplacement: params } : {} }, ...extra });
const iff = (name, expr, pos) => ({
  name, type: 'n8n-nodes-base.if', typeVersion: 2.3, position: pos,
  parameters: {
    conditions: {
      options: { caseSensitive: true, leftValue: '', typeValidation: 'loose', version: 3 },
      conditions: [{ id: uuidOf(name + expr), leftValue: `={{ ${expr} }}`, rightValue: '',
                     operator: { type: 'boolean', operation: 'true', singleValue: true } }],
      combinator: 'and'
    },
    looseTypeValidation: true, options: {}
  } });
const noop = (name, pos) => ({ name, type: 'n8n-nodes-base.noOp', typeVersion: 1, position: pos, parameters: {} });
const wait = (name, seconds, pos) => ({ name, type: 'n8n-nodes-base.wait', typeVersion: 1.1, position: pos, parameters: { amount: seconds } });
const evo = (name, path, body, pos, { timeout = 20000, retry = true } = {}) => ({
  name, type: 'n8n-nodes-base.httpRequest', typeVersion: 4.4, position: pos,
  parameters: {
    method: 'POST',
    url: `={{ $json.base_url }}/${path}/{{ $json.instance }}`,
    sendHeaders: true,
    headerParameters: { parameters: [{ name: 'apikey', value: '={{ $json.api_key }}' }] },
    sendBody: true, specifyBody: 'json', jsonBody: `={{ JSON.stringify(${body}) }}`,
    options: { response: { response: { fullResponse: true, neverError: true, responseFormat: 'json' } }, timeout }
  },
  ...(retry ? { retryOnFail: true, maxTries: 2, waitBetweenTries: 1500 } : {}),
  onError: 'continueRegularOutput', alwaysOutputData: true });
const model = (name, maxTokens, effort, timeout, pos) => ({
  name, type: '@n8n/n8n-nodes-langchain.lmChatOpenAi', typeVersion: 1.3, position: pos, credentials: OPENAI,
  parameters: { model: { __rl: true, value: MODEL, mode: 'list', cachedResultName: MODEL }, builtInTools: {},
                options: { maxTokens, reasoningEffort: effort, timeout, maxRetries: 1 } } });
const chain = (name, textExpr, system, pos) => ({
  name, type: '@n8n/n8n-nodes-langchain.chainLlm', typeVersion: 1.5, position: pos, onError: 'continueRegularOutput',
  parameters: { promptType: 'define', text: textExpr, messages: { messageValues: [{ message: system }] } } });
// the agent fills one JSON object per call ($fromAI type json): a list
// typed into a "string" field made n8n refuse the call and stop the turn
const ANY = ['request', 'details'];
const toolInputSchema = (ids) => ids.map(id => ({ id, displayName: id, required: false, defaultMatch: false, display: true,
                                                  canBeUsedToMatch: true, type: ANY.includes(id) ? 'any' : 'string' }));
const tool = (name, workflowName, description, values, pos) => ({
  name, type: '@n8n/n8n-nodes-langchain.toolWorkflow', typeVersion: 2.2, position: pos,
  parameters: {
    description,
    workflowId: wfRef(workflowName),
    workflowInputs: { mappingMode: 'defineBelow', value: values, matchingColumns: [], schema: toolInputSchema(Object.keys(values)),
                      attemptToConvertTypes: false, convertFieldsToString: false }
  } });
const trigger = (name, inputs, pos) => ({
  name, type: 'n8n-nodes-base.executeWorkflowTrigger', typeVersion: 1.1, position: pos,
  parameters: { workflowInputs: { values: inputs.map(n => ANY.includes(n) ? { name: n, type: 'any' } : { name: n }) } } });

const I = "$('Intake').first().json.r";
const TEST = "$('Normalize Inbound').first().json.is_test === true";

// =========================================================================
// Main
// =========================================================================
function buildMain() {
  const w = new Workflow('Everwake — Main (Brain + Agent)');
  w.add(sticky('Sticky — Overview', [
    '## EVERWAKE — one WhatsApp ordering engine for every restaurant',
    'The Seagull pipeline, multi-restaurant. **Intake** finds the restaurant from the Evolution instance (and its webhook token), the customer from any identity (number or private id), and routes the message: **agent** · **human** (a person took over — the inbox shows it) · **paused** (the agent is OFF: one warm apology, remembered for "we\'re back") · **not live** (still onboarding: only test numbers) · **from the phone** (logged so the agent sees what staff wrote).',
    '**Build Brief** turns the restaurant\'s rows into FACTS only. **Brain** (high reasoning) plans; **Agent** (low reasoning) runs the tools and writes; **Check Reply** enforces hard rails; one **Rewrite** if needed. Pictures (menu pages, dish photos) go before the text.',
    'Webhook: **POST /webhook/everwake-evo?token=<channel webhook token>** — set it on every Evolution instance (Settings → WhatsApp in the dashboard shows the exact URL).'
  ].join('\n'), [-2400, 120], 2400, 330));
  w.add(sticky('Sticky — Setup', [
    '### After import',
    '1. Pick the **Everwake DB** Postgres credential on every Postgres node (Supabase: Settings → Database → connection string, port 5432).',
    '2. Pick your OpenAI credential on Brain Model, Agent Model and Rewrite Model.',
    '3. Import the three tool workflows, then set them on **manage_cart**, **save_customer_details** and **manage_reservation** (they show SET_AFTER_IMPORT).',
    '4. In **Everwake — Tool: manage_cart**, pick the *Everwake Outbox Secret* credential on **Create Payment Link** (it asks the dashboard for Paymob payment links).',
    '5. Activate. Nothing here is per restaurant: a new restaurant is a row in the database.'
  ].join('\n'), [-2400, 1000], 1100, 260, 3));

  w.add({ name: 'WA — Evolution Webhook', type: 'n8n-nodes-base.webhook', typeVersion: 2.1, position: [-2300, 600],
          parameters: { httpMethod: 'POST', path: 'everwake-evo', options: {} } });
  w.add({ name: 'Test Runner Call', type: 'n8n-nodes-base.executeWorkflowTrigger', typeVersion: 1.1, position: [-2300, 800],
          parameters: { inputSource: 'passthrough' },
          notes: 'The Test Runner workflow: a pretend chat, nothing is sent on WhatsApp.', notesInFlow: true });
  w.add(code('Normalize Inbound', 'main/normalize_inbound.js', [-2100, 600]));
  w.add(iff('Route: Actionable?', '!$json.is_ignorable', [-1900, 600]));
  w.add(noop('Exit: Ignored', [-1700, 820]));
  w.add(pg('Intake', b64sql('intake'), '={{ [ $json.b64_intake ] }}', [-1700, 560]));
  w.add(iff('Route: To The Agent?', "$json.r.route === 'agent'", [-1500, 560]));

  // not for the agent: the OFF switch, a phone reply, or nothing to do
  w.add(iff('Route: Apologise (Agent OFF)?', `$json.r.route === 'paused' && $json.r.send_apology === true && !${TEST}`, [-1300, 820]));
  w.add(code('Prepare Apology', 'main/prepare_apology.js', [-1100, 760]));
  w.add(evo('Evolution — Send Apology', 'message/sendText', '{ number: $json.reply_to, text: $json.text, delay: 800, linkPreview: false }', [-900, 760]));
  w.add(code('Record Apology', 'main/record_apology_send.js', [-700, 760]));
  w.add(pg('Log Apology', b64sql('log_outbound'), '={{ [ $json.b64_log ] }}', [-500, 760]));
  w.add(iff('Route: Typed On The Phone?', "$json.r.route === 'from_me'", [-1100, 980]));
  w.add(wait('Wait For Own Echo 5s', 5, [-900, 960]));
  w.add(pg('Log Phone Reply', b64sql('log_phone_reply'), "={{ [ $('Normalize Inbound').first().json.b64_intake ] }}", [-700, 960]));
  w.add(noop('Exit: Not For The Agent', [-900, 1160]));

  // the agent path
  w.add({ ...evo('Send Typing Presence', 'chat/sendPresence', `{ number: ${I}.reply_to, delay: 30000, presence: 'composing' }`,
                 [-1300, 460], { timeout: 1000, retry: false }),
          notes: 'timeout 1s on purpose: we never wait for the typing indicator.', notesInFlow: true });
  // the presence call reads the channel from Intake, not from $json
  const presence = w.nodes.find(n => n.name === 'Send Typing Presence');
  presence.parameters.url = `={{ ${I}.channel.base_url }}/chat/sendPresence/{{ ${I}.channel.instance }}`;
  presence.parameters.headerParameters.parameters[0].value = `={{ ${I}.channel.api_key }}`;
  w.add(iff('Route: Real Customer?', `!${TEST}`, [-1400, 360]));
  w.add(wait('Debounce Wait 6s', 6, [-1100, 460]));
  w.add(pg('Claim Debounce Window', 'select everwake.claim_window($1::uuid, $2::text, $3::text, $4::bigint) as r;',
           `={{ [ ${I}.tenant_id, ${I}.wa_id, $('Normalize Inbound').first().json.run_id, String(${I}.buffer_id) ] }}`,
           [-900, 460], { alwaysOutputData: true }));
  w.add(iff('Route: Won The Window?', '$json.r.is_newest === true && $json.r.lock_acquired === true', [-700, 460]));
  w.add(iff('Route: Retry Or Exit?', '$json.r.is_newest === true && !$json.r.blocked_reason && $runIndex < 8', [-700, 680]));
  w.add(wait('Retry Backoff 3s', 3, [-480, 800]));
  w.add(noop('Exit: Superseded', [-480, 640]));

  w.add(iff('Route: Has Location?', '$json.r.has_location === true', [-480, 460]));
  w.add({ name: 'Reverse Geocode (Google)', type: 'n8n-nodes-base.httpRequest', typeVersion: 4.4, position: [-260, 200],
          parameters: { url: GEOCODE_URL, sendQuery: true, specifyQuery: 'json',
                        jsonQuery: '={{ JSON.stringify({ action: "reverse_geocode", lat: $json.r.location.lat, lng: $json.r.location.lng }) }}',
                        options: { redirect: { redirect: { maxRedirects: 15 } }, timeout: 15000 } },
          alwaysOutputData: true, onError: 'continueRegularOutput' });
  w.add(iff('Route: Geocode OK?', '!!($json.ok === true || $json.formatted || $json.street || $json.city)', [-40, 200]));
  w.add({ name: 'Reverse Geocode (OSM)', type: 'n8n-nodes-base.httpRequest', typeVersion: 4.4, position: [180, 300],
          parameters: { url: 'https://nominatim.openstreetmap.org/reverse', sendQuery: true,
                        queryParameters: { parameters: [
                          { name: 'format', value: 'jsonv2' },
                          { name: 'lat', value: "={{ $('Claim Debounce Window').first().json.r.location.lat }}" },
                          { name: 'lon', value: "={{ $('Claim Debounce Window').first().json.r.location.lng }}" },
                          { name: 'accept-language', value: 'ar' }, { name: 'zoom', value: '18' }, { name: 'addressdetails', value: '1' }] },
                        sendHeaders: true,
                        headerParameters: { parameters: [{ name: 'User-Agent', value: 'Everwake-WhatsApp-Ordering/1.0 (n8n)' }] },
                        options: { timeout: 10000 } },
          alwaysOutputData: true, onError: 'continueRegularOutput' });
  w.add(code('Resolve Location', 'main/resolve_location.js', [400, 200]));
  w.add(pg('Save Pin + Zone', b64sql('save_pin'), '={{ [ $json.b64_pin ] }}', [620, 200], { alwaysOutputData: true }));

  w.add(pg('Load Turn Context', 'select everwake.turn_context($1::uuid, $2::text) as r;', `={{ [ ${I}.tenant_id, ${I}.wa_id ] }}`, [620, 460]));
  w.add(code('Build Brief', 'main/build_brief.js', [840, 460]));
  w.add(chain('Brain', '={{ $json.brief }}', prompt('brain.md'), [1060, 460]));
  w.add(model('Brain Model', 16000, 'high', 90000, [1060, 700]));
  w.add(code('Attach Plan', 'main/attach_plan.js', [1300, 460]));
  w.add({ name: 'Agent', type: '@n8n/n8n-nodes-langchain.agent', typeVersion: 3.1, position: [1520, 460], onError: 'continueRegularOutput',
          parameters: { promptType: 'define', text: '={{ $json.agent_prompt }}', hasOutputParser: true,
                        options: { systemMessage: prompt('agent.md'), maxIterations: 10, returnIntermediateSteps: true, enableStreaming: false } } });
  w.add(model('Agent Model', 6000, 'low', 90000, [1400, 720]));
  w.add({ name: 'Agent Output Parser', type: '@n8n/n8n-nodes-langchain.outputParserStructured', typeVersion: 1.3, position: [1880, 720],
          parameters: { schemaType: 'manual', inputSchema: JSON.stringify({
            type: 'object',
            properties: {
              reply_messages: { type: 'array', items: { type: 'string' }, description: '1 or 2 WhatsApp messages, exactly what the customer receives' },
              send_menu_images: { type: 'boolean', description: 'true only when sending the menu pictures with this reply' },
              send_item_photos: { type: 'array', items: { type: 'string' }, description: 'codes of up to 3 dishes whose photos go with this reply, or []' },
              showed_order_summary: { type: 'boolean', description: 'true only when this reply contains the full order summary to confirm' },
              handoff: { type: 'object', properties: { needed: { type: 'boolean' }, reason: { type: 'string', description: 'Arabic, for the team; empty when not needed' } },
                         required: ['needed', 'reason'] },
              language: { type: 'string', description: 'ar or en' },
              memory_note: { type: 'string', description: 'one short English line worth remembering later in this conversation, or empty' }
            },
            required: ['reply_messages', 'send_menu_images', 'send_item_photos', 'showed_order_summary', 'handoff', 'language', 'memory_note']
          }, null, 2) } });
  w.add(tool('manage_cart', 'Everwake — Tool: manage_cart', prompt('tool_manage_cart.md'), {
    tenant_id: `={{ ${I}.tenant_id }}`,
    wa_id: `={{ ${I}.wa_id }}`,
    request: "={{ $fromAI('request', 'One JSON object. action: exactly one of add, update, remove, replace, clear, set_branch, reorder_last, apply_code, place_order. items: the dishes this action touches, e.g. [{\"menu_id\":\"M003\",\"quantity\":1,\"choices\":[{\"level\":1,\"selected\":[\"فرخة كاملة\"]}],\"notes\":null}]; for apply_code [{\"promo_code\":\"THE CODE\"}]; left out for clear, set_branch, reorder_last and place_order. branch: only for set_branch, the branch code or name. Never include prices. Examples: {\"action\":\"set_branch\",\"branch\":\"gleem\"} · {\"action\":\"add\",\"items\":[{\"menu_id\":\"M013\",\"quantity\":1}]} · {\"action\":\"place_order\"}', 'json') }}"
  }, [1560, 720]));
  w.add(tool('save_customer_details', 'Everwake — Tool: save_customer_details', prompt('tool_save_details.md'), {
    tenant_id: `={{ ${I}.tenant_id }}`,
    wa_id: `={{ ${I}.wa_id }}`,
    details: "={{ $fromAI('details', 'A JSON object with only the customer details that are new or changed in this turn, e.g. {\"full_name\":\"أحمد\",\"address_area\":\"المعادي\"}. Add \"reset_address\":true when they give a different address; \"use_saved_address\":\"<number>\" to reuse a saved one.', 'json') }}"
  }, [1720, 720]));
  w.add(tool('manage_reservation', 'Everwake — Tool: manage_reservation', prompt('tool_manage_reservation.md'), {
    tenant_id: `={{ ${I}.tenant_id }}`,
    wa_id: `={{ ${I}.wa_id }}`,
    request: "={{ $fromAI('request', 'One JSON object. action: exactly one of update, summary, submit, cancel, status. details: only for update (and cancel when they have several bookings), only what is new or changed, e.g. {\"branch\":\"zamalek\",\"date\":\"2026-10-23\",\"time\":\"21:00\",\"guests\":4,\"occasion\":\"عيد ميلاد\"}; date is YYYY-MM-DD, time is HH:MM on the 24-hour clock. Examples: {\"action\":\"update\",\"details\":{\"guests\":4}} · {\"action\":\"summary\"}', 'json') }}"
  }, [1880, 900]));

  w.add(pg('Read Back State', 'select everwake.read_back($1::uuid, $2::text) as r;', `={{ [ ${I}.tenant_id, ${I}.wa_id ] }}`, [1840, 460]));
  w.add(code('Check Reply', 'main/check_reply.js', [2060, 460]));
  w.add(iff('Route: Needs Rewrite?', '$json.needs_rewrite', [2280, 460]));
  w.add(code('Build Rewrite Request', 'main/build_rewrite_request.js', [2500, 260]));
  w.add(chain('Rewrite', '={{ $json.rewrite_prompt }}', prompt('rewrite.md'), [2700, 260]));
  w.add(model('Rewrite Model', 3000, 'low', 60000, [2700, 480]));
  w.add(code('Finalize Rewrite', 'main/finalize_rewrite.js', [2920, 260]));
  w.add(code('Build Persist Payload', 'main/build_persist_payload.js', [3140, 460]));
  w.add(pg('Persist Turn + Unlock', b64sql('persist_turn'), '={{ [ $json.b64_persist ] }}', [3360, 460]));
  w.add(pg('Load Reply Media', b64sql('reply_media'), "={{ [ $('Build Persist Payload').first().json.b64_media ] }}", [3580, 360],
           { alwaysOutputData: true }));
  w.add(code('Prepare Outbound Messages', 'main/prepare_outbound.js', [3800, 360]));
  w.add({ name: 'Outbound Loop', type: 'n8n-nodes-base.splitInBatches', typeVersion: 3, position: [4020, 360], parameters: { options: { reset: false } } });
  w.add(noop('Turn Complete', [4240, 160]));
  w.add(iff('Route: Test Chat?', TEST, [4240, 560]));
  w.add(code('Pretend Send (test)', 'main/pretend_send.js', [4460, 680]));
  w.add(iff('Route: Text?', "$json.kind === 'text'", [4240, 400]));
  w.add(evo('Evolution — Send Text', 'message/sendText', '{ number: $json.reply_to, text: $json.text, delay: $json.delay_ms, linkPreview: false }', [4460, 320]));
  w.add(evo('Evolution — Send Media', 'message/sendMedia',
            "{ number: $json.reply_to, mediatype: $json.kind === 'document' ? 'document' : 'image', mimetype: $json.mime, media: $json.media_url, fileName: $json.file_name, caption: $json.caption || undefined, delay: $json.delay_ms }",
            [4460, 500], { timeout: 30000 }));
  w.add(code('Record Send', 'main/record_reply_send.js', [4680, 400]));
  w.add(pg('Log Outbound', b64sql('log_outbound'), '={{ [ $json.b64_log ] }}', [4900, 400]));

  w.add(iff('Route: Order Placed?', `!!$('Build Persist Payload').first().json.order_placed_no && !${TEST}`, [3580, 640]));
  w.add(pg('Load Order Ticket', 'select everwake.order_ticket($1::uuid, $2::text) as r;',
           "={{ [ $('Build Persist Payload').first().json.tenant_id, $('Build Persist Payload').first().json.order_placed_no ] }}", [3800, 640]));
  w.add(code('Build Order Ticket', 'main/build_order_ticket.js', [4020, 640]));
  w.add(evo('Evolution — Send Order Ticket', 'message/sendText', '{ number: $json.ops_number, text: $json.text, delay: 300, linkPreview: false }', [4240, 640]));
  w.add(sticky('Sticky — Ticket', '### New-order ticket\nSent to the branch\'s ops WhatsApp (or the restaurant\'s). The dashboard\'s live order board rings regardless.',
               [3560, 820], 900, 140, 3));

  w.chain('WA — Evolution Webhook', 'Normalize Inbound', 'Route: Actionable?');
  w.link('Test Runner Call', 'Normalize Inbound');
  w.link('Route: Actionable?', 'Intake', 0); w.link('Route: Actionable?', 'Exit: Ignored', 1);
  w.chain('Intake', 'Route: To The Agent?');
  w.link('Route: To The Agent?', 'Route: Real Customer?', 0);
  w.link('Route: Real Customer?', 'Send Typing Presence', 0); w.link('Route: Real Customer?', 'Debounce Wait 6s', 1); w.link('Route: To The Agent?', 'Route: Apologise (Agent OFF)?', 1);
  w.link('Route: Apologise (Agent OFF)?', 'Prepare Apology', 0); w.link('Route: Apologise (Agent OFF)?', 'Route: Typed On The Phone?', 1);
  w.chain('Prepare Apology', 'Evolution — Send Apology', 'Record Apology', 'Log Apology');
  w.link('Route: Typed On The Phone?', 'Wait For Own Echo 5s', 0); w.link('Route: Typed On The Phone?', 'Exit: Not For The Agent', 1);
  w.chain('Wait For Own Echo 5s', 'Log Phone Reply');
  w.chain('Send Typing Presence', 'Debounce Wait 6s', 'Claim Debounce Window', 'Route: Won The Window?');
  w.link('Route: Won The Window?', 'Route: Has Location?', 0); w.link('Route: Won The Window?', 'Route: Retry Or Exit?', 1);
  w.link('Route: Retry Or Exit?', 'Retry Backoff 3s', 0); w.link('Route: Retry Or Exit?', 'Exit: Superseded', 1);
  w.chain('Retry Backoff 3s', 'Claim Debounce Window');
  w.link('Route: Has Location?', 'Reverse Geocode (Google)', 0); w.link('Route: Has Location?', 'Load Turn Context', 1);
  w.chain('Reverse Geocode (Google)', 'Route: Geocode OK?');
  w.link('Route: Geocode OK?', 'Resolve Location', 0); w.link('Route: Geocode OK?', 'Reverse Geocode (OSM)', 1);
  w.chain('Reverse Geocode (OSM)', 'Resolve Location', 'Save Pin + Zone', 'Load Turn Context');
  w.chain('Load Turn Context', 'Build Brief', 'Brain', 'Attach Plan', 'Agent', 'Read Back State', 'Check Reply', 'Route: Needs Rewrite?');
  w.link('Brain Model', 'Brain', 0, 'ai_languageModel');
  w.link('Agent Model', 'Agent', 0, 'ai_languageModel');
  w.link('Agent Output Parser', 'Agent', 0, 'ai_outputParser');
  w.link('manage_cart', 'Agent', 0, 'ai_tool');
  w.link('save_customer_details', 'Agent', 0, 'ai_tool');
  w.link('manage_reservation', 'Agent', 0, 'ai_tool');
  w.link('Rewrite Model', 'Rewrite', 0, 'ai_languageModel');
  w.link('Route: Needs Rewrite?', 'Build Rewrite Request', 0); w.link('Route: Needs Rewrite?', 'Build Persist Payload', 1);
  w.chain('Build Rewrite Request', 'Rewrite', 'Finalize Rewrite', 'Build Persist Payload');
  w.chain('Build Persist Payload', 'Persist Turn + Unlock', 'Load Reply Media', 'Prepare Outbound Messages', 'Outbound Loop');
  w.link('Persist Turn + Unlock', 'Route: Order Placed?');
  w.link('Outbound Loop', 'Turn Complete', 0); w.link('Outbound Loop', 'Route: Test Chat?', 1);
  w.link('Route: Test Chat?', 'Pretend Send (test)', 0); w.link('Route: Test Chat?', 'Route: Text?', 1);
  w.chain('Pretend Send (test)', 'Record Send');
  w.link('Route: Text?', 'Evolution — Send Text', 0); w.link('Route: Text?', 'Evolution — Send Media', 1);
  w.link('Evolution — Send Text', 'Record Send'); w.link('Evolution — Send Media', 'Record Send');
  w.chain('Record Send', 'Log Outbound', 'Outbound Loop');
  w.link('Route: Order Placed?', 'Load Order Ticket', 0);
  w.chain('Load Order Ticket', 'Build Order Ticket', 'Evolution — Send Order Ticket');
  return w;
}

// =========================================================================
// Tool: manage_cart
// =========================================================================
function buildCart() {
  const w = new Workflow('Everwake — Tool: manage_cart');
  w.add(sticky('Sticky — manage_cart', [
    '## Everwake · manage_cart',
    'Called BY THE AGENT. Owns the cart, the branch, the offers and placing the order — for every restaurant.',
    '**actions** add · update · remove · replace · clear · **set_branch** · **reorder_last** · **apply_code** · **place_order** (refuses unless the cart, the details, the branch — open and taking orders — the delivery area and the confirmed summary all check out).',
    'A placed order the customer pays **online** gets its Paymob payment link from the dashboard (**Create Payment Link**, header auth *Everwake Outbox Secret*), so the agent sends it in the same reply.',
    'Every call first re-checks the cart against the live menu, so a dish switched off in the dashboard is never sold.'
  ].join('\n'), [0, 0], 1200, 220, 5));
  w.add(trigger('Tool Called By Agent', ['tenant_id', 'wa_id', 'request', 'action', 'items_json', 'branch_id'], [0, 320]));
  w.add(code('Read Args', 'cart/read_args.js', [220, 320]));
  w.add(pg('Load Cart + Menu', 'select everwake.cart_context($1::uuid, $2::text, $3::text) as r;',
           "={{ [ $json.tenant_id, $json.wa_id, $json.branch_id || '' ] }}", [440, 320]));
  w.add(code('Apply + Recalculate', 'cart/apply_recalculate.js', [660, 320]));
  w.add(iff('Applied OK?', '$json.ok', [880, 320]));
  w.add(iff('Route: Place Order?', '$json.is_place', [1100, 240]));
  w.add(pg('Place Order', b64sql('place_order'), '={{ [ $json.b64_place ] }}', [1320, 140]));
  w.add(pg('Persist Cart', b64sql('persist_cart'), '={{ [ $json.b64_cart ] }}', [1320, 340]));
  w.add(pg('Payment Needed?', 'select everwake.payment_after_place($1::uuid, $2::text) as r;',
           "={{ [ $('Read Args').first().json.tenant_id, ($json.r && $json.r.order_no) || '' ] }}", [1540, 140], { alwaysOutputData: true }));
  w.add(iff('Route: Payment Link?', '!!$json.r && $json.r.needed === true', [1760, 140]));
  w.add({ name: 'Create Payment Link', type: 'n8n-nodes-base.httpRequest', typeVersion: 4.4, position: [1980, 40],
          parameters: { method: 'POST', url: '={{ $json.r.endpoint }}', authentication: 'genericCredentialType', genericAuthType: 'httpHeaderAuth',
                        sendBody: true, specifyBody: 'json',
                        jsonBody: '={{ JSON.stringify({ tenant_id: $json.r.tenant_id, order_no: $json.r.order_no }) }}',
                        options: { timeout: 25000, response: { response: { neverError: true, responseFormat: 'json' } } } },
          credentials: { httpHeaderAuth: { id: 'EVERWAKE_OUTBOX', name: 'Everwake Outbox Secret' } },
          onError: 'continueRegularOutput', alwaysOutputData: true });
  w.add(code('Format Tool Response', 'cart/format_tool_response.js', [2200, 240]));
  w.add(code('Format Tool Error', 'cart/format_tool_error.js', [1100, 460]));
  w.chain('Tool Called By Agent', 'Read Args', 'Load Cart + Menu', 'Apply + Recalculate', 'Applied OK?');
  w.link('Applied OK?', 'Route: Place Order?', 0); w.link('Applied OK?', 'Format Tool Error', 1);
  w.link('Route: Place Order?', 'Place Order', 0); w.link('Route: Place Order?', 'Persist Cart', 1);
  w.chain('Place Order', 'Payment Needed?', 'Route: Payment Link?');
  w.link('Route: Payment Link?', 'Create Payment Link', 0); w.link('Route: Payment Link?', 'Format Tool Response', 1);
  w.link('Create Payment Link', 'Format Tool Response'); w.link('Persist Cart', 'Format Tool Response');
  return w;
}

// =========================================================================
// Tool: save_customer_details
// =========================================================================
function buildDetails() {
  const w = new Workflow('Everwake — Tool: save_customer_details');
  w.add(sticky('Sticky — save_customer_details', [
    '## Everwake · save_customer_details',
    'Called BY THE AGENT the same turn the customer gives any detail. Whitelists fields, normalises enums, keeps the ledger so nothing is asked twice. `reset_address` wipes the old address + pin; `use_saved_address` reuses one from a previous order. A typed area is matched to a delivery zone; a typed phone is remembered for customers WhatsApp hides.'
  ].join('\n'), [0, 0], 1000, 200, 5));
  w.add(trigger('Tool Called By Agent', ['tenant_id', 'wa_id', 'details', 'details_json'], [0, 320]));
  w.add(pg('Load Customer State', 'select everwake.details_context($1::uuid, $2::text) as r;', '={{ [ $json.tenant_id, $json.wa_id ] }}', [220, 320]));
  w.add(code('Validate + Patch', 'details/validate_patch.js', [440, 320]));
  w.add(iff('Valid?', '$json.ok', [660, 320]));
  w.add(pg('Persist Customer Details', b64sql('persist_details'), '={{ [ $json.b64_persist ] }}', [880, 240]));
  w.add(code('Return To Agent', 'details/return_to_agent.js', [1100, 240]));
  w.add(code('Return Error', 'details/return_error.js', [880, 420]));
  w.chain('Tool Called By Agent', 'Load Customer State', 'Validate + Patch', 'Valid?');
  w.link('Valid?', 'Persist Customer Details', 0); w.link('Valid?', 'Return Error', 1);
  w.chain('Persist Customer Details', 'Return To Agent');
  return w;
}

// =========================================================================
// Tool: manage_reservation
// =========================================================================
function buildReservation() {
  const w = new Workflow('Everwake — Tool: manage_reservation');
  w.add(sticky('Sticky — manage_reservation', [
    '## Everwake · manage_reservation',
    'Called BY THE AGENT for table bookings (dine-in), at branches set to take bookings on WhatsApp.',
    '**actions** **update** (any of branch, date, time, guests, name, phone, occasion, special requests — every value is checked: in the future, not too far ahead, while the branch is open, not more guests than it seats) · **summary** (the text the customer confirms) · **submit** (only a summary they agreed to, unchanged since: the branch\'s operations WhatsApp gets the ticket with the customer\'s details, and the dashboard\'s Reservations page shows it) · **cancel** · **status**.',
    'The team calls the customer and presses Confirm on the dashboard — that is when the customer hears it is confirmed.'
  ].join('\n'), [0, 0], 1200, 240, 5));
  w.add(trigger('Tool Called By Agent', ['tenant_id', 'wa_id', 'request', 'action', 'details_json'], [0, 320]));
  w.add(code('Read Args', 'reservation/read_args.js', [220, 320]));
  w.add(pg('Booking', "select everwake.reservation_tool($1::uuid, $2::text, $3::text, convert_from(decode($4::text, 'base64'), 'UTF8')) as r;",
           '={{ [ $json.tenant_id, $json.wa_id, $json.action, $json.details_b64 ] }}', [440, 320]));
  w.add(code('Return To Agent', 'reservation/return_to_agent.js', [660, 320]));
  w.chain('Tool Called By Agent', 'Read Args', 'Booking', 'Return To Agent');
  return w;
}

// =========================================================================
// Outbox + housekeeping
// =========================================================================
function buildOutbox() {
  const w = new Workflow('Everwake — Outbox + Housekeeping');
  w.add(sticky('Sticky — Outbox', [
    '## Everwake · Outbox',
    'Everything the dashboard and the system send — staff replies from the inbox, order status messages, the "we\'re back" message after the agent is switched on again — is written to `everwake.outbox` first, so nothing is lost while WhatsApp or n8n is down.',
    'Runs **every minute** (plus housekeeping: idle takeovers return to the agent, stuck locks and sends are freed, expired out-of-stock items come back) and **immediately** when the dashboard pings **POST /webhook/everwake-outbox** (header auth: the *Everwake Outbox Secret* credential, the same value as the dashboard\'s N8N_OUTBOX_SECRET).',
    'Failed sends retry 3 times, 30 s apart, then show as failed in the dashboard with the reason.'
  ].join('\n'), [0, 0], 1400, 240, 5));
  w.add({ name: 'Every Minute', type: 'n8n-nodes-base.scheduleTrigger', typeVersion: 1.2, position: [0, 340],
          parameters: { rule: { interval: [{ field: 'minutes', minutesInterval: 1 }] } } });
  w.add({ name: 'Ping From Dashboard', type: 'n8n-nodes-base.webhook', typeVersion: 2.1, position: [0, 560],
          parameters: { httpMethod: 'POST', path: 'everwake-outbox', authentication: 'headerAuth', options: {} },
          credentials: { httpHeaderAuth: { id: 'EVERWAKE_OUTBOX', name: 'Everwake Outbox Secret' } } });
  w.add(pg('Housekeeping', 'select everwake.housekeeping() as r;', null, [220, 340]));
  w.add(pg('Claim Batch', "select everwake.outbox_claim(25, 'n8n') as r;", null, [440, 460]));
  w.add(code('One Item Per Message', 'outbox/split_batch.js', [660, 460]));
  w.add({ name: 'Send Loop', type: 'n8n-nodes-base.splitInBatches', typeVersion: 3, position: [880, 460], parameters: { options: { reset: false } } });
  w.add(noop('Done', [1100, 300]));
  w.add(iff('Route: Text?', "$json.kind === 'text'", [1100, 500]));
  w.add(evo('Evolution — Send Text', 'message/sendText', '{ number: $json.to, text: $json.text, delay: $json.delay_ms, linkPreview: /https?:\\/\\//.test($json.text) }', [1320, 420], { retry: false }));
  w.add(evo('Evolution — Send Media', 'message/sendMedia',
            "{ number: $json.to, mediatype: $json.kind, mimetype: $json.mime, media: $json.media_url, fileName: $json.file_name, caption: $json.text || undefined, delay: $json.delay_ms }",
            [1320, 600], { timeout: 30000, retry: false }));
  w.add(code('Record Result', 'outbox/record_result.js', [1540, 500]));
  w.add(pg('Save Result', b64sql('outbox_result'), '={{ [ $json.b64_result ] }}', [1760, 500]));
  w.chain('Every Minute', 'Housekeeping', 'Claim Batch');
  w.link('Ping From Dashboard', 'Claim Batch');
  w.chain('Claim Batch', 'One Item Per Message', 'Send Loop');
  w.link('Send Loop', 'Done', 0); w.link('Send Loop', 'Route: Text?', 1);
  w.link('Route: Text?', 'Evolution — Send Text', 0); w.link('Route: Text?', 'Evolution — Send Media', 1);
  w.link('Evolution — Send Text', 'Record Result'); w.link('Evolution — Send Media', 'Record Result');
  w.chain('Record Result', 'Save Result', 'Send Loop');
  return w;
}

// =========================================================================
// Test Runner
// =========================================================================
function buildTestRunner() {
  const w = new Workflow('Everwake — Test Runner');
  w.add(sticky('Sticky — Test Runner', [
    '## Everwake · Test Runner — chat with an agent, nothing goes on WhatsApp',
    'Open the chat (**Open chat** at the bottom) and write as a customer. The real **Main** workflow answers from a pretend number (200000000001), so you test exactly what customers get — but the replies are only recorded, no kitchen ticket is sent, and it works while the restaurant is still onboarding.',
    '**/reset** a brand-new customer · **/last** the latest turn again (when a long one timed out) · **/later 5 <message>** 5 hours pass first · **/pin 31.2,29.9** a location pin · **#2 <message>** a second pretend customer · **@slug <message>** another restaurant.',
    'The restaurant to test is set at the top of **Read Test Command** (seagull). The test chat shows in the dashboard inbox as «تجربة»; an order it places shows on the board — **/reset** removes it.',
    '### After import',
    '1. Pick the **Everwake DB** credential on the two Postgres nodes.',
    '2. On **Run The Agent (Main)** pick *Everwake — Main (Brain + Agent)* (it shows SET_AFTER_IMPORT).'
  ].join('\n'), [-300, -420], 1500, 380, 6));
  w.add({ name: 'Chat With The Agent (test)', type: '@n8n/n8n-nodes-langchain.chatTrigger', typeVersion: 1.1, position: [-260, 0],
          parameters: { options: {} } });
  w.add(code('Read Test Command', 'test_runner/read_command.js', [-40, 0]));
  w.add(pg('Prepare Test Chat', 'select everwake.test_chat_prepare($1::text, $2::text, $3::boolean, $4::numeric) as r;',
           '={{ [ $json.restaurant, $json.wa_id, $json.reset, $json.later_hours ] }}', [180, 0]));
  w.add(iff('Route: A Message To Send?', "!$('Read Test Command').first().json.reset && !$('Read Test Command').first().json.last && !$('Read Test Command').first().json.empty", [400, 0]));
  w.add(iff('Route: Show The Last Turn?', "$('Read Test Command').first().json.last === true", [620, 140]));
  w.add(code('Fake WhatsApp Message', 'test_runner/fake_message.js', [620, -100]));
  w.add({ name: 'Run The Agent (Main)', type: 'n8n-nodes-base.executeWorkflow', typeVersion: 1.2, position: [840, -100],
          parameters: {
            workflowId: wfRef('Everwake — Main (Brain + Agent)'),
            workflowInputs: { mappingMode: 'defineBelow', value: {}, matchingColumns: [], schema: [], attemptToConvertTypes: false, convertFieldsToString: true },
            options: { waitForSubWorkflow: true } },
          alwaysOutputData: true, onError: 'continueRegularOutput' });
  w.add(pg('Load The Reply', 'select everwake.test_chat_result($1::uuid, $2::text, $3::timestamptz) as r;',
           "={{ [ $('Prepare Test Chat').first().json.r.tenant_id, $('Prepare Test Chat').first().json.r.wa_id, $('Read Test Command').first().json.last ? ($('Prepare Test Chat').first().json.r.last_message_at || $('Prepare Test Chat').first().json.r.since) : $('Prepare Test Chat').first().json.r.since ] }}",
           [1060, -100], { executeOnce: true }));
  w.add(code('Format Test Result', 'test_runner/format_result.js', [1280, 0]));
  w.chain('Chat With The Agent (test)', 'Read Test Command', 'Prepare Test Chat', 'Route: A Message To Send?');
  w.link('Route: A Message To Send?', 'Fake WhatsApp Message', 0); w.link('Route: A Message To Send?', 'Route: Show The Last Turn?', 1);
  w.link('Route: Show The Last Turn?', 'Load The Reply', 0); w.link('Route: Show The Last Turn?', 'Format Test Result', 1);
  w.chain('Fake WhatsApp Message', 'Run The Agent (Main)', 'Load The Reply', 'Format Test Result');
  return w;
}

export const workflows = { main: buildMain, cart: buildCart, details: buildDetails, reservation: buildReservation, outbox: buildOutbox,
                           test: buildTestRunner };

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  mkdirSync(join(ROOT, 'dist'), { recursive: true });
  const files = {
    main: 'everwake-main.json', cart: 'everwake-tool-manage-cart.json',
    details: 'everwake-tool-save-customer-details.json', reservation: 'everwake-tool-manage-reservation.json',
    outbox: 'everwake-outbox.json', test: 'everwake-test-runner.json'
  };
  for (const [k, build] of Object.entries(workflows)) {
    const w = build();
    // every connection must point at a node that exists
    const names = new Set(w.nodes.map(n => n.name));
    for (const [from, types] of Object.entries(w.connections)) {
      if (!names.has(from)) throw new Error(`${w.name}: connection from unknown node ${from}`);
      for (const outs of Object.values(types)) for (const out of outs) for (const c of out)
        if (!names.has(c.node)) throw new Error(`${w.name}: ${from} → unknown node ${c.node}`);
    }
    writeFileSync(join(ROOT, 'dist', files[k]), JSON.stringify(w.json(), null, 2) + '\n');
    console.log(`${files[k].padEnd(44)} ${w.nodes.length} nodes`);
  }
}
