// =====================================================================
// EVERWAKE — Main · NODE: Agent
// The turn's result in the shape the rest of the turn reads (as the old
// n8n Agent gave it): the reply, every tool step, and an error if the
// loop ended badly. Plus every AI call of the turn — the planning call
// and each round — with its exact usage, for Record AI Usage.
// =====================================================================
// @include shared/basics.js

const st = $input.first().json;
const loop = obj(st.agent_loop);
let brain = null;
try { if ($('Brain Result').isExecuted) brain = obj($('Brain Result').first().json.ai_call); } catch (e) { brain = null; }
const calls = (brain && brain.step ? [brain] : []).concat(arr(loop.calls));
const sum = (k) => calls.reduce((a, c) => a + num(obj(c)[k]), 0);

return [{
  json: {
    output: str(st.text) ? st.text : (st.error ? null : ''),
    intermediateSteps: arr(loop.steps),
    ...(st.error ? { error: { message: st.error } } : {}),
    rounds: num(loop.round),
    tokenUsage: { promptTokens: sum('input'), cachedTokens: sum('cached'), completionTokens: sum('output'), reasoningTokens: sum('thinking') },
    ai_calls: calls,
    b64_usage: b64(calls)
  }
}];
