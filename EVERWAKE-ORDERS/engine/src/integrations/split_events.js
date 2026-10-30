// =====================================================================
// EVERWAKE — Outbox · NODE: One Webhook Per Item
// The deliveries due to the restaurants' own systems (POS / ERP / CRM):
// one item each, ready to be signed and sent.
// =====================================================================
// @include shared/basics.js

const raw = obj($input.first().json).r;
const due = Array.isArray(raw) ? raw : arr(parseJson(raw, []));
return due.map(e => ({ json: { id: e.id, url: e.url, secret: e.secret, event: e.event, body: e.body } }));
