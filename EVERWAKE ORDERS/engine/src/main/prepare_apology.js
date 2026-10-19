// =====================================================================
// EVERWAKE — Main · NODE: Prepare Apology
// The agent is switched OFF. The first message from each customer during
// the pause gets one warm apology (the restaurant's own wording, from
// Settings → Messages); everyone who wrote hears "we're back" later.
// =====================================================================
// @include shared/basics.js

const r = row($input.first().json);
const norm = $('Normalize Inbound').first().json;
const ch = obj(r.channel);
const text = str(r.apology_text);
if (!text) return [];
return [{
  json: {
    tenant_id: r.tenant_id, wa_id: r.wa_id, reply_to: str(r.reply_to) || norm.wa_id, text, run_id: norm.run_id,
    base_url: str(ch.base_url), instance: str(ch.instance), api_key: str(ch.api_key)
  }
}];
