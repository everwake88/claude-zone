// =====================================================================
// EVERWAKE CLINIC — Main · NODE: Prepare Media
// A patient's photo, voice note or PDF, ready for the model that
// understands it: the file (from the webhook itself, or fetched from
// Evolution), the transcription request for a voice note, the vision
// request for a photo or a PDF (a lab report, a prescription, an X-ray
// report). What it says or shows replaces "[voice note]" / "[photo]" /
// "[file]" for the agent (Media Understood); a photo or a file is also
// kept on the patient's record for the doctor (Save Document).
// The model only DESCRIBES and COPIES — it never interprets a result.
// =====================================================================
// @include shared/basics.js

const norm = $('Normalize Inbound').first().json;
const intake = $('Intake').first().json.r;
const fetched = obj(obj($input.first().json).body);
const media = obj(norm.media);
const file64 = str(norm.media_b64) || str(fetched.base64);
const mime = (str(fetched.mimetype) || str(media.mime) || (media.kind === 'audio' ? 'audio/ogg' : 'image/jpeg')).split(';')[0].trim();
const ext = { 'audio/ogg': 'ogg', 'audio/mpeg': 'mp3', 'audio/mp4': 'm4a', 'audio/aac': 'm4a', 'audio/amr': 'amr', 'audio/webm': 'webm',
              'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'application/pdf': 'pdf' }[mime] || (media.kind === 'audio' ? 'ogg' : 'jpg');
const marker = str(norm.customer_message);
const caption = /^\[(photo|voice note|file)\]$/.test(marker) ? '' : marker;

const VISION = `A patient (or a parent) sent this to a medical clinic on WhatsApp. Start with ONE tag in square brackets saying what it is — [lab] a lab or test result · [prescription] a prescription or a medicine box · [imaging] an X-ray, scan or its report · [photo] a photo of the body (skin, a wound, teeth, an eye, a swelling) · [report] a medical report or a referral · [card] an insurance card or an ID · [payment] a payment screenshot · [other] anything else. Then, in one to four short English sentences, what matters for the clinic:
- a lab or test result: each test name with its value and unit exactly as printed, which are marked high or low, the lab and the date;
- a prescription or medicine: the medicine names, strengths and directions exactly as written;
- an X-ray, scan or report: what kind it is, the body part, and any written findings or impression copied exactly — never read the image yourself;
- a photo of the body: plainly where it is and what is visible (size, colour, swelling) — never name a condition;
- an insurance card, an ID or a referral: the names, numbers and company as written;
- a payment screenshot: the amount, the reference, the date;
- anything else: what it is.
Copy written text exactly and never guess text you cannot read. Describe only — no diagnosis, no advice, no reply to the patient.`;

const isDoc = media.kind === 'document' || mime === 'application/pdf';
const kind = media.kind === 'audio' ? 'audio' : (isDoc ? 'document' : 'image');
const fileName = str(media.file_name) || `${kind === 'audio' ? 'voice' : kind === 'document' ? 'file' : 'photo'}.${ext}`;

return [{
  json: {
    kind,
    ok: file64.length > 100,
    b64: file64,
    mime,
    file_name: fileName,
    seconds: media.seconds || null,
    marker,
    caption,
    buffer_id: intake.buffer_id,
    message_id: intake.message_id,
    tenant_id: intake.tenant_id,
    wa_id: intake.wa_id,
    transcribe_model: '__TRANSCRIBE_MODEL__',
    transcribe_prompt: 'A WhatsApp voice note to a medical clinic in Egypt, usually in Egyptian Arabic: booking a visit, days and times, symptoms, children\'s names and ages, medicine names, prices.',
    vision_model: '__VISION_MODEL__',
    vision_body: kind !== 'audio' && file64 ? {
      model: '__VISION_MODEL__',
      messages: [
        { role: 'system', content: VISION },
        { role: 'user', content: [
          { type: 'text', text: caption ? `They wrote with it: "${caption}"` : 'They sent it without text.' },
          kind === 'document'
            ? { type: 'file', file: { filename: fileName, file_data: `data:${mime};base64,${file64}` } }
            : { type: 'image_url', image_url: { url: `data:${mime};base64,${file64}` } }
        ] }
      ],
      max_completion_tokens: 2500,
      ...('__VISION_EFFORT__' ? { reasoning_effort: '__VISION_EFFORT__' } : {})
    } : null
  }
}];
