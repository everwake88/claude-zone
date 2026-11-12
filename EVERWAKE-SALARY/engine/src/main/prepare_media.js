// =====================================================================
// EVERWAKE SALARY — Main · NODE: Prepare Media
// An employee's voice note or photo, ready for the model that understands
// it: the file (from the webhook, or fetched from Evolution), the
// transcription request for a voice note, the vision request for a photo.
// A photo is often the national ID card: the vision prompt copies the name
// and the 14 digits exactly, so verify_identity can check them.
// =====================================================================
// @include shared/basics.js

const norm = $('Normalize Inbound').first().json;
const fetched = obj(obj($input.first().json).body);
const media = obj(norm.media);
const file64 = str(norm.media_b64) || str(fetched.base64);
const mime = (str(fetched.mimetype) || str(media.mime) || (media.kind === 'image' ? 'image/jpeg' : 'audio/ogg')).split(';')[0].trim();
const ext = { 'audio/ogg': 'ogg', 'audio/mpeg': 'mp3', 'audio/mp4': 'm4a', 'audio/aac': 'm4a', 'audio/amr': 'amr', 'audio/webm': 'webm',
              'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' }[mime] || (media.kind === 'image' ? 'jpg' : 'ogg');

const VISION = `An employee sent this picture to their company's HR assistant on WhatsApp, usually to ask about their salary. In one to four short English sentences, say what it shows that matters:
- an Egyptian national ID card (front): copy the full name exactly as printed, in Arabic, and the 14-digit national ID number in Western digits. If any digit is unclear, say which position.
- a payslip, a salary or bank-transfer screenshot, a bank SMS: copy the month, the amounts and their labels exactly.
- an attendance sheet, a KPI report, a sick note or a permission: what it is, the dates and the key numbers.
- anything else: what it is, plainly.
Copy written text exactly and never guess text you cannot read. Describe only — no advice and no reply to the employee.`;

return [{
  json: {
    kind: media.kind === 'image' ? 'image' : 'audio',
    ok: file64.length > 100,
    b64: file64,
    mime,
    file_name: `${media.kind === 'image' ? 'photo' : 'voice'}.${ext}`,
    seconds: media.seconds || null,
    caption: str(norm.caption),
    transcribe_model: '__TRANSCRIBE_MODEL__',
    transcribe_prompt: 'A WhatsApp voice note from an employee in Egypt to the HR assistant, usually in Egyptian Arabic: salary, deductions, KPI, incentives, absence, lateness, full names, national ID numbers, work IDs, phone numbers. Write numbers as digits.',
    vision_body: media.kind === 'image' && file64 ? {
      model: '__VISION_MODEL__',
      messages: [
        { role: 'system', content: VISION },
        { role: 'user', content: [
          { type: 'text', text: str(norm.caption) ? `They wrote with it: "${str(norm.caption)}"` : 'They sent it without text.' },
          { type: 'image_url', image_url: { url: `data:${mime};base64,${file64}` } }
        ] }
      ],
      max_completion_tokens: 2000,
      reasoning_effort: '__VISION_EFFORT__'
    } : null
  }
}];
