// =====================================================================
// EVERWAKE — Main · NODE: Record Send
// What Evolution said about one outgoing message → one row in messages,
// so the dashboard shows exactly what the customer received.
// =====================================================================
// @include shared/basics.js

const item = $('Outbound Loop').first().json;
const r = $input.first().json || {};
const body = obj(r.body && typeof r.body === 'object' ? r.body : r);
const id = str(obj(body.key).id) || null;
const ok = !!id && !r.error;
const err = ok ? null : str(obj(r.error).message || r.error || body.message || 'WhatsApp did not confirm the message').slice(0, 300);

return [{
  json: {
    b64_log: b64({
      tenant_id: item.tenant_id, wa_id: item.wa_id, run_id: item.run_id, sender: 'agent',
      kind: item.kind, body: item.kind === 'text' ? item.text : item.log_text,
      media_url: item.media_url || null, media_mime: item.mime || null,
      external_id: id, ok, error: err, meta: { caption: item.caption || undefined }
    })
  }
}];
