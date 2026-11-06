// =====================================================================
// EVERWAKE — Main · NODE: Agent Tool Result
// What the tool workflow answered goes back to the model as the call's
// output, and into the turn's steps (Check Reply reads them as before).
// A tool that failed answers {"error": …}, so the model corrects itself.
// =====================================================================
// @include shared/basics.js

const st = $('Agent Step').first().json;
const loop = obj(st.agent_loop);
const res = obj($input.first().json);
let observation;
if (typeof res.response === 'string' && res.response) observation = res.response;
else if (res.error != null && res.status == null) observation = JSON.stringify({ error: str(obj(res.error).message || res.error).slice(0, 500) || 'the tool failed' });
else if (!Object.keys(res).length) observation = JSON.stringify({ error: 'the tool gave no answer' });
else observation = JSON.stringify(res);

return [{
  json: {
    agent_loop: {
      ...loop,
      input: arr(loop.input).concat([{ type: 'function_call_output', call_id: st.call_id, output: observation }]),
      steps: arr(loop.steps).concat([{ action: { tool: st.next, toolInput: st.tool_args }, observation }])
    }
  }
}];
