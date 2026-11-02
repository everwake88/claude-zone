// =====================================================================
// EVERWAKE CLINIC — Main · NODE: Media Understood
// What the voice note said, or the photo / file showed, in the words the
// agent reads with the message: [voice note: «…»] · [photo: …] · [file: …]
// (their caption stays with it). A photo or a file is also kept on the
// patient's record (Save Document), tagged lab / prescription / imaging…
// A file that could not be fetched or understood says so plainly.
// =====================================================================
// @include shared/basics.js

const prep = $('Prepare Media').first().json;
const r = obj($input.first().json);
let text, docKind = null, summary = '';
if (prep.kind === 'audio') {
  const heard = prep.ok ? str(r.text).trim() : '';
  text = heard ? `[voice note${prep.seconds ? ` (${prep.seconds}s)` : ''}: «${heard.slice(0, 2000)}»]` : '[voice note — it could not be played]';
} else {
  let seen = prep.ok ? str(obj(obj(arr(r.choices)[0]).message).content).replace(/\s+/g, ' ').trim() : '';
  const tag = seen.match(/^\[(lab|prescription|imaging|photo|report|card|payment|other)\]\s*/i);
  docKind = tag ? tag[1].toLowerCase() : (prep.kind === 'document' ? 'report' : 'photo');
  if (tag) seen = seen.slice(tag[0].length);
  summary = seen;
  const label = prep.kind === 'document' ? 'file' : 'photo';
  text = (seen ? `[${label} (${docKind}): ${seen.slice(0, 1500)}]` : `[${label} — it could not be opened]`) + (prep.caption ? ' ' + prep.caption : '');
}
const keep = prep.kind !== 'audio' && prep.ok && !!summary;
const kindForRecord = { lab: 'lab', prescription: 'prescription', imaging: 'imaging', photo: 'photo', report: 'report', card: 'other',
                        payment: 'other', other: 'other' }[docKind] || 'other';

return [{
  json: {
    understood: text,
    failed: !prep.ok || !!r.error,
    error: r.error ? str(obj(r.error).message || r.error).slice(0, 300) : null,
    b64_media: b64({ buffer_id: prep.buffer_id, message_id: prep.message_id, marker: prep.marker, text,
                     model: prep.kind === 'audio' ? prep.transcribe_model : prep.vision_model }),
    // kept on the record for the doctor (an empty string → Save Document does nothing)
    b64_doc: keep ? b64({ tenant_id: prep.tenant_id, wa_id: prep.wa_id, message_id: prep.message_id, kind: kindForRecord,
                          title: prep.file_name, summary: summary.slice(0, 4000), mime: prep.mime }) : ''
  }
}];
