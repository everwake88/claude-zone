// =====================================================================
// EVERWAKE SALARY — Main · NODE: Record Reply
// What went out (and whether WhatsApp took it), for salary.log_reply.
// =====================================================================
// @include shared/basics.js

const prep = $('Prepare Reply').first().json;
const res = obj($input.first().json);
const status = num(res.statusCode, res.error ? 0 : 200);
const body = obj(res.body);
const sendError = status >= 400 || res.error ? `WhatsApp send failed (${status || 'no answer'})` : null;
return [{
  json: {
    b64_log: b64({
      conversation_id: prep.conversation_id, text: prep.text, upto_message_id: prep.upto_message_id,
      external_id: str(obj(body.key).id) || null,
      error: [sendError, prep.error].filter(Boolean).join(' · ') || null
    })
  }
}];
