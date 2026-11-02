// =====================================================================
// EVERWAKE CLINIC — Outbox · NODE: One Item Per Message
// The claimed batch → one item per message, each with the clinic's own
// WhatsApp connection. Reminders, delay notices, staff replies, alerts to
// a doctor's own number… Nothing claimed → nothing to do.
// =====================================================================
// @include shared/basics.js

const batch = arr(parseJson(obj($input.first().json).r, []));
return batch.map(m => {
  const ch = obj(m.channel);
  const meta = obj(m.meta);
  return {
    json: {
      id: m.id, tenant_id: m.tenant_id, wa_id: m.wa_id, to: m.to, purpose: m.purpose,
      kind: ['document', 'image', 'location'].includes(m.kind) ? m.kind : 'text',
      text: str(m.body), media_url: m.media_url || null, mime: m.media_mime || (m.kind === 'document' ? 'application/pdf' : 'image/jpeg'),
      file_name: m.file_name || (m.kind === 'document' ? 'file.pdf' : 'photo.jpg'),
      lat: meta.lat ?? null, lng: meta.lng ?? null, place: str(meta.place), address: str(meta.address),
      base_url: str(ch.base_url), instance: str(ch.instance), api_key: str(ch.api_key),
      delay_ms: Math.min(1500, Math.max(400, Math.round(str(m.body).length * 8)))
    }
  };
});
