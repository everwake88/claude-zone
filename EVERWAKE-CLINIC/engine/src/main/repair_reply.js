// =====================================================================
// EVERWAKE CLINIC — Main · NODE: Repair Reply
// Only runs when Check Reply found a hard truth broken. No model rewrites
// her words: the lines that break a rail are dropped and the rest goes
// out as she wrote it. Nothing left → one honest, warm line.
// =====================================================================
// @include shared/basics.js
// @include shared/arabic.js

const d = $input.first().json;
const r2 = (n) => Math.round(Number(n) * 100) / 100;
const allowed = new Set((d.allowed_numbers || []).map(Number));
const allowedLinks = (d.allowed_links || []).map(String);
const NOT_YET = /(?<!\p{L})(مش|لسه|لسا|لما|لو|عشان|علشان|بعد ما|أول ما|اول ما|هل|ممكن|تحب|عايز|not|once|until|will|if|when|would|can|want)(?!\p{L})|n't|\?|؟/iu;
const LEAK = /\bS\d{3,5}\b|\b[0-9a-f]{8}-[0-9a-f]{4}-|manage_booking|booking_tool|find_slots|last_offered|patient_id|ref_no|ready_for_summary|take_offer|accept_delay/i;
const BOOKED_RE = /اتحجز|تم الحجز|حجزتلك|حجزتلكم|حجزنالك|حجزنا لحضرتك|الحجز اتأكد|حجزك اتأكد|ميعادك اتأكد|you'?re booked|you are booked|booking is confirmed|appointment is (?:booked|confirmed)/i;
const DOSE = /\d+(?:\.\d+)?\s*(?:mg|مجم|ملجم|ml|مل(?![\p{L}])|cc|نقط|قرص|اقراص|أقراص|حبه|حبات)|(?:خد|خدي|اشرب|اشربي|استعمل|استعملي|take|use)\s+(?:\S+\s+){0,3}(?:مرتين|تلات مرات|3 مرات|كل\s*\d+\s*ساع|twice|three times)/iu;

function badLine(s) {
  if (LEAK.test(s)) return true;
  if (!d.booked_ref && !d.moved_ref && BOOKED_RE.test(s) && !NOT_YET.test(s)) return true;
  if (DOSE.test(toWesternDigits(s))) return true;
  for (const l of s.match(/https?:\/\/[^\s)]+/gi) || []) {
    const dom = l.toLowerCase().replace(/^https?:\/\//, '').replace(/^www\./, '');
    if (!allowedLinks.some(a => a && (dom.startsWith(a) || a.startsWith(dom)))) return true;
  }
  for (const m of toWesternDigits(s.replace(/https?:\/\/[^\s)]+/gi, ' ')).replace(/(\d),(\d{3})/g, '$1$2').match(/\d+(?:\.\d+)?/g) || []) {
    const n = Number(m);
    if (n >= 20 && !allowed.has(r2(n)) && !allowed.has(Math.round(n)) && !(m.length >= 7)) return true;
  }
  return false;
}

let source = 'lines_dropped';
let messages = arr(d.decision && d.decision.reply_messages).map(str).filter(Boolean);
const toolFailed = arr(d.violations).some(v => /^These tool calls FAILED/.test(str(v)));
if (toolFailed) { messages = []; source = 'fallback'; }
// the emergency guidance Check Reply put first always stays
const keepFirst = d.emergency && messages.length ? messages[0].split('\n\n')[0] : null;
messages = messages.map(m => m.split('\n').filter(line => line === keepFirst || !badLine(line)).join('\n').replace(/\n{3,}/g, '\n\n').trim()).filter(Boolean);
const en = str(d.decision && d.decision.language) === 'en';
if (!messages.length) {
  messages = [d.emergency ? (en ? d.emergency_text_en : d.emergency_text) : (en ? 'One moment please, let me check that for you 🙏' : 'ثانية واحدة أتأكدلك من الحتة دي 🙏')];
  source = 'fallback';
}
if (d.booked_ref && !messages.join('\n').includes(d.booked_ref)) messages[messages.length - 1] += en ? `\nBooking number: ${d.booked_ref}` : `\nرقم الحجز: ${d.booked_ref}`;
return [{ json: { ...d, decision: { ...d.decision, reply_messages: messages }, repair_used: true, repair_source: source, needs_rewrite: false } }];
