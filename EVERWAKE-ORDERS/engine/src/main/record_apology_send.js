// =====================================================================
// EVERWAKE — Main · NODE: Record Apology
// =====================================================================
// @include shared/basics.js

const item = $('Prepare Apology').first().json;
const r = $input.first().json || {};
const body = obj(r.body && typeof r.body === 'object' ? r.body : r);
const id = str(obj(body.key).id) || null;
const ok = !!id && !r.error;
return [{
  json: {
    b64_log: b64({
      tenant_id: item.tenant_id, wa_id: item.wa_id, run_id: item.run_id, sender: 'system', kind: 'text',
      body: item.text, external_id: id, ok,
      error: ok ? null : str(obj(r.error).message || r.error || 'WhatsApp did not confirm the message').slice(0, 300),
      meta: { purpose: 'pause_notice' }
    })
  }
}];
