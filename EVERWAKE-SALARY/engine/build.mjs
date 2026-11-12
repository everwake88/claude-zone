#!/usr/bin/env node
// =====================================================================
// Everwake Salary · engine builder
//
// The engine's code lives in src/ (one file per n8n Code node) and its
// prompt in prompts/. This script assembles them into the workflow you
// import into n8n:
//
//   dist/everwake-salary-main.json   "Everwake Salary — WhatsApp Agent"
//
//   node build.mjs
//
// Optional environment:
//   SAL_MODEL            the agent's model                       (default gpt-6-luna)
//   SAL_EFFORT           the agent's reasoning effort            (default low)
//   SAL_VISION_MODEL     reads an employee's photo (an ID card…) (default gpt-6-luna)
//   SAL_VISION_EFFORT    its reasoning effort                    (default low)
//   SAL_TRANSCRIBE_MODEL hears a voice note                      (default gpt-transcribe)
//   SAL_WAIT_SECONDS     wait for more messages before answering (default 4)
//   SAL_PG_CRED_ID       n8n Postgres credential id              (default EVERWAKE_SALARY_DB)
//   SAL_OPENAI_CRED_ID   n8n OpenAI credential id                (default OPENAI)
// =====================================================================
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(fileURLToPath(import.meta.url));
const MODEL = process.env.SAL_MODEL || 'gpt-6-luna';
const EFFORT = process.env.SAL_EFFORT || 'low';
const VISION_MODEL = process.env.SAL_VISION_MODEL || 'gpt-6-luna';
const VISION_EFFORT = process.env.SAL_VISION_EFFORT || 'low';
const TRANSCRIBE_MODEL = process.env.SAL_TRANSCRIBE_MODEL || 'gpt-transcribe';
const WAIT_SECONDS = Number(process.env.SAL_WAIT_SECONDS || 4);
const PG = { postgres: { id: process.env.SAL_PG_CRED_ID || 'EVERWAKE_SALARY_DB', name: 'Everwake Salary DB' } };
const OPENAI = { openAiApi: { id: process.env.SAL_OPENAI_CRED_ID || 'OPENAI', name: 'OpenAi account' } };
const OPENAI_URL = 'https://api.openai.com/v1/';

// ---- sources -----------------------------------------------------------
export function expand(code) {
  return code.replace(/^\/\/ @include (\S+)\s*$/gm, (_, f) => readFileSync(join(ROOT, 'src', f), 'utf8').trim());
}
const prompt = (p) => readFileSync(join(ROOT, 'prompts', p), 'utf8').trim();

// the agent's three tools (strict: the model always sends every field, null when it has none)
const nullable = (description) => ({ type: ['string', 'null'], description });
export const AGENT_TOOLS = [
  { type: 'function', name: 'verify_identity', strict: true,
    description: 'Check the identity details the employee gave in this chat. Send only what they gave this turn (null for the rest), exactly as they gave it — the database checks the formats, keeps the valid ones, and matches the complete set against the payroll records. Returns status need_more (with invalid and still_needed), verified (with their newest payslip), no_match, phone_mismatch, sender_hidden, ambiguous or already_verified.',
    parameters: { type: 'object', additionalProperties: false, required: ['details'], properties: {
      details: { type: 'object', additionalProperties: false, required: ['full_name', 'national_id', 'work_id', 'phone'], properties: {
        full_name: nullable('The full name as written on their national ID card, all the names.'),
        national_id: nullable('The national ID number as they gave it.'),
        work_id: nullable('Their work ID / employee code as they gave it.'),
        phone: nullable('Their mobile number as they gave it.') } } } } },
  { type: 'function', name: 'get_payslip', strict: true,
    description: 'The verified employee\'s own payroll row for one month: each column header with its value, plus the months on file. Works only after verify_identity returned verified in this chat.',
    parameters: { type: 'object', additionalProperties: false, required: ['period'], properties: {
      period: nullable('The payroll month as YYYY-MM, or null for the newest month on file.') } } },
  { type: 'function', name: 'escalate_to_hr', strict: true,
    description: 'Send the verified employee\'s dispute to HR, who see it in their dashboard and follow up. Use it once they still disagree after you showed what the row says. Returns the ticket number.',
    parameters: { type: 'object', additionalProperties: false, required: ['period', 'item', 'details'], properties: {
      period: nullable('The payroll month it is about, YYYY-MM.'),
      item: { type: 'string', description: 'The column it is about, as HR wrote it (e.g. "خصم تأخير"), or "other".' },
      details: { type: 'string', description: 'What they believe is wrong, in their own words, with any dates and amounts they gave.' } } } }
];

export function fill(code) {
  return code.replace(/__MODEL__/g, MODEL).replace(/__AGENT_EFFORT__/g, EFFORT)
    .replace(/__VISION_MODEL__/g, VISION_MODEL).replace(/__VISION_EFFORT__/g, VISION_EFFORT)
    .replace(/__TRANSCRIBE_MODEL__/g, TRANSCRIBE_MODEL)
    .replace(/"__AGENT_PROMPT__"/g, () => JSON.stringify(prompt('agent.md')))
    .replace(/"__AGENT_TOOLS__"/g, () => JSON.stringify(AGENT_TOOLS));
}
export const src = (p) => fill(expand(readFileSync(join(ROOT, 'src', p), 'utf8'))).trim() + '\n';
const b64sql = (call) => `select ${call.replace('$JSON', "convert_from(decode($2::text, 'base64'), 'UTF8')::jsonb")} as r;`;

// ---- node builders ----------------------------------------------------------
function uuidOf(s) {
  const h = createHash('sha1').update(s).digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-5${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`;
}
class Workflow {
  constructor(name) { this.name = name; this.nodes = []; this.connections = {}; }
  add(node) {
    node.id = uuidOf(this.name + '::' + node.name);
    if (['n8n-nodes-base.webhook', 'n8n-nodes-base.wait'].includes(node.type)) node.webhookId = uuidOf(this.name + '::hook::' + node.name);
    this.nodes.push(node);
    return node.name;
  }
  link(from, to, output = 0) {
    const c = (this.connections[from] = this.connections[from] || { main: [] });
    while (c.main.length <= output) c.main.push([]);
    c.main[output].push({ node: to, type: 'main', index: 0 });
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
  parameters: { operation: 'executeQuery', query, options: { queryReplacement: params } }, ...extra });
const iff = (name, expr, pos) => ({
  name, type: 'n8n-nodes-base.if', typeVersion: 2.3, position: pos,
  parameters: { conditions: {
      options: { caseSensitive: true, leftValue: '', typeValidation: 'loose', version: 3 },
      conditions: [{ id: uuidOf(name + expr), leftValue: `={{ ${expr} }}`, rightValue: '', operator: { type: 'boolean', operation: 'true', singleValue: true } }],
      combinator: 'and' }, looseTypeValidation: true, options: {} } });
const noop = (name, pos) => ({ name, type: 'n8n-nodes-base.noOp', typeVersion: 1, position: pos, parameters: {} });
// an Evolution API call on the channel Intake returned (its URL, instance and key live in salary.channel)
const CH = "$('Intake').first().json.r.channel";
const evo = (name, path, body, pos, { timeout = 20000, retry = true } = {}) => ({
  name, type: 'n8n-nodes-base.httpRequest', typeVersion: 4.4, position: pos,
  parameters: { method: 'POST', url: `={{ ${CH}.base_url }}/${path}/{{ ${CH}.instance }}`,
                sendHeaders: true, headerParameters: { parameters: [{ name: 'apikey', value: `={{ ${CH}.api_key }}` }] },
                sendBody: true, specifyBody: 'json', jsonBody: `={{ JSON.stringify(${body}) }}`,
                options: { response: { response: { fullResponse: true, neverError: true, responseFormat: 'json' } }, timeout } },
  ...(retry ? { retryOnFail: true, maxTries: 2, waitBetweenTries: 1500 } : {}),
  onError: 'continueRegularOutput', alwaysOutputData: true });
const openai = (name, path, bodyExpr, pos, timeout = 90000) => ({
  name, type: 'n8n-nodes-base.httpRequest', typeVersion: 4.4, position: pos, credentials: OPENAI,
  parameters: { method: 'POST', url: OPENAI_URL + path, authentication: 'predefinedCredentialType', nodeCredentialType: 'openAiApi',
                sendBody: true, specifyBody: 'json', jsonBody: `={{ JSON.stringify(${bodyExpr}) }}`,
                options: { timeout, response: { response: { fullResponse: true, neverError: true, responseFormat: 'json' } } } },
  retryOnFail: true, maxTries: 2, waitBetweenTries: 2000, onError: 'continueRegularOutput', alwaysOutputData: true });

const CONV = "$('Intake').first().json.r.conversation_id";
const MSG = "$('Intake').first().json.r.message_id";
const NI = "$('Normalize Inbound').first().json";

// =========================================================================
export function buildMain() {
  const w = new Workflow('Everwake Salary — WhatsApp Agent');
  w.add(sticky('Sticky — Overview', [
    '## Everwake Salary — the HR assistant on WhatsApp',
    'An employee asks about their salary. **Intake** checks the webhook token and saves the message. A voice note is transcribed and a photo (often the national ID card) is read before the agent answers. After a short wait only the newest message answers (**Claim Turn**), so three quick messages get one reply.',
    `**Agent** (${MODEL}, ${EFFORT} reasoning) collects the identity details HR ticked in the dashboard, one or two at a time, and calls **verify_identity**. The database checks the formats and finds the exact payroll row; **get_payslip** and **escalate_to_hr** answer only a verified chat, and only with that one person's row.`,
    'Webhook: **POST /webhook/everwake-salary?token=<webhook token>** — the dashboard (Settings → WhatsApp) shows the exact URL to paste into Evolution.'
  ].join('\n\n'), [-1900, -420], 1500, 330));
  w.add(sticky('Sticky — Setup', [
    '### After import',
    '1. Pick the **Everwake Salary DB** Postgres credential on every Postgres node.',
    '2. Pick your OpenAI credential on **Agent Call (OpenAI)**, **Transcribe Voice Note (OpenAI)** and **Look At Photo (OpenAI)**.',
    '3. Activate. The Evolution URL, instance and key are read from the database (dashboard → Settings → WhatsApp).'
  ].join('\n'), [-400, -420], 900, 200, 3));

  w.add({ name: 'WhatsApp Webhook (Evolution)', type: 'n8n-nodes-base.webhook', typeVersion: 2.1, position: [-1800, 0],
          parameters: { httpMethod: 'POST', path: 'everwake-salary', options: {} } });
  w.add(code('Normalize Inbound', 'main/normalize_inbound.js', [-1600, 0]));
  w.add(iff('Route: A Message?', '!$json.ignorable', [-1400, 0]));
  w.add(noop('Exit: Ignored', [-1200, 200]));
  w.add(pg('Intake', b64sql('salary.intake($JSON)').replace('$2', '$1'), '={{ [ $json.b64_intake ] }}', [-1200, -20]));
  w.add(iff('Route: To The Agent?', "$json.r.route === 'agent'", [-1000, -20]));
  w.add(noop('Exit: Not For The Agent', [-800, 200]));
  // "typing…" on the employee's phone the moment the message lands, and again when the agent starts
  // thinking (WhatsApp drops it after the delay, so a voice note plus a long turn would otherwise lose it)
  const TYPING = `{ number: $('Intake').first().json.r.reply_to, delay: 30000, presence: 'composing' }`;
  w.add({ ...evo('Evolution — Typing', 'chat/sendPresence', TYPING, [-800, -20], { timeout: 1500, retry: false }),
          notes: 'Never waited for: 1.5 s at most.', notesInFlow: true });

  // a voice note or a photo: understood before the turn
  w.add(iff('Route: Voice Note Or Photo?', `!!${NI}.media`, [-600, -20]));
  w.add(iff('Route: Fetch The File?', `!${NI}.media_b64`, [-400, -220]));
  w.add(evo('Evolution — Fetch Media', 'chat/getBase64FromMediaMessage',
            `{ message: { key: { id: ${NI}.external_id } }, convertToMp4: false }`, [-200, -300], { timeout: 30000 }));
  w.add(code('Prepare Media', 'main/prepare_media.js', [0, -220]));
  w.add(iff('Route: Voice Note?', "$json.ok && $json.kind === 'audio'", [200, -220]));
  w.add(iff('Route: Photo?', "$json.ok && $json.kind === 'image'", [400, -120]));
  const P = "$('Prepare Media').first().json";
  w.add({ name: 'Voice Note To File', type: 'n8n-nodes-base.convertToFile', typeVersion: 1.1, position: [400, -340],
          parameters: { operation: 'toBinary', sourceProperty: 'b64', binaryPropertyName: 'data',
                        options: { fileName: `={{ ${P}.file_name }}`, mimeType: `={{ ${P}.mime }}` } },
          onError: 'continueRegularOutput', alwaysOutputData: true });
  w.add({ name: 'Transcribe Voice Note (OpenAI)', type: 'n8n-nodes-base.httpRequest', typeVersion: 4.4, position: [600, -340], credentials: OPENAI,
          parameters: { method: 'POST', url: OPENAI_URL + 'audio/transcriptions', authentication: 'predefinedCredentialType', nodeCredentialType: 'openAiApi',
                        sendBody: true, contentType: 'multipart-form-data',
                        bodyParameters: { parameters: [
                          { parameterType: 'formBinaryData', name: 'file', inputDataFieldName: 'data' },
                          { name: 'model', value: `={{ ${P}.transcribe_model }}` },
                          { name: 'prompt', value: `={{ ${P}.transcribe_prompt }}` }] },
                        options: { timeout: 60000, response: { response: { neverError: true, responseFormat: 'json' } } } },
          retryOnFail: true, maxTries: 2, waitBetweenTries: 1500, onError: 'continueRegularOutput', alwaysOutputData: true });
  w.add(openai('Look At Photo (OpenAI)', 'chat/completions', '$json.vision_body', [600, -120], 60000));
  w.add(code('Media Understood', 'main/media_understood.js', [800, -220]));
  w.add(pg('Save What It Said', "select salary.media_understood((x ->> 'message_id')::bigint, x ->> 'text') as r from (select convert_from(decode($1::text, 'base64'), 'UTF8')::jsonb as x) s;",
           '={{ [ $json.b64_media ] }}',
           [1000, -220], { alwaysOutputData: true, onError: 'continueRegularOutput' }));

  // the turn
  w.add({ name: 'Wait For More Messages', type: 'n8n-nodes-base.wait', typeVersion: 1.1, position: [1200, -20],
          parameters: { resume: 'timeInterval', amount: WAIT_SECONDS, unit: 'seconds' } });
  w.add(pg('Claim Turn', 'select salary.claim_turn($1::uuid, $2::bigint) as r;', `={{ [ ${CONV}, ${MSG} ] }}`, [1400, -20]));
  w.add(iff('Route: Newest Message?', '$json.r.go === true', [1600, -20]));
  w.add(noop('Exit: A Newer Message Answers', [1800, 180]));
  w.add({ ...evo('Evolution — Still Typing', 'chat/sendPresence', TYPING, [1700, -220], { timeout: 1500, retry: false }),
          notes: 'Never waited for: 1.5 s at most.', notesInFlow: true });
  // the employee wrote again while this turn was thinking: stop, the turn of their newest message answers all of it
  const STILL = 'select salary.still_newest($1::uuid, $2::bigint) as r;';
  w.add(pg('Still Newest? (Before AI)', STILL, `={{ [ ${CONV}, ${MSG} ] }}`, [2100, -220]));
  w.add(iff('Route: Go On (AI)?', '$json.r.go === true', [2200, -220]));
  w.add(pg('Still Newest? (Before Sending)', STILL, `={{ [ ${CONV}, ${MSG} ] }}`, [2950, 360]));
  w.add(iff('Route: Go On (Send)?', '$json.r.go === true', [3050, 360]));
  w.add(noop('Exit: They Wrote Again', [3250, 560]));
  w.add(sticky('Sticky — They wrote again', '### They wrote again\nBefore every AI call and before sending, **Still Newest?** asks whether the employee sent another message after this one. If so, this run stops without replying, and the run of their newest message answers everything they sent, together — like a person who stops typing to read the new message.',
               [1900, 420], 700, 150, 6));
  w.add(pg('Load Turn Context', 'select salary.turn_context($1::uuid, $2::bigint) as r;', `={{ [ ${CONV}, ${MSG} ] }}`, [1800, -20]));
  w.add(code('Agent Request', 'main/agent_request.js', [2000, -20]));
  w.add(openai('Agent Call (OpenAI)', 'responses', "$('Agent Request').first().json.body", [2300, -20]));
  w.add(code('Agent Step', 'main/agent_step.js', [2400, -20]));
  const ways = ['verify_identity', 'get_payslip', 'escalate_to_hr', 'again', 'done'];
  w.add({ name: 'Route: Which Tool?', type: 'n8n-nodes-base.switch', typeVersion: 3.2, position: [2600, -20],
          parameters: { rules: { values: ways.map(k => ({ outputKey: k, renameOutput: true,
            conditions: { options: { caseSensitive: true, leftValue: '', typeValidation: 'loose', version: 2 },
                          conditions: [{ id: uuidOf('which-tool-' + k), leftValue: '={{ $json.next }}', rightValue: k,
                                         operator: { type: 'string', operation: 'equals' } }], combinator: 'and' } })) }, options: {} } });
  const tool = (name, fn, y) => w.add(pg(name, b64sql(`salary.${fn}($1::uuid, $JSON)`), `={{ [ ${CONV}, $json.b64_args ] }}`,
                                        [2850, y], { alwaysOutputData: true, onError: 'continueRegularOutput' }));
  tool('Tool: verify_identity', 'verify_identity', -320);
  w.add(pg('Tool: get_payslip', "select salary.get_payslip($1::uuid, convert_from(decode($2::text, 'base64'), 'UTF8')::jsonb ->> 'period') as r;",
           `={{ [ ${CONV}, $json.b64_args ] }}`, [2850, -180], { alwaysOutputData: true, onError: 'continueRegularOutput' }));
  tool('Tool: escalate_to_hr', 'escalate_to_hr', -40);
  w.add(code('Agent Tool Result', 'main/agent_tool_result.js', [3100, -180]));

  w.add(code('Prepare Reply', 'main/prepare_reply.js', [2850, 160]));
  w.add(evo('Evolution — Send Reply', 'message/sendText',
            "{ number: $('Prepare Reply').first().json.reply_to, text: $('Prepare Reply').first().json.text, delay: 600, linkPreview: false }", [3250, 160]));
  w.add(code('Record Reply', 'main/record_reply.js', [3250, 160]));
  w.add(pg('Log Reply', b64sql('salary.log_reply($JSON)').replace('$2', '$1'), '={{ [ $json.b64_log ] }}', [3450, 160]));

  // wiring
  w.chain('WhatsApp Webhook (Evolution)', 'Normalize Inbound', 'Route: A Message?');
  w.link('Route: A Message?', 'Intake', 0); w.link('Route: A Message?', 'Exit: Ignored', 1);
  w.link('Intake', 'Route: To The Agent?');
  w.link('Route: To The Agent?', 'Evolution — Typing', 0); w.link('Route: To The Agent?', 'Exit: Not For The Agent', 1);
  w.link('Evolution — Typing', 'Route: Voice Note Or Photo?');
  w.link('Route: Voice Note Or Photo?', 'Route: Fetch The File?', 0); w.link('Route: Voice Note Or Photo?', 'Wait For More Messages', 1);
  w.link('Route: Fetch The File?', 'Evolution — Fetch Media', 0); w.link('Route: Fetch The File?', 'Prepare Media', 1);
  w.link('Evolution — Fetch Media', 'Prepare Media');
  w.link('Prepare Media', 'Route: Voice Note?');
  w.link('Route: Voice Note?', 'Voice Note To File', 0); w.link('Route: Voice Note?', 'Route: Photo?', 1);
  w.chain('Voice Note To File', 'Transcribe Voice Note (OpenAI)', 'Media Understood');
  w.link('Route: Photo?', 'Look At Photo (OpenAI)', 0); w.link('Route: Photo?', 'Media Understood', 1);
  w.link('Look At Photo (OpenAI)', 'Media Understood');
  w.chain('Media Understood', 'Save What It Said', 'Wait For More Messages', 'Claim Turn', 'Route: Newest Message?');
  w.link('Route: Newest Message?', 'Evolution — Still Typing', 0); w.link('Route: Newest Message?', 'Exit: A Newer Message Answers', 1);
  w.chain('Evolution — Still Typing', 'Load Turn Context', 'Agent Request', 'Still Newest? (Before AI)', 'Route: Go On (AI)?');
  w.link('Route: Go On (AI)?', 'Agent Call (OpenAI)', 0); w.link('Route: Go On (AI)?', 'Exit: They Wrote Again', 1);
  w.chain('Agent Call (OpenAI)', 'Agent Step', 'Route: Which Tool?');
  w.link('Route: Which Tool?', 'Tool: verify_identity', 0);
  w.link('Route: Which Tool?', 'Tool: get_payslip', 1);
  w.link('Route: Which Tool?', 'Tool: escalate_to_hr', 2);
  w.link('Route: Which Tool?', 'Agent Request', 3);
  w.link('Route: Which Tool?', 'Prepare Reply', 4);
  for (const t of ['Tool: verify_identity', 'Tool: get_payslip', 'Tool: escalate_to_hr']) w.link(t, 'Agent Tool Result');
  w.link('Agent Tool Result', 'Agent Request');
  w.chain('Prepare Reply', 'Still Newest? (Before Sending)', 'Route: Go On (Send)?');
  w.link('Route: Go On (Send)?', 'Evolution — Send Reply', 0); w.link('Route: Go On (Send)?', 'Exit: They Wrote Again', 1);
  w.chain('Evolution — Send Reply', 'Record Reply', 'Log Reply');
  return w.json();
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  mkdirSync(join(ROOT, 'dist'), { recursive: true });
  const wf = buildMain();
  writeFileSync(join(ROOT, 'dist', 'everwake-salary-main.json'), JSON.stringify(wf, null, 2) + '\n');
  console.log(`dist/everwake-salary-main.json  ${wf.nodes.length} nodes · ${MODEL} (${EFFORT})`);
}
