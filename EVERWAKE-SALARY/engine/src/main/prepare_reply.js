// =====================================================================
// EVERWAKE SALARY — Main · NODE: Prepare Reply
// The agent's words, made right for WhatsApp: *bold* with one asterisk, no
// Markdown headings or tables, at most 3,500 characters. No words at all
// (the AI failed) → one short apology, so nobody is left on read.
// =====================================================================
// @include shared/basics.js

const st = $input.first().json;
const intake = row($('Intake').first().json);
let text = str(st.text)
  .replace(/\*\*(.+?)\*\*/g, '*$1*')
  .replace(/__(.+?)__/g, '_$1_')
  .replace(/^#{1,6}\s+/gm, '')
  .replace(/^\s*\|.*\|\s*$/gm, (l) => l.replace(/^\s*\|\s*|\s*\|\s*$/g, '').split(/\s*\|\s*/).join(' — '))
  .replace(/^\s*[-—]{3,}\s*$/gm, '')
  .replace(/\n{3,}/g, '\n\n')
  .trim();
const failed = !text;
if (failed) text = 'معلش، حصلت مشكلة عندي وأنا بجهز الرد 🙏 ابعتلي رسالتك تاني كمان دقيقة.';
if (text.length > 3500) text = text.slice(0, 3500).replace(/\s+\S*$/, '') + ' …';

const ch = obj(intake.channel);
return [{
  json: {
    text, failed, error: st.error || null,
    base_url: str(ch.base_url), instance: str(ch.instance), api_key: str(ch.api_key),
    reply_to: str(intake.reply_to),
    conversation_id: str(intake.conversation_id),
    upto_message_id: String(intake.message_id || '')
  }
}];
