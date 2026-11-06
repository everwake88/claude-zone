// =====================================================================
// EVERWAKE — Main · NODE: Brain Result
// The plan's words for Attach Plan (as the old Brain node gave them), and
// the call's exact usage for the cost record. A failed call is an empty
// plan: the Agent then decides the move herself, the turn never stalls.
// =====================================================================
// @include shared/basics.js
// @include shared/openai.js

const req = $('Brain Request').first().json;
const answer = openaiAnswer($input.first().json);
const call = aiCall('brain', 'responses', req.body.model, answer, req.brain_started_at);
const text = answer.error ? '' : outputText(answer.body);

return [{ json: { text, ...(answer.error ? { error: { message: answer.error } } : {}), ai_call: call } }];
