// =====================================================================
// EVERWAKE — Main · NODE: Prepare Media
// A customer's photo or voice note, ready for the model that understands
// it: the file (from the webhook itself, or fetched from Evolution), the
// transcription request for a voice note, the vision request for a photo.
// What it says or shows replaces "[voice note]" / "[photo]" for the agent
// (Media Understood) before the turn starts.
// =====================================================================
// @include shared/basics.js

const norm = $('Normalize Inbound').first().json;
const intake = $('Intake').first().json.r;
const fetched = obj(obj($input.first().json).body);
const media = obj(norm.media);
const file64 = str(norm.media_b64) || str(fetched.base64);
const mime = (str(fetched.mimetype) || str(media.mime) || (media.kind === 'image' ? 'image/jpeg' : 'audio/ogg')).split(';')[0].trim();
const ext = { 'audio/ogg': 'ogg', 'audio/mpeg': 'mp3', 'audio/mp4': 'm4a', 'audio/aac': 'm4a', 'audio/amr': 'amr', 'audio/webm': 'webm',
              'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' }[mime] || (media.kind === 'image' ? 'jpg' : 'ogg');
// the customer's own words with it (a caption), or the marker the agent would otherwise see
const marker = str(norm.customer_message);
const caption = /^\[(photo|voice note)\]$/.test(marker) ? '' : marker;

const VISION = `A customer sent this picture to a restaurant on WhatsApp. In one to three short English sentences, say what it shows that matters for helping them:
- food or a dish: what it looks like (name the dish only when it is plainly recognisable);
- a menu, a delivery-app screenshot or a post: copy the dish names, prices and other text exactly, in their language;
- a payment or transfer screenshot: the amount, the reference, the date, and whether it says it went through;
- a map, a location or an address: the place or the address as written;
- a problem with an order (wrong, spilled, cold, missing): what is wrong;
- anything else: what it is, plainly.
Copy written text exactly and never guess text you cannot read. Describe only — no advice, no reply to the customer.`;

return [{
  json: {
    kind: media.kind === 'image' ? 'image' : 'audio',
    ok: file64.length > 100,
    b64: file64,
    mime,
    file_name: `${media.kind === 'image' ? 'photo' : 'voice'}.${ext}`,
    seconds: media.seconds || null,
    marker,
    caption,
    buffer_id: intake.buffer_id,
    message_id: intake.message_id,
    transcribe_model: '__TRANSCRIBE_MODEL__',
    transcribe_prompt: 'A WhatsApp voice note to a restaurant in Egypt, usually in Egyptian Arabic: ordering food, dishes, prices, addresses, delivery.',
    vision_model: '__VISION_MODEL__',
    vision_body: media.kind === 'image' && file64 ? {
      model: '__VISION_MODEL__',
      messages: [
        { role: 'system', content: VISION },
        { role: 'user', content: [
          { type: 'text', text: caption ? `They wrote with it: "${caption}"` : 'They sent it without text.' },
          { type: 'image_url', image_url: { url: `data:${mime};base64,${file64}` } }
        ] }
      ],
      max_completion_tokens: 2000,
      ...('__VISION_EFFORT__' ? { reasoning_effort: '__VISION_EFFORT__' } : {})
    } : null
  }
}];
