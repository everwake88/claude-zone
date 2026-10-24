// =====================================================================
// EVERWAKE — Main · NODE: Normalize Inbound
// Evolution API payload -> one flat, predictable shape (the Seagull
// contract), plus what a multi-restaurant engine needs:
//   · instance + token   → which restaurant, and proof it is Evolution
//   · phone and lid      → both identities, so a customer hidden behind a
//                          WhatsApp private id is still recognised
//   · from_me            → a message the restaurant typed on the phone
//                          itself: logged for the inbox and the agent
// Captions count as text; a voice note / photo / sticker with no text
// goes through as a bracketed marker so the agent can answer naturally.
// Reactions, edits, deletes and receipts are ignored.
// A run from the Test Runner workflow (test_run, next to the payload —
// a real webhook can't set it) is a pretend chat: Main records the
// replies but sends nothing on WhatsApp.
// =====================================================================
// @include shared/basics.js

const payload = $input.first().json;
const makeRunId = () => ['run', Date.now(), Math.random().toString(36).slice(2, 10)].join('_');

const body = payload.body && typeof payload.body === 'object' ? payload.body : payload;
const query = obj(payload.query);
const data = body.data || payload.data || body;
const key = data.key || {};
const message = data.message || {};
const event = String(body.event || payload.event || '').toLowerCase();
const instance = str(body.instance || body.instanceName || data.instance || data.instanceName || payload.instance);
const token = str(query.token || query.t || '');
const testRun = payload.test_run === true;

const text =
  message.conversation ||
  message.extendedTextMessage?.text ||
  message.imageMessage?.caption ||
  message.videoMessage?.caption ||
  message.documentMessage?.caption ||
  message.buttonsResponseMessage?.selectedDisplayText ||
  message.listResponseMessage?.title ||
  message.templateButtonReplyMessage?.selectedDisplayText ||
  data.messageText || data.text || '';

const location = message.locationMessage || message.liveLocationMessage || data.locationMessage || data.location || null;

const IGNORE = ['reactionMessage', 'protocolMessage', 'editedMessage', 'senderKeyDistributionMessage', 'pollUpdateMessage',
                'messageContextInfo'];
const msgType = data.messageType || Object.keys(message).filter(k => k !== 'messageContextInfo')[0] || 'text';
const isMessageEvent = !event || /messages[._]upsert/.test(event) || /send[._]message/.test(event);
const ignorable = IGNORE.includes(msgType) || !isMessageEvent;

const MEDIA_MARK = {
  audioMessage: '[voice note]', pttMessage: '[voice note]', imageMessage: '[photo]', videoMessage: '[video]',
  stickerMessage: '[sticker]', documentMessage: '[file]', contactMessage: '[contact card]'
};

const fromMe = Boolean(key.fromMe || data.fromMe || payload.fromMe) || /send[._]message/.test(event);
const remoteJid = String(key.remoteJid || data.remoteJid || data.from || payload.from || '');
const pushName = fromMe ? null : (data.pushName || payload.pushName || null);
const isGroup = remoteJid.includes('@g.us') || remoteJid.includes('@broadcast') || remoteJid.includes('@newsletter');

// WhatsApp often hides the phone behind a private id ("…@lid"); Evolution
// may give the real number in another field. reply_to = where a reply must
// go (the number, or the FULL "…@lid" jid); wa_id = the customer key.
const digitsOf = (j) => String(j || '').replace(/@.*$/, '').replace(/:\d+$/, '').replace(/\D/g, '');
const candidates = [key.remoteJid, key.remoteJidAlt, key.senderPn, data.senderPn, key.participantAlt, data.remoteJid, data.sender]
  .filter(Boolean).map(String);
const phoneJid = candidates.find(j => /@(s\.whatsapp\.net|c\.us)$/.test(j)) || null;
const lidJid = candidates.find(j => /@lid$/.test(j)) || null;
const phone = phoneJid ? digitsOf(phoneJid) : '';
const lid = lidJid ? digitsOf(lidJid) : '';
const waId = phone || lid || digitsOf(remoteJid);
const replyTo = phone || lidJid || digitsOf(remoteJid);
const phoneHidden = !phone && !!lid;
const messageId = key.id || data.id || data.messageId || payload.id || `${waId}_${Date.now()}`;

const lat = location?.degreesLatitude ?? location?.latitude ?? location?.lat ?? null;
const lng = location?.degreesLongitude ?? location?.longitude ?? location?.lng ?? null;
const hasLocation = lat !== null && lng !== null && Number.isFinite(Number(lat)) && Number.isFinite(Number(lng));

let customerMessage = String(text || '').trim();
if (!customerMessage && hasLocation) customerMessage = '[shared a location pin]';
if (!customerMessage && MEDIA_MARK[msgType]) customerMessage = MEDIA_MARK[msgType];

const locationObj = hasLocation ? {
  lat: Number(lat), lng: Number(lng),
  name: location?.name || null, address: location?.address || null,
  maps_url: `https://www.google.com/maps?q=${Number(lat)},${Number(lng)}`
} : null;

// keep the raw payload for support, minus media bytes and thumbnails
const slim = (v, depth = 0) => {
  if (depth > 6) return null;
  if (typeof v === 'string') return v.length > 2000 ? `[${v.length} chars]` : v;
  if (Array.isArray(v)) return v.slice(0, 20).map(x => slim(x, depth + 1));
  if (v && typeof v === 'object') {
    const o = {};
    for (const [k, x] of Object.entries(v)) {
      if (/^(base64|jpegThumbnail|thumbnail|mediaKey|fileEncSha256|fileSha256)$/i.test(k)) continue;
      o[k] = slim(x, depth + 1);
    }
    return o;
  }
  return v;
};

const intake = {
  provider: 'evolution', instance, token, external_id: messageId, wa_id: waId, reply_to: replyTo, phone, lid,
  phone_hidden: phoneHidden, push_name: pushName, text: customerMessage, message_type: hasLocation ? 'location' : msgType,
  has_location: hasLocation, location: locationObj, from_me: fromMe, test_run: testRun || undefined,
  raw: slim({ event, instance, data: { key, pushName: data.pushName, messageType: data.messageType,
                                       messageTimestamp: data.messageTimestamp, message } })
};

return [{
  json: {
    run_id: makeRunId(),
    instance,
    wa_id: waId,
    reply_to: replyTo,
    phone_hidden: phoneHidden,
    customer_name: pushName,
    customer_message: customerMessage,
    external_id: messageId,
    message_type: intake.message_type,
    from_me: fromMe,
    is_group: isGroup,
    has_location: hasLocation,
    location: locationObj,
    is_test: testRun,
    is_ignorable: ignorable || !customerMessage || isGroup || !waId || !instance,
    received_at: new Date().toISOString(),
    b64_intake: b64(intake)
  }
}];
