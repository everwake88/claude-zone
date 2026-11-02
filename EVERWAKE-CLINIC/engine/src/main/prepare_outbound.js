// =====================================================================
// EVERWAKE CLINIC — Main · NODE: Prepare Outbound Messages
// One item per WhatsApp message, each with the clinic's own connection:
// the text, then — after a booking — the location pin of the place.
// If a person took the conversation over (or the agent was switched off)
// while the model was thinking, nothing is sent; nor when the patient
// wrote again meanwhile (the next turn answers both).
// =====================================================================
// @include shared/basics.js

const d = $('Build Persist Payload').first().json;
const persisted = row($input.first().json);
const intake = $('Intake').first().json.r;
const dec = obj(d.decision);
if (persisted.mode === 'human' || persisted.agent_enabled === false) return [];
if (persisted.superseded === true) return [];

const channel = obj(intake.channel);
const base = { run_id: d.run_id, tenant_id: d.tenant_id, wa_id: d.wa_id, reply_to: str(intake.reply_to) || str(d.wa_id),
               base_url: str(channel.base_url), instance: str(channel.instance), api_key: str(channel.api_key) };
const out = [];
for (const text of arr(dec.reply_messages).filter(Boolean).slice(0, 2)) {
  out.push({ ...base, kind: 'text', text, log_text: text, delay_ms: Math.min(1200, Math.max(300, Math.round(text.length * 8))) });
}
const loc = obj(d.booked_location);
if (d.booked_ref && loc.lat != null && loc.lng != null) {
  out.push({ ...base, kind: 'location', lat: Number(loc.lat), lng: Number(loc.lng), place: str(loc.name),
             address: [str(loc.address), str(loc.directions)].filter(Boolean).join(' — '),
             log_text: `[location: ${str(loc.name)}]`, delay_ms: 400 });
}
return out.map((x, i) => ({ json: { ...x, index: i } }));
