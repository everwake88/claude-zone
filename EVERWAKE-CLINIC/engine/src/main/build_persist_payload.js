// =====================================================================
// EVERWAKE CLINIC — Main · NODE: Build Persist Payload
// The booking is written by manage_booking. This write is the turn's own
// record: memory notes, a handoff, questions for the doctor, the alert for
// an urgent or emergency message (a red flag found in code, or the Brain's
// urgency), telemetry, unlock and buffer cleanup.
// =====================================================================
// @include shared/basics.js

const d = $input.first().json;
let state = {};
try { state = obj(row($('Read Back State').first().json).state); } catch (e) { state = {}; }
const nowIso = new Date().toISOString();
const dec = obj(d.decision);
const brain = obj(d.brain);
const stage = d.booked_ref ? 'booked' : d.moved_ref ? 'moved' : d.cancelled_ref ? 'cancelled' : d.confirmed_ref ? 'confirmed'
  : (str(brain.stage) || 'conversation');

const statePatch = { last_turn_at: nowIso, phase: stage, last_language: dec.language || null };
const note = str(dec.memory_note);
if (note) statePatch.memory_notes = arr(state.memory_notes).concat([note.slice(0, 220)]).slice(-12);
const handoff = obj(dec.handoff);
if (handoff.needed) statePatch.handoff = { needed: true, reason: str(handoff.reason), at: nowIso };
// a reminder or a delay answered: the tool cleared them; an offer or a plan answered by a booking is done too
if (d.booked_ref) { statePatch.pending_offer = null; statePatch.pending_reschedule = null; statePatch.pending_plan_session = null; }

// an alert for the dashboard: the red flag found in code wins; the Brain's urgency otherwise
const red = obj(d.triage);
const topMatch = obj(arr(red.matches)[0]);
const alert = d.urgency ? {
  kind: d.urgency, severity: d.urgency === 'emergency' ? 'critical' : 'high',
  specialty: topMatch.specialty || undefined,
  body: str(d.customer_message).slice(0, 500),
  data: { matches: arr(red.matches).slice(0, 4), brain: obj(brain.urgency), run_id: d.run_id }
} : null;

const tokens = obj(d.agent_tokens);
const durationTotal = Date.now() - new Date(d.turn_started_at).getTime();
const logRow = {
  stage: 'turn_complete', booking_stage: stage,
  tool_action: arr(d.tool_calls).map(c => c.asked && (String(c.asked).match(/"action"\s*:\s*"(\w+)"/) || [])[1]).filter(Boolean).join(',') || null,
  qa_passed: !arr(d.violations).length, repair_used: d.repair_used === true,
  llm_calls: (brain.used ? 1 : 0) + 1 + arr(d.tools_used).length,
  duration_total_ms: durationTotal,
  duration_llm_ms: d.agent_started_at ? Date.now() - new Date(d.agent_started_at).getTime() : 0,
  prompt_tokens: Number(tokens.promptTokens || 0), completion_tokens: Number(tokens.completionTokens || 0),
  input: { message: d.customer_message, buffered_count: d.buffered_count, dates: obj(d.dates).args, triage: red.level || null },
  output: { messages: arr(dec.reply_messages), brain: d.brain || null, tools_used: arr(d.tools_used), tool_calls: arr(d.tool_calls).slice(0, 10),
            tool_problems: arr(d.tool_problems).slice(0, 10), agent_error: d.agent_error || null, violations: arr(d.violations),
            repair_source: d.repair_source || null, booked_ref: d.booked_ref || null, urgency: d.urgency || null,
            handoff, ask_team: arr(dec.ask_team), brief_chars: d.brief_chars, agent_prompt_chars: d.agent_prompt_chars }
};

return [{
  json: {
    ...d,
    b64_persist: b64({
      tenant_id: d.tenant_id, wa_id: d.wa_id, run_id: d.run_id,
      state_patch: Object.fromEntries(Object.entries(statePatch).filter(([, v]) => v !== undefined)),
      ledger_patch: { last_reply_at: nowIso }, log_row: logRow,
      // something final happened this turn: its reply goes out even if the patient has written again
      final: !!d.final || !!d.urgency,
      handoff: { needed: !!handoff.needed, reason: str(handoff.reason) },
      ask_team: arr(dec.ask_team),
      answers_told: arr(dec.reply_messages).length && d.repair_source !== 'fallback' ? arr(d.team_answers_new) : [],
      alert, language: dec.language || null
    }),
    duration_total_ms: durationTotal
  }
}];
