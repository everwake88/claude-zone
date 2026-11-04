// =====================================================================
// EVERWAKE — Main · NODE: Details By Code — Reply
// Code saved what the customer answered (through the same checks as the
// agent's save_customer_details). Now: the next missing detail is asked
// in a short, natural line — or, when something needs judgement (a detail
// refused, an address outside the zones, a branch to choose) or nothing
// is missing any more (the summary comes next), the AI takes this turn
// with everything up to date (ai_again).
// =====================================================================
// @include shared/basics.js

const r = $('Route Without AI').first().json;
const ctx = row($('Load Turn Context').first().json);
let res = {};
try { res = JSON.parse(str(obj($input.first().json).response) || '{}'); } catch (e) { res = {}; }
const state = obj(ctx.state);
const lang = str(state.last_language) === 'en' ? 'en' : 'ar';
const missing = arr(res.still_missing_for_order).map(str);
const area = obj(res.delivery_area);
const pick = (xs) => xs[Math.floor(Math.random() * xs.length)];
const again = (why) => [{ json: { ...r, ai_again: true, ai_again_reason: why } }];

if (res.status !== 'SAVED' || arr(res.rejected).length) return again('a detail was not accepted');
if (area.status && area.status !== 'INSIDE_A_ZONE') return again('the delivery area needs a word');
if (area.status === 'INSIDE_A_ZONE' && area.branch_is_the_chosen_one === false) return again('another branch delivers there');
if (!missing.length) return again('details complete: the summary is next');

// the next thing to ask, in the order a person asks it
const GROUP = { delivery_method: 'delivery_or_pickup', address_street: 'address', address_building: 'address', address_floor: 'address',
                address_apartment: 'address', address_area: 'address', address_city: 'address', confirm_pin_address: 'address_ok',
                full_name: 'name', phone_confirmed: 'phone', phone: 'phone', payment_method: 'payment' };
if (missing.some(f => !GROUP[f])) return again('something only the AI can ask: ' + missing.filter(f => !GROUP[f]).join(', '));
const ORDER = ['delivery_or_pickup', 'address', 'address_ok', 'name', 'phone', 'payment'];
const next = ORDER.find(g => missing.some(f => GROUP[f] === g));

// the branch's ways to pay, as words
const all = obj(ctx.all_lookup);
const branchId = str(obj(state.branch).id);
const branch = arr(all.branches).find(b => str(b.id) === branchId);
const methods = arr((branch && arr(branch.payment_methods).length ? branch.payment_methods : obj(all.settings).payment_methods) || ['cash']);
const PAY = lang === 'en'
  ? { cash: 'cash', card: 'card on delivery', wallet: 'mobile wallet', instapay: 'InstaPay', online: 'online (a payment link)' }
  : { cash: 'كاش', card: 'كارت عند الاستلام', wallet: 'محفظة موبايل', instapay: 'إنستاباي', online: 'أونلاين (لينك دفع)' };
const payList = methods.map(m => PAY[m] || m).join(lang === 'en' ? ', ' : ' أو ');
const det = obj(res.details_on_file);
const pinAddress = [det.address_street, det.address_area].map(str).filter(Boolean).join('، ');
const parts = missing.filter(f => GROUP[f] === 'address').map(f => (lang === 'en'
  ? { address_street: 'the street', address_building: 'the building no.', address_floor: 'the floor', address_apartment: 'the apartment', address_area: 'the area', address_city: 'the city' }
  : { address_street: 'الشارع', address_building: 'رقم العمارة', address_floor: 'الدور', address_apartment: 'الشقة', address_area: 'المنطقة', address_city: 'المدينة' })[f]);
const join = (xs) => xs.length < 2 ? xs.join('') : xs.slice(0, -1).join(lang === 'en' ? ', ' : '، ') + (lang === 'en' ? ' and ' : ' و') + xs[xs.length - 1];

const ok = lang === 'en' ? pick(['Got it 👍', 'Perfect.', 'Great.']) : pick(['تمام 👍', 'تمام،', 'حلو،', 'تمام كده،']);
const ASK = lang === 'en' ? {
  delivery_or_pickup: 'Delivery, or will you pick it up from the branch?',
  address: `What's ${join(parts)}?`,
  address_ok: `The address from your location: ${pinAddress || 'your pin'}. Is that right?`,
  name: pick(['What name should I put the order under?', "What's your name?"]),
  phone: 'Shall we call you on this same number? If it\'s another one, just send it.',
  payment: `How would you like to pay? ${payList}`
} : {
  delivery_or_pickup: 'توصيل ولا هتستلم من الفرع؟',
  address: `ابعتلي ${join(parts)} لو سمحت`,
  address_ok: `العنوان اللي وصلني من اللوكيشن: ${pinAddress || 'مكان الدبوس'}. كده مظبوط؟`,
  name: pick(['الاسم إيه؟', 'اسم حضرتك إيه؟', 'أكتب الطلب باسم مين؟']),
  phone: 'هنكلم حضرتك على نفس الرقم ده؟ ولو في رقم تاني ابعتهولي',
  payment: `هتدفع إزاي؟ ${payList}`
};
const text = `${ok} ${ASK[next]}`.trim();

return [{
  json: {
    ...r,
    ai_again: false,
    decision: { reply_messages: [text], send_menu_images: false, send_item_photos: [], showed_order_summary: false,
                handoff: { needed: false, reason: '' }, ask_team: [], language: lang, memory_note: '' },
    details_awaiting: [next],
    missing_details: missing,
    cart_items_after: arr(obj(obj(ctx.active_order).cart).items).length,
    pending_after: 0,
    branch_after: branchId || null,
    tools_used: ['save_customer_details'],
    tool_calls: [{ tool: 'save_customer_details', by: 'code', details: r.details_by_code }]
  }
}];
