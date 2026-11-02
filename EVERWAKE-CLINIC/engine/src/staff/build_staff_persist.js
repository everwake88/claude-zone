// =====================================================================
// EVERWAKE CLINIC — Main · NODE: Build Staff Persist
// The staff turn's record (persist_turn), always final: a doctor's reply
// goes out even if they wrote again meanwhile.
// =====================================================================
// @include shared/basics.js

const d = $input.first().json;
const tokens = obj(d.agent_tokens);
return [{ json: { ...d, b64_persist: b64({
  tenant_id: d.tenant_id, wa_id: d.wa_id, run_id: d.run_id, final: true,
  state_patch: { last_turn_at: new Date().toISOString(), last_language: obj(d.decision).language || null },
  log_row: { stage: 'staff_turn', booking_stage: 'staff', qa_passed: !arr(d.violations).length, llm_calls: 1,
             duration_total_ms: Date.now() - new Date(d.turn_started_at).getTime(),
             prompt_tokens: Number(tokens.promptTokens || 0), completion_tokens: Number(tokens.completionTokens || 0),
             input: { message: d.customer_message }, output: { messages: arr(obj(d.decision).reply_messages), tool_calls: d.tool_calls,
                                                               violations: d.violations, agent_error: d.agent_error } } }) } }];
