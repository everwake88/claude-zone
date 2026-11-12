// =====================================================================
// EVERWAKE SALARY — Main · NODE: Media Understood
// What the voice note said or the photo showed, in the words the agent
// reads: [voice note: «…»] or [photo: …] (their caption stays with it).
// A file that could not be fetched or understood says so plainly, so the
// agent asks them to type it instead of guessing.
// =====================================================================
// @include shared/basics.js

const prep = $('Prepare Media').first().json;
const r = obj($input.first().json);
let text;
if (prep.kind === 'audio') {
  const heard = prep.ok ? str(r.text) : '';
  text = heard ? `[voice note${prep.seconds ? ` (${prep.seconds}s)` : ''}: «${heard.slice(0, 2000)}»]` : '[voice note — it could not be played]';
} else {
  const seen = prep.ok ? str(obj(obj(arr(r.choices)[0]).message).content).replace(/\s+/g, ' ') : '';
  text = (seen ? `[photo: ${seen.slice(0, 1500)}]` : '[photo — it could not be opened]') + (prep.caption ? ' ' + prep.caption : '');
}
return [{ json: { text, b64_media: b64({ message_id: String(row($('Intake').first().json).message_id || ''), text }) } }];
