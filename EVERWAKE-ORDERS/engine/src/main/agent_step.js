// =====================================================================
// EVERWAKE — Main · NODE: Agent Step
// Reads one round's answer: records its exact usage, then either
//   · a tool call → next = that tool (Route: Which Tool? runs it), or
//   · the reply   → next = done (Agent puts the turn's result together).
// One tool call per round (parallel_tool_calls is off); any extra call
// is answered "one at a time" so the model makes it again on its own.
// A failed call, a cut-off answer or a tenth round ends the loop with
// what it has — Check Reply then sends nothing it can't stand behind.
// =====================================================================
// @include shared/basics.js
// @include shared/openai.js

const MAX_ROUNDS = 10;
const TOOLS = ['manage_cart', 'save_customer_details', 'manage_reservation'];
const req = $('Agent Request').first().json;
const loop = obj(req.agent_loop);
const answer = openaiAnswer($input.first().json);
const calls = arr(loop.calls).concat([{ ...aiCall('agent', 'responses', obj(req.body).model, answer, req.call_started_at),
                                         effort: obj(obj(req.body).reasoning).effort || null }]);
const round = num(loop.round) + 1;
const output = arr(answer.body.output);
const fcs = output.filter(o => obj(o).type === 'function_call');

const done = (text, error) => [{ json: { next: 'done', text, ...(error ? { error } : {}), agent_loop: { ...loop, round, calls } } }];

if (answer.error) return done('', 'the AI call failed: ' + answer.error);
if (!fcs.length) {
  const text = outputText(answer.body);
  const cut = str(answer.body.status) === 'incomplete' ? str(obj(answer.body.incomplete_details).reason || 'incomplete') : '';
  return done(text, cut && !text.trim() ? 'the reply was cut off (' + cut + ')' : undefined);
}
if (round >= MAX_ROUNDS) return done(outputText(answer.body), `stopped after ${MAX_ROUNDS} rounds of tool calls`);

const first = obj(fcs[0]);
const callOut = (callId, o) => ({ type: 'function_call_output', call_id: callId, output: JSON.stringify(o) });
// the model's own items go back as they came (its encrypted thinking included)
let input = arr(loop.input).concat(output);
for (const extra of fcs.slice(1)) input.push(callOut(obj(extra).call_id, { error: 'one tool call at a time: make this call again on its own' }));

let args = obj(first.arguments);
if (typeof first.arguments === 'string') args = parseJson(first.arguments, null);
const name = str(first.name);
if (!TOOLS.includes(name) || !args || typeof args !== 'object' || Array.isArray(args)) {
  const error = TOOLS.includes(name) ? 'the arguments are not a JSON object' : `there is no tool called ${name || '(none)'}`;
  input.push(callOut(first.call_id, { error }));
  const steps = TOOLS.includes(name)
    ? arr(loop.steps).concat([{ action: { tool: name, toolInput: str(first.arguments).slice(0, 2000) }, observation: JSON.stringify({ error }) }])
    : arr(loop.steps);
  return [{ json: { next: 'again', agent_loop: { ...loop, round, calls, input, steps } } }];
}

// the same defaults the tools always had
const toolArgs = name === 'manage_cart'
  ? { action: str(args.action), branch: str(args.branch) || 'none', items: args.items === undefined || args.items === null ? [{}] : args.items }
  : name === 'manage_reservation'
    ? { action: str(args.action), details: args.details === undefined || args.details === null ? { none: true } : args.details }
    : { details: args.details === undefined || args.details === null ? {} : args.details };

return [{ json: { next: name, tool_args: toolArgs, call_id: str(first.call_id), agent_loop: { ...loop, round, calls, input } } }];
