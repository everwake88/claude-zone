// =====================================================================
// EVERWAKE — Main · NODE: Route Without AI
// Some messages need no thinking, and thinking costs money. Before any
// model runs, this decides — only when it is certain — that:
//  · "react": the message needs no reply ("👍", a sticker, "شكرا", "تمام"
//    when nothing is waiting): a ❤️ on it, as a person would;
//  · "details": the customer is answering the detail the last reply asked
//    for (their name, address, number, how they pay…) in a way code can read;
//    code saves it and asks the next one.
// Anything else — a question, a change to the order, doubt — goes to the
// AI exactly as before ("ai"). Each part can be switched off per restaurant
// on the developer page (ai_config).
// =====================================================================
// @include shared/basics.js

const b = $('Build Brief').first().json;
const ai = row($('Load AI Settings').first().json);   // ai_settings(tenant), read before the wait
const ctx = row($('Load Turn Context').first().json);
const norm = $('Normalize Inbound').first().json;
const state = obj(ctx.state);
const ledger = obj(state.ledger);
const activeOrder = ctx.active_order && ctx.active_order !== 'null' ? obj(ctx.active_order) : {};
const cartItems = arr(obj(activeOrder.cart).items);
const recent = arr(ctx.recent_messages);
const text = str(b.customer_message).trim();
const out = (route, extra = {}) => [{ json: { ...b, ai_settings: ai, no_ai: route, ...extra } }];

// a second pass in the same run (details saved, nothing left for code): the AI answers
let again = false;
try { again = $('Details By Code — Reply').isExecuted === true; } catch (e) { again = false; }
if (again) return out('ai');

// what has to be true for code to answer at all
const lastOut = [...recent].reverse().find(m => m.direction === 'outbound' && m.sender !== 'system');
const lastOutText = str(lastOut && lastOut.text);
const asked = /[؟?]\s*$|[؟?]/.test(lastOutText);
const pending = arr(ledger.pending_items).length > 0;
const calm = !obj(state.handoff).needed && !arr(b.team_answers_new).length && Number(b.buffered_count || 1) === 1
  && !b.reservation_in_progress && !norm.media;

// ---- 1 · a message that needs no reply ------------------------------------------------------
const ACK = /^(?:(?:شكرا|شكراً|متشكر|متشكرة|متشكرين|تسلم|تسلمي|تسلموا|ميرسي|مرسي|thanks|thank you|thx|ty|تمام|تمامم+|اوكي|أوكي|اوك|ok|okay|k|ماشي|حلو|جميل|طيب|خلاص|الله ينور|ربنا يخليك|يسلمو|يا رب|حبيبي|حبيبتي|يا باشا|يا معلم)[\s!.,،]*)+$/i;
const EMOJI_ONLY = /^[\p{Extended_Pictographic}\p{Emoji_Modifier}‍️\s❤♥]+$/u;
const ackText = text.replace(/[\p{Extended_Pictographic}‍️]/gu, '').trim();
const isAck = text.length > 0 && text.length <= 40 && (EMOJI_ONLY.test(text) || ACK.test(ackText));
const sticker = /^\[sticker\]$/i.test(text);
if (ai.react_no_reply && calm && (isAck || sticker) && !cartItems.length && !pending && !asked && norm.external_id) {
  return out('react', { decision: { reply_messages: [], reaction: '❤️', send_menu_images: false, send_item_photos: [],
                                    showed_order_summary: false, handoff: { needed: false, reason: '' }, ask_team: [],
                                    language: state.last_language || 'ar', memory_note: '' },
                        cart_items_after: 0, pending_after: 0, branch_after: b.branch_id || null });
}

// ---- 2 · the detail the last reply asked for -----------------------------------------------------
const awaiting = obj(state.details_awaiting);
const fresh = awaiting.at && (Date.now() - new Date(awaiting.at).getTime()) < 30 * 60000;
const want = arr(awaiting.fields).map(str);
const why = !ai.details_by_code ? 'details by code is off' : !calm ? 'not a calm moment' : !want.length ? 'no detail was asked'
  : !fresh ? 'asked too long ago' : !cartItems.length ? 'the cart is empty' : pending ? 'a dish waits for its choices'
  : (!text || text.length > 300) ? 'no short text' : '';
if (why) return out('ai', { no_ai_why: why });

// a question, a change to the order, a complaint, a request: the AI
// (\b does not work with Arabic letters: words are bounded by spaces and punctuation)
const NOT_A_DETAIL = /[؟?]|(?:^|[\s،,.!])(?:ليه|ازاي|إزاي|امتى|إمتى|فين|كام|بكام|ايه|إيه|هل|ممكن|عايز|عاوز|عايزة|عاوزة|محتاج|زود|زوّد|ضيف|ضيفي|شيل|شيلي|الغي|إلغي|الغاء|إلغاء|غير|غيّر|بدل|بدّل|كمان|منيو|المنيو|عرض|عروض|خصم|كوبون|متأخر|اتأخر|وحش|مشكلة|شكوى|موظف|حد يكلمني|لا|لأ|لاء|مش|no)(?=$|[\s،,.!])/i;
if (NOT_A_DETAIL.test(text)) return out('ai', { no_ai_why: 'a question or a change, not a detail' });

const YES = /^(?:ايوه|أيوه|ايوة|أيوة|ايوا|اه|آه|ااه|نعم|اكيد|أكيد|صح|مظبوط|تمام|ماشي|هو ده|هو|yes|yep|yeah|correct|right)[\s!.,،]*$/i;
const digitsOf = (s) => s.replace(/[٠-٩]/g, d => String('٠١٢٣٤٥٦٧٨٩'.indexOf(d))).replace(/[۰-۹]/g, d => String('۰۱۲۳۴۵۶۷۸۹'.indexOf(d)));
const plain = digitsOf(text);
const phoneMatch = /(?:\+?20|0)?1[0125]\d{8}/.exec(plain.replace(/[\s-]/g, ''));
const details = {};

if (want.includes('name')) {
  const words = text.split(/\s+/).filter(Boolean);
  const STOP = /^(?:انا|أنا|اسمي|إسمي|الاسم|اسمى|my|name|is|i'?m)$/i;
  const kept = words.filter(w => !STOP.test(w));
  const NOT_NAME = /^(?:ايوه|أيوه|اه|آه|نعم|تمام|ماشي|طيب|اوكي|ok|yes|كاش|فيزا|كارت|توصيل|استلام|شكرا|حاضر|اكيد|أكيد|صح)$/i;
  if (kept.length >= 1 && kept.length <= 4 && kept.every(w => /^[\p{L}'.-]{2,}$/u.test(w) && !NOT_NAME.test(w)) && !/\d/.test(text)) {
    details.full_name = kept.join(' ');
  }
}
if (want.includes('phone')) {
  if (state.contact && obj(state.contact).phone_hidden) { if (phoneMatch) details.phone = phoneMatch[0]; }
  else if (YES.test(text)) details.phone_confirmed = 'yes';
  else if (phoneMatch) { details.phone_confirmed = 'no'; details.alt_phone = phoneMatch[0]; }
}
if (want.includes('payment')) {
  if (/^[\p{L}\s]{2,30}$/u.test(text) && text.split(/\s+/).length <= 4
      && /كاش|نقد|cash|فيزا|كارت|card|visa|ماستر|ميزة|محفظ|wallet|فودافون|vodafone|اتصالات|اورنج|انستا|إنستا|instapay|اونلاين|أونلاين|online|لينك/i.test(text)) {
    details.payment_method = text;
  }
}
if (want.includes('delivery_or_pickup')) {
  if (/^(?:توصيل|دليفري|ديليفري|delivery|استلام|هستلم|تيك ?اواي|take ?away|pick ?up|pickup|من الفرع|هاجي اخده|هعدي اخده)[\s!.,،]*$/i.test(text)) details.delivery_method = text;
}
if (want.includes('address_ok') && YES.test(text)) details.address_confirmed = 'yes';
if (want.includes('address') && !YES.test(text)) {
  // an address as people write it: the building, the floor and the apartment read out; the rest is the street
  const a = plain;
  // a villa's number is its building number; "فيلا" stays with it, so no floor or flat is asked (HOUSE_RE)
  const villa = /(فيلا|فيلّا|ڤيلا|فيله|villa)\s*(?:رقم\s*)?(\d{1,5}[أ-ي]?)/i.exec(a);
  const building = villa ? [villa[0], villa[1] + ' ' + villa[2]]
    : /(?:عمارة|عماره|عمارت|برج|مبنى|بيت|بلوك|ع\.?)\s*(?:رقم\s*)?(\d{1,5}[أ-ي]?)/.exec(a);
  const floor = /(?:الدور|دور|الطابق|طابق|د\.?)\s*(\d{1,3}|الأرضي|الارضي|أرضي|ارضي|الأول|الاول|التاني|الثاني|التالت|الثالث|الرابع|الخامس|السادس|السابع|التامن|الثامن|التاسع|العاشر|الأخير|الاخير)/.exec(a);
  const apt = /(?:شقة|شقه|ش\.)\s*(?:رقم\s*)?(\d{1,5}[أ-ي]?)/.exec(a);
  const looksLikeAddress = /\d/.test(a) || /شارع|ش\s|ميدان|عمارة|عماره|برج|فيلا|الدور|شقة|شقه|جنب|قدام|بجوار|خلف|street|st\.|building|villa|floor|apt/i.test(a);
  if (looksLikeAddress && a.length >= 4) {
    if (building) details.address_building = building[1];
    if (floor) details.address_floor = floor[1];
    if (apt) details.address_apartment = apt[1];
    let rest = a;
    for (const m of [building, floor, apt]) if (m) rest = rest.replace(m[0], ' ');
    rest = rest.replace(/^[\s،,.-]+|[\s،,.-]+$/g, '').replace(/\s{2,}/g, ' ');
    const hasPin = obj(state.location).lat != null;
    if (rest.length >= 3) details[hasPin ? 'address_landmark' : 'address_street'] = rest.slice(0, 200);
    if (!hasPin && !details.address_street) delete details.address_street;
  }
}

if (!Object.keys(details).length) return out('ai', { no_ai_why: 'could not read the asked detail' });
return out('details', { details_by_code: details });
