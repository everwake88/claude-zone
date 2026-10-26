// =====================================================================
// EVERWAKE — Main · NODE: Prepare Outbound Messages
// One item per WhatsApp message, each carrying the restaurant's own
// WhatsApp connection. Pictures go FIRST (menu pages, then dish photos
// with their name and price), then the text that refers to them.
// If a person took the conversation over — or the agent was switched
// off — while the model was thinking, nothing is sent.
// =====================================================================
// @include shared/basics.js

const d = $('Build Persist Payload').first().json;
const persisted = row($('Persist Turn + Unlock').first().json);
const intake = row($('Intake').first().json);
const mediaRow = row($input.first().json);
const dec = obj(d.decision);

if (persisted.mode === 'human' || persisted.agent_enabled === false) return [];
// the customer wrote again while this reply was being thought out: it is dropped, the next turn answers both
if (persisted.superseded === true) return [];

const channel = obj(intake.channel);
const replyTo = str(intake.reply_to) || str(d.wa_id);
const sym = str(obj(obj(row($('Load Turn Context').first().json).all_lookup).tenant).currency_symbol) || 'ج';
const base = { run_id: d.run_id, tenant_id: d.tenant_id, wa_id: d.wa_id, reply_to: replyTo,
               base_url: str(channel.base_url), instance: str(channel.instance), api_key: str(channel.api_key) };
const out = [];

for (const p of arr(mediaRow.menu_pages)) {
  out.push({ ...base, kind: p.kind === 'pdf' ? 'document' : 'image', media_url: p.url,
             mime: p.mime || (p.kind === 'pdf' ? 'application/pdf' : 'image/jpeg'),
             file_name: p.file_name || (p.kind === 'pdf' ? 'menu.pdf' : 'menu.jpg'), caption: p.caption || '',
             log_text: `[menu ${p.kind === 'pdf' ? 'PDF' : 'picture'}]`, delay_ms: 400 });
}
for (const ph of arr(mediaRow.item_photos)) {
  const unit = ph.unit === 'kg' ? ' للكيلو' : '';
  out.push({ ...base, kind: 'image', media_url: ph.url, mime: ph.mime || 'image/jpeg', file_name: `${ph.code}.jpg`,
             caption: `*${ph.name}*${ph.price != null ? ` — ${fmt(ph.price)}${sym}${unit}` : ''}`,
             log_text: `[photo: ${ph.name}]`, delay_ms: 400 });
}
for (const text of arr(dec.reply_messages).filter(Boolean).slice(0, 2)) {
  out.push({ ...base, kind: 'text', text, log_text: text,
             // Evolution's own typing simulation blocks for delay_ms, so keep it short
             delay_ms: Math.min(1200, Math.max(300, Math.round(text.length * 8))) });
}
return out.map((x, i) => ({ json: { ...x, index: i } }));
