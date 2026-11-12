// =====================================================================
// EVERWAKE SALARY — Main · NODE: Agent Step
// Reads one round's answer: a tool call → next = that tool (the Switch runs
// it), or the reply → next = done. One tool call per round; an extra call
// is answered "one at a time" so the model makes it again on its own.
// A failed call, a cut-off answer or the sixth round ends the loop with what
// it has (Prepare Reply sends a short "please write again" if that is nothing).
// =====================================================================
// @include shared/basics.js
// @include shared/openai.js

const MAX_ROUNDS = 6;
const TOOLS = ['verify_identity', 'get_payslip', 'escalate_to_hr'];
const req = $('Agent Request').first().json;
const loop = obj(req.agent_loop);
const answer = openaiAnswer($input.first().json);
const round = num(loop.round) + 1;
const output = arr(answer.body.output);
const fcs = output.filter(o => obj(o).type === 'function_call');
const done = (text, error) => [{ json: { next: 'done', text: str(text), error: error || null, agent_loop: { ...loop, round } } }];

if (answer.error) return done('', 'the AI call failed: ' + answer.error);
if (!fcs.length) {
  const text = outputText(answer.body);
  const cut = str(answer.body.status) === 'incomplete' ? str(obj(answer.body.incomplete_details).reason || 'incomplete') : '';
  return done(text, cut && !str(text) ? `the reply was cut off (${cut})` : null);
}
if (round >= MAX_ROUNDS) return done(outputText(answer.body), `stopped after ${MAX_ROUNDS} rounds of tool calls`);

const callOut = (id, o) => ({ type: 'function_call_output', call_id: id, output: JSON.stringify(o) });
const first = obj(fcs[0]);
const input = arr(loop.input).concat(output);
for (const extra of fcs.slice(1)) input.push(callOut(obj(extra).call_id, { error: 'one tool call at a time: make this call again on its own' }));

const name = str(first.name);
const args = typeof first.arguments === 'string' ? parseJson(first.arguments, null) : obj(first.arguments);
if (!TOOLS.includes(name) || !args || typeof args !== 'object' || Array.isArray(args)) {
  input.push(callOut(first.call_id, { error: TOOLS.includes(name) ? 'the arguments are not a JSON object' : `there is no tool called ${name}` }));
  return [{ json: { next: 'again', agent_loop: { ...loop, round, input } } }];
}

// what each database function receives
const toolArgs = name === 'verify_identity' ? obj(args.details)
  : name === 'get_payslip' ? { period: str(args.period) }
  : { period: str(args.period), item: str(args.item), details: str(args.details) };
return [{ json: { next: name, call_id: str(first.call_id), b64_args: b64(toolArgs),
                  period: str(args.period), agent_loop: { ...loop, round, input } } }];
