// =====================================================================
// EVERWAKE CLINIC — Main · NODE: Prepare Staff Outbound
// =====================================================================
// @include shared/basics.js

const d = $('Build Staff Persist').first().json;
const persisted = row($input.first().json);
const intake = $('Intake').first().json.r;
if (persisted.mode === 'human') return [];
const ch = obj(intake.channel);
return arr(obj(d.decision).reply_messages).slice(0, 2).map((text, i) => ({ json: {
  run_id: d.run_id, tenant_id: d.tenant_id, wa_id: d.wa_id, reply_to: str(intake.reply_to) || str(d.wa_id),
  base_url: str(ch.base_url), instance: str(ch.instance), api_key: str(ch.api_key),
  kind: 'text', text, log_text: text, delay_ms: Math.min(1200, Math.max(300, text.length * 8)), index: i } }));
