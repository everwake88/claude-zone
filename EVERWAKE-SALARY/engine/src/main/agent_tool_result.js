// =====================================================================
// EVERWAKE SALARY — Main · NODE: Agent Tool Result
// What the database answered goes back to the model as the call's output.
// A tool that failed answers {"error": …}, so the model can say so.
// =====================================================================
// @include shared/basics.js

const st = $('Agent Step').first().json;
const loop = obj(st.agent_loop);
const res = obj($input.first().json);
const answer = res.r !== undefined ? row(res)
  : { error: str(obj(res.error).message || res.error || 'the tool gave no answer').slice(0, 300) };
return [{
  json: {
    agent_loop: { ...loop, input: arr(loop.input).concat([{ type: 'function_call_output', call_id: st.call_id, output: JSON.stringify(answer) }]) }
  }
}];
