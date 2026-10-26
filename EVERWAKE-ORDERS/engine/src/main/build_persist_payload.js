// =====================================================================
// EVERWAKE — Main · NODE: Build Persist Payload
// The cart is written by manage_cart and the details by
// save_customer_details. This write is the turn's own record: memory
// notes, pictures sent, the review fingerprint when the summary was
// shown, a handoff and questions for the team in the inbox, telemetry,
// unlock and buffer cleanup.
// =====================================================================
// @include shared/basics.js

const d = $input.first().json;
let state = {};
try { state = obj(row($('Read Back State').first().json).state); } catch (e) { state = {}; }
const ledger = obj(state.ledger);
const nowIso = new Date().toISOString();
const dec = obj(d.decision);

const stage = d.order_placed_no ? 'placed'
  : (d.pending_after ? 'answering_choices'
  : (d.cart_items_after ? (arr(d.missing_details).length ? 'building_or_details' : 'reviewing') : 'discovery'));

const statePatch = {
  last_turn_at: nowIso,
  phase: stage,
  last_language: dec.language || null
};
const note = str(dec.memory_note);
if (note) statePatch.memory_notes = arr(state.memory_notes).concat([note.slice(0, 220)]).slice(-12);
const handoff = obj(dec.handoff);
if (handoff.needed) statePatch.handoff = { needed: true, reason: str(handoff.reason), at: nowIso };

const ledgerPatch = { last_reply_at: nowIso };
const menuKey = d.branch_after || 'all';
if (dec.send_menu_images) {
  const sent = arr(ledger.menu_sent_branches).map(str);
  if (!sent.includes(menuKey)) ledgerPatch.menu_sent_branches = sent.concat([menuKey]);
}
if (arr(dec.send_item_photos).length) {
  ledgerPatch.photos_sent = [...new Set(arr(ledger.photos_sent).map(str).concat(arr(dec.send_item_photos)))].slice(-20);
}

const tokens = obj(d.agent_tokens);
const durationTotal = Date.now() - new Date(d.turn_started_at).getTime();
const logRow = {
  order_stage: stage,
  cart_action: arr(d.tools_used).filter(t => t === 'manage_cart').length ? 'tool_call' : 'none',
  qa_passed: !arr(d.violations).length,
  repair_used: d.repair_used === true,
  llm_calls: (d.brain && d.brain.used ? 1 : 0) + 1 + arr(d.tools_used).length + (d.repair_used ? 1 : 0),
  duration_total_ms: durationTotal,
  duration_llm_ms: d.agent_started_at ? Date.now() - new Date(d.brain_started_at || d.agent_started_at).getTime() : 0,
  prompt_tokens: Number(tokens.promptTokens || 0),
  completion_tokens: Number(tokens.completionTokens || 0),
  input: { message: d.customer_message, buffered_count: d.buffered_count, has_location: d.has_location, branch: d.branch_id },
  output: {
    messages: arr(dec.reply_messages),
    brain: d.brain || null,
    tools_used: arr(d.tools_used),
    tool_problems: arr(d.tool_problems).slice(0, 10),
    tool_calls: arr(d.tool_calls).slice(0, 10),
    agent_error: d.agent_error || null,
    violations: arr(d.violations),
    repair_source: d.repair_source || null,
    order_placed_no: d.order_placed_no || null,
    showed_order_summary: !!dec.showed_order_summary,
    send_menu_images: !!dec.send_menu_images,
    send_item_photos: arr(dec.send_item_photos),
    handoff,
    ask_team: arr(dec.ask_team),
    brief_chars: d.brief_chars, agent_prompt_chars: d.agent_prompt_chars
  }
};

return [{
  json: {
    ...d,
    b64_persist: b64({
      tenant_id: d.tenant_id, wa_id: d.wa_id, run_id: d.run_id,
      state_patch: statePatch, ledger_patch: ledgerPatch, log_row: logRow,
      save_review: !!dec.showed_order_summary,
      // something final happened this turn: its reply goes out even if the customer has written again
      final: !!(d.order_placed_no || d.booking_requested_ref || d.pay_link),
      handoff: { needed: !!handoff.needed, reason: str(handoff.reason) },
      ask_team: arr(dec.ask_team),
      // the team's new answers were in this turn's FACTS: a real reply passed them on
      answers_told: arr(dec.reply_messages).length && d.repair_source !== 'fallback' ? arr(d.team_answers_new) : [],
      language: dec.language || null
    }),
    b64_media: b64({
      tenant_id: d.tenant_id, branch_id: d.branch_after || null,
      send_menu: !!dec.send_menu_images, item_codes: arr(dec.send_item_photos)
    }),
    duration_total_ms: durationTotal
  }
}];
