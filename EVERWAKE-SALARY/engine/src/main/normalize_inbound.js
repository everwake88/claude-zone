// =====================================================================
// EVERWAKE SALARY — Main · NODE: Normalize Inbound
// An Evolution API webhook → one flat shape the rest of the workflow reads.
// This node and the three "Evolution —" HTTP nodes are the only parts that
// know the provider; WhatsApp Cloud API later is a second branch here.
//   · phone and lid   WhatsApp sometimes hides the number behind a private id
//                     ("…@lid"). The number is what the identity check
//                     compares with the payroll row, so it is kept apart.
//   · from_me         typed on the company phone: logged, never answered
// A voice note or photo goes through as "[voice note]" / "[photo]" and is
// understood (transcribed / described) before the agent answers.
// Reactions, edits, deletes, receipts and groups are ignored.
// =====================================================================
// @include shared/basics.js

const payload = $input.first().json;
const body = payload.body && typeof payload.body === 'object' ? payload.body : payload;
const query = obj(payload.query);
const data = obj(body.data || body);
const key = obj(data.key);
const message = obj(data.message);
const event = str(body.event).toLowerCase();

const text = str(message.conversation || obj(message.extendedTextMessage).text || obj(message.imageMessage).caption
  || obj(message.videoMessage).caption || obj(message.documentMessage).caption
  || obj(message.buttonsResponseMessage).selectedDisplayText || obj(message.listResponseMessage).title || '');

const msgType = str(data.messageType) || Object.keys(message).filter(k => k !== 'messageContextInfo')[0] || 'conversation';
const IGNORE = ['reactionMessage', 'protocolMessage', 'editedMessage', 'senderKeyDistributionMessage', 'pollUpdateMessage'];
const isMessageEvent = !event || /messages[._]upsert/.test(event) || /send[._]message/.test(event);

const fromMe = key.fromMe === true || /send[._]message/.test(event);
const remoteJid = str(key.remoteJid);
const isGroup = /@g\.us|@broadcast|@newsletter/.test(remoteJid);
const digitsOf = (j) => str(j).replace(/@.*$/, '').replace(/:\d+$/, '').replace(/\D/g, '');
const jids = [key.remoteJid, key.remoteJidAlt, key.senderPn, data.senderPn, key.participantAlt].filter(Boolean).map(String);
const phoneJid = jids.find(j => /@(s\.whatsapp\.net|c\.us)$/.test(j)) || null;
const lidJid = jids.find(j => /@lid$/.test(j)) || null;
const phone = phoneJid ? digitsOf(phoneJid) : '';
const waId = phone || (lidJid ? digitsOf(lidJid) : digitsOf(remoteJid));
const replyTo = phone || lidJid || digitsOf(remoteJid);

const KIND = { conversation: 'text', extendedTextMessage: 'text', audioMessage: 'voice', pttMessage: 'voice',
               imageMessage: 'image', videoMessage: 'video', documentMessage: 'document', stickerMessage: 'sticker',
               locationMessage: 'location', contactMessage: 'contact' };
const kind = KIND[msgType] || 'text';
const MARK = { voice: '[voice note]', image: '[photo]', video: '[video]', document: '[file]', sticker: '[sticker]',
               location: '[location pin]', contact: '[contact card]' };
const mediaMsg = message.audioMessage || message.pttMessage || message.imageMessage || null;
const media = mediaMsg && !fromMe ? { kind: message.imageMessage ? 'image' : 'audio',
                                      mime: str(mediaMsg.mimetype) || (message.imageMessage ? 'image/jpeg' : 'audio/ogg'),
                                      seconds: num(mediaMsg.seconds) || null } : null;
const messageText = text || MARK[kind] || '';
const externalId = str(key.id) || `${waId}_${Date.now()}`;

const intake = { provider: 'evolution', token: str(query.token), instance: str(body.instance), wa_id: waId, reply_to: replyTo,
                 phone, push_name: fromMe ? null : (str(data.pushName) || null), text: messageText, kind,
                 external_id: externalId, from_me: fromMe };

return [{
  json: {
    ignorable: !isMessageEvent || IGNORE.includes(msgType) || isGroup || !waId || !messageText,
    external_id: externalId,
    caption: text,
    media,
    // Evolution can put the file in the webhook itself ("Webhook base64" on): then nothing is fetched
    media_b64: media ? (str(message.base64 || data.base64) || undefined) : undefined,
    b64_intake: b64(intake)
  }
}];
