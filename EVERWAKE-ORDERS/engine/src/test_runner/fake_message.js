// =====================================================================
// EVERWAKE — Test Runner · NODE: Fake WhatsApp Message
// The message as Evolution would deliver it, plus test_run: Main then
// records its replies instead of sending them.
// =====================================================================
const cmd = $('Read Test Command').first().json;
const r = $input.first().json.r;
const message = cmd.location
  ? { locationMessage: { degreesLatitude: cmd.location.lat, degreesLongitude: cmd.location.lng, name: cmd.text || undefined } }
  : { conversation: cmd.text };
return [{
  json: {
    test_run: true,
    query: { token: r.token },
    body: {
      event: 'messages.upsert',
      instance: r.instance,
      data: {
        key: { remoteJid: `${r.wa_id}@s.whatsapp.net`, fromMe: false, id: 'TESTIN' + Date.now() + Math.random().toString(36).slice(2, 8) },
        pushName: cmd.push_name,
        messageType: cmd.location ? 'locationMessage' : 'conversation',
        messageTimestamp: Math.floor(Date.now() / 1000),
        message
      }
    }
  }
}];
