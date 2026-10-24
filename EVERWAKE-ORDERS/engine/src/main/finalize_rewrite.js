// =====================================================================
// EVERWAKE — Main · NODE: Finalize Rewrite
// Takes the rewrite, re-checks the same hard rails once, and if it is
// STILL broken, removes only the offending lines. No further model
// calls — this path is bounded on purpose.
// =====================================================================
// @include shared/basics.js
// @include shared/arabic.js

const d = $('Build Rewrite Request').first().json;
const res = $input.first().json || {};
const r2 = (n) => Math.round(Number(n) * 100) / 100;

let text = str(res.text ?? res.output ?? res.response ?? '');
let messages = [];
try {
  const s = text.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '');
  const a = s.indexOf('{'), z = s.lastIndexOf('}');
  const parsed = a !== -1 && z > a ? JSON.parse(s.slice(a, z + 1)) : null;
  messages = arr(parsed && parsed.reply_messages).map(str).filter(Boolean);
} catch (e) { messages = []; }
if (!messages.length && text && !/^\s*\{/.test(text)) messages = [text];
messages = messages.flatMap(m => m.split(/^\s*\[\[\s*NEXT\s*\]\]\s*$/m).map(x => x.trim()).filter(Boolean)).slice(0, 2)
  .map(m => m.replace(/\*\*(.+?)\*\*/g, '*$1*').replace(/^#{1,6}\s+/gm, '').trim());

const allowed = new Set((d.allowed_numbers || []).map(Number));
const LEAK = /\bM\d{3,5}\b|\bP\d+-M\d{3,5}\b|\b[0-9a-f]{8}-[0-9a-f]{4}-|manage_cart|save_customer_details|manage_reservation|summary_text|ref_no|pending_id|line_id|menu_id|set_branch|place_order|reorder_last|apply_code|saved_address/i;
const CLAIM = /(الأوردر|الاوردر|الطلب|طلبك|أوردرك|اوردرك)[^.؟!\n]{0,25}(اتسجل|اتأكد|تم تأكيده|تم تسجيله|اتبعت للفرع)|(تم|اتعمل)\s*(تأكيد|تسجيل)\s*(الأوردر|الاوردر|الطلب)|order\s+(is|has been|was)\s+(placed|confirmed)/i;
const allowedLinks = (d.allowed_links || []).map(String);
// the same booking rails as Check Reply: a booking sentence is not an order claim, and is never "confirmed" by the host
const BOOKING_WORDS = /(حجز|ترابيز|طاول|booking|reservation|\btable\b)/i;
const BOOKED = /(تم|اتم|اتعمل)\s*(تأكيد\s*)?(الحجز|حجزك|حجز حضرتك|حجزكم)|(الحجز|حجزك|حجز حضرتك|حجزكم|الترابيزة|ترابيزتك)\s*(اتأكد|اتأكدت|اتثبت|مؤكد|متأكد|تمام ومتأكد)|اتحجز(ت|تلك|تلكم)?(?![\u0600-\u06FF])|حجزت(لك|لكم|لكو)|حجزنا(لك|لكم|لكو)|(booking|reservation|table)\s+(is|has been|was)\s+(confirmed|booked|reserved)|(you'?re|you are)\s+(all\s+)?booked/i;
const NOT_YET = /(?<!\p{L})(مش|مو|لسه|لسا|لما|لو|عشان|علشان|بعد ما|أول ما|اول ما|not|once|until|will|pending|if|when)(?!\p{L})|(?<!\p{L})(هيت|هيأ|هيك|هير|هنت|هنأ|هنك|يأكد|يتأكد|بيأكد|للتأكيد)|n't/iu;
const PAID = /(تم|اتم)\s*(استلام\s*)?الدفع|الدفع\s*(وصل|اتم|نجح|اتسجل|اتأكد)|استلمنا\s*(الدفع|المبلغ|فلوس)|(?<![\u0600-\u06FF])(اتدفع|اندفع)(?![\u0600-\u06FF])|payment\s+(received|confirmed|went through|was successful|is complete)|(has been|is|was)\s+paid\b/i;

function badLine(s) {
  if (LEAK.test(s)) return true;
  if (!d.order_placed_no && !BOOKING_WORDS.test(s) && CLAIM.test(s)) return true;
  if (!d.booking_confirmed && BOOKED.test(s) && !NOT_YET.test(s)) return true;
  if (!d.paid_now && PAID.test(s) && !NOT_YET.test(s)) return true;
  for (const l of s.match(/https?:\/\/[^\s)]+/gi) || []) {
    const dom = l.toLowerCase().replace(/^https?:\/\//, '').replace(/^www\./, '');
    if (!allowedLinks.some(a => a && (dom.startsWith(a) || a.startsWith(dom)))) return true;
  }
  const scan = toWesternDigits(s.replace(/https?:\/\/[^\s)]+/gi, ' '));
  for (const m of scan.match(/\d+(?:\.\d+)?/g) || []) {
    const n = Number(m);
    if (n >= 20 && !allowed.has(r2(n)) && !allowed.has(Math.round(n))) return true;
  }
  return false;
}

let source = 'rewrite';
const ref = d.booking_requested_ref;
if (!messages.length) { messages = d.decision.reply_messages || []; source = 'original'; }
// last resort: drop only the lines that still break a rail
messages = messages.map(m => m.split('\n').filter(line => !badLine(line)).join('\n').replace(/\n{3,}/g, '\n\n').trim()).filter(Boolean);
if (!messages.length) {
  const en = str(d.decision && d.decision.language) === 'en';
  messages = [en ? 'One moment please, let me check that for you 🙏' : 'ثانية واحدة أتأكدلك من الحتة دي 🙏'];
  source = 'fallback';
}
if (d.pay_link && !messages.join('\n').includes(d.pay_link)) {
  const en = str(d.decision && d.decision.language) === 'en';
  messages[messages.length - 1] += en ? `\nPayment link: ${d.pay_link}` : `\nلينك الدفع: ${d.pay_link}`;
}
if (ref && !messages.join('\n').includes(ref)) {
  const en = str(d.decision && d.decision.language) === 'en';
  messages[messages.length - 1] += en ? `\nBooking reference: ${ref}` : `\nرقم طلب الحجز: ${ref}`;
}

return [{
  json: {
    ...d,
    decision: { ...d.decision, reply_messages: messages },
    repair_used: true,
    repair_source: source,
    needs_rewrite: false,
    rewrite_ms: d.rewrite_started_at ? Date.now() - new Date(d.rewrite_started_at).getTime() : 0
  }
}];
