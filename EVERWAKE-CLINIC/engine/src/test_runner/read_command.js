// =====================================================================
// EVERWAKE CLINIC — Test Runner · NODE: Read Test Command
// Chat with a clinic's assistant as a pretend patient. The real Main
// workflow answers; nothing is sent on WhatsApp.
//
//   any text                 a patient's message
//   /reset   (ريست)          forget the test chat: a brand-new patient
//   /last    (آخر)           show the latest turn again, sending nothing
//   /later 5 <message>       5 hours pass first, then the message
//   #2 <message>             a second pretend patient (#1 … #99)
//   @slug <message>          another clinic, by its slug
// =====================================================================
const CLINIC = 'nile_clinics';     // the slug of the clinic to test
const NAME = 'تجربة';

let raw = String($input.first().json.chatInput ?? '').trim();
let clinicSlug = CLINIC, n = 1, m;
if ((m = raw.match(/^@(\S+)\s*([\s\S]*)$/))) { clinicSlug = m[1]; raw = m[2].trim(); }
if ((m = raw.match(/^#(\d{1,2})\s*([\s\S]*)$/))) { n = Math.min(Math.max(Number(m[1]), 1), 99); raw = m[2].trim(); }
const later = raw.match(/^\/(?:later|بعد)\s+(\d+(?:\.\d+)?)\s*([\s\S]*)$/i);
if (later) raw = later[2].trim();
const reset = /^\/?(reset|ريست)$/i.test(raw);
const last = /^\/(last|آخر)$/i.test(raw);
return [{ json: { restaurant: clinicSlug, clinic: clinicSlug, wa_id: '2000000000' + String(n).padStart(2, '0'),
                  push_name: NAME + (n > 1 ? ' ' + n : ''), text: reset || last ? '' : raw, location: null, reset, last,
                  later_hours: later ? Number(later[1]) : 0, empty: !reset && !last && !raw } }];
