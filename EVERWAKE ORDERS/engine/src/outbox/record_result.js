// =====================================================================
// EVERWAKE — Outbox · NODE: Record Result
// Evolution's answer → sent, or a retry (up to 3 attempts), or failed
// with the reason the dashboard shows next to the message.
// =====================================================================
// @include shared/basics.js

const item = $('Send Loop').first().json;
const r = $input.first().json || {};
const body = obj(r.body && typeof r.body === 'object' ? r.body : r);
const id = str(obj(body.key).id) || null;
const ok = !!id && !r.error;
let error = null;
if (!ok) {
  const detail = obj(body.response).message;
  error = Array.isArray(detail) && detail.some(d => d && d.exists === false)
    ? 'This number is not on WhatsApp.'
    : str(obj(r.error).message || r.error || (detail && JSON.stringify(detail)) || body.message || 'WhatsApp (Evolution) did not confirm the message.');
}
return [{ json: { b64_result: b64({ id: item.id, ok, external_id: id, error: error ? error.slice(0, 300) : null }) } }];
