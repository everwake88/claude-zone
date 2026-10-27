// =====================================================================
// EVERWAKE — Main · NODE: Media Understood
// What the voice note said or the photo showed, in the words the agent
// reads with the customer's message: [voice note: «…»] or [photo: …]
// (their caption stays with it). A file that could not be fetched or
// understood says so plainly, so the agent asks rather than guesses.
// =====================================================================
// @include shared/basics.js

const prep = $('Prepare Media').first().json;
const r = obj($input.first().json);
let text;
if (prep.kind === 'audio') {
  const heard = prep.ok ? str(r.text).trim() : '';
  text = heard ? `[voice note${prep.seconds ? ` (${prep.seconds}s)` : ''}: «${heard.slice(0, 2000)}»]` : '[voice note — it could not be played]';
} else {
  const seen = prep.ok ? str(obj(obj(arr(r.choices)[0]).message).content).replace(/\s+/g, ' ').trim() : '';
  text = (seen ? `[photo: ${seen.slice(0, 1500)}]` : '[photo — it could not be opened]') + (prep.caption ? ' ' + prep.caption : '');
}

return [{
  json: {
    understood: text,
    failed: !prep.ok || !!r.error,
    error: r.error ? str(obj(r.error).message || r.error).slice(0, 300) : null,
    b64_media: b64({ buffer_id: prep.buffer_id, message_id: prep.message_id, marker: prep.marker, text,
                     model: prep.kind === 'audio' ? prep.transcribe_model : prep.vision_model })
  }
}];
