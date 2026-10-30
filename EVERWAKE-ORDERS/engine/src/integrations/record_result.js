// =====================================================================
// EVERWAKE — Outbox · NODE: Webhook Result
// What the restaurant's system answered: 2xx is delivered; anything else
// is tried again later (1, 2, 4… minutes), then shown as failed.
// =====================================================================
// @include shared/basics.js

const sent = $('Sign Webhook').first().json;
const r = obj($input.first().json);
const code = Number(r.statusCode || 0);
const ok = code >= 200 && code < 300;
return [{ json: { b64_result: b64({ id: sent.id, ok, status_code: code || null,
                                    error: ok ? null : str(r.error && (r.error.message || r.error) || r.statusMessage || '').slice(0, 300) || null }) } }];
