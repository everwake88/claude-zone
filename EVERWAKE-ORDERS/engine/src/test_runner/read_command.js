// =====================================================================
// EVERWAKE — Test Runner · NODE: Read Test Command
// Chat with a restaurant's agent as a pretend customer. The real Main
// workflow answers; nothing is sent on WhatsApp.
//
//   any text                 a customer message
//   /reset   (ريست)          forget the test chat: a brand-new customer
//   /last    (آخر)           show the latest turn again, sending nothing
//   /later 5 <message>       5 hours pass first (بعد 5 …), then the message
//   /pin 31.2,29.9 [text]    a location pin (لوكيشن), with or without text
//   #2 <message>             a second pretend customer (#1 … #99)
//   @gleem <message>         another restaurant, by its slug
// =====================================================================
const RESTAURANT = 'seagull';      // the slug (or English name) of the restaurant to test
const NAME = 'تجربة';              // the WhatsApp profile name the agent sees

let raw = String($input.first().json.chatInput ?? '').trim();
let restaurant = RESTAURANT, n = 1;
let m;
if ((m = raw.match(/^@(\S+)\s*([\s\S]*)$/))) { restaurant = m[1]; raw = m[2].trim(); }
if ((m = raw.match(/^#(\d{1,2})\s*([\s\S]*)$/))) { n = Math.min(Math.max(Number(m[1]), 1), 99); raw = m[2].trim(); }

const later = raw.match(/^\/(?:later|بعد)\s+(\d+(?:\.\d+)?)\s*([\s\S]*)$/i);
if (later) raw = later[2].trim();
const reset = /^\/?(reset|ريست)$/i.test(raw);
const last = /^\/(last|آخر)$/i.test(raw);
const pin = raw.match(/^\/(?:pin|لوكيشن)\s+(-?\d+(?:\.\d+)?)\s*[,،\s]\s*(-?\d+(?:\.\d+)?)\s*([\s\S]*)$/i);
const text = pin ? pin[3].trim() : (reset || last ? '' : raw);

return [{
  json: {
    restaurant,
    wa_id: '2000000000' + String(n).padStart(2, '0'),
    push_name: NAME + (n > 1 ? ' ' + n : ''),
    text,
    location: pin ? { lat: Number(pin[1]), lng: Number(pin[2]) } : null,
    reset,
    last,
    later_hours: later ? Number(later[1]) : 0,
    empty: !reset && !last && !text && !pin
  }
}];
