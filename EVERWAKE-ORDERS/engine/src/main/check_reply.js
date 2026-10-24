// =====================================================================
// EVERWAKE — Main · NODE: Check Reply
//
// NEVER rewrites the host's words. It only checks hard rails, and a
// broken rail sends the draft to one rewrite (no tools — nothing can be
// added to the cart twice) with the exact reason:
//   · a number that is not a real price / total / fee / detail on file
//   · saying the order is placed when place_order did not return PLACED
//   · saying a table booking is confirmed (only the branch team confirms)
//   · saying an online payment arrived before Paymob confirmed it
//   · internal codes, ids or tool names leaking to the customer
//   · a link that is not the restaurant's or the customer's own
//   · menu pictures or a dish photo promised when none is being sent
//   · far too long for WhatsApp
// Facts it may ADD without asking: the order number after a placement,
// the booking's reference after it was sent, or the payment link of an
// order just placed, when the host forgot it.
// =====================================================================
// @include shared/basics.js
// @include shared/arabic.js

const pre = $('Attach Plan').first().json;
const agent = $('Agent').first().json || {};
const ctx = row($('Load Turn Context').first().json);
const db = row($input.first().json);

const r2 = (n) => Math.round(num(n) * 100) / 100;

// ---- the decision ------------------------------------------------------------
let decision = agent.output ?? agent.response ?? agent.text ?? null;
if (decision && typeof decision === 'object' && decision.output && typeof decision.output === 'object') decision = decision.output;
// the agent writes its JSON itself (no strict parser to throw a good reply away): read it, and
// repair the usual slips — a code fence, raw line breaks inside a string, a trailing comma
function readDecision(raw) {
  const s = raw.replace(/^\s*```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim();
  const a = s.indexOf('{'), z = s.lastIndexOf('}');
  if (a === -1 || z <= a) return { reply_messages: [raw] };            // plain words: that is the reply
  const body = s.slice(a, z + 1);
  const tries = [body,
    body.replace(/,\s*([}\]])/g, '$1'),
    body.replace(/"(?:[^"\\]|\\.)*"/g, m => m.replace(/\r?\n/g, '\\n')).replace(/,\s*([}\]])/g, '$1')];
  for (const t of tries) { try { return JSON.parse(t); } catch (e) { /* next */ } }
  // last resort: the messages themselves, never the raw JSON
  const list = body.match(/"reply_messages"\s*:\s*\[([\s\S]*?)\]\s*(?:,|})/);
  const msgs = list ? (list[1].match(/"((?:[^"\\]|\\.)*)"/g) || []).map(q => q.slice(1, -1).replace(/\\n/g, '\n').replace(/\\"/g, '"')) : [];
  const flag = (k) => new RegExp(`"${k}"\\s*:\\s*true`).test(body);
  return { reply_messages: msgs, send_menu_images: flag('send_menu_images'), showed_order_summary: flag('showed_order_summary'),
           send_item_photos: [], handoff: { needed: /"needed"\s*:\s*true/.test(body), reason: '' }, language: null, memory_note: '' };
}
if (typeof decision === 'string') decision = readDecision(decision);
decision = obj(decision);

// ---- what the tools did ----------------------------------------------------------
const steps = arr(agent.intermediateSteps ?? agent.intermediate_steps);
const toolsUsed = [];
const toolCalls = [];   // for the log: what each call asked and what came back
const agentError = agent.error ? str(obj(agent.error).message || agent.error).slice(0, 300) : null;
let placedNo = null, placedTotal = null;
const toolNumbers = [];
const toolProblems = [];
const bookingTexts = [];
let bookingRef = null;
let payLink = null;
for (const st of steps) {
  const tool = str(obj(obj(st).action).tool);
  if (tool) toolsUsed.push(tool);
  let o = obj(st).observation;
  try { o = typeof o === 'string' ? JSON.parse(o) : o; } catch (e) { o = null; }
  if (Array.isArray(o)) o = o[0];
  if (o && typeof o === 'object' && o.response && typeof o.response === 'string') { try { o = JSON.parse(o.response); } catch (e) {} }
  if (tool) {
    const input = obj(obj(st).action).toolInput;
    // a call that failed: n8n hands back {"error": …} (or nothing readable) — nothing happened
    const failed = !o || typeof o !== 'object' || (o.error != null && !o.status) || obj(st).errored === true;
    const errText = failed ? str(o && typeof o === 'object' ? (obj(o.error).message || o.error || 'no answer') : 'unreadable answer').slice(0, 300) : null;
    toolCalls.push({ tool, asked: (typeof input === 'string' ? input : JSON.stringify(input ?? '')).slice(0, 300),
                     status: failed ? 'ERROR' : (str(o.status) || null), error: errText || undefined,
                     payment: !failed && o.payment && typeof o.payment === 'object'
                       ? (str(o.payment.status) || 'unknown') + (o.payment.reason ? ` (${str(o.payment.reason).slice(0, 160)})` : '') : undefined,
                     problems: !failed ? arr(o.problems).map(p => str(obj(p).code || p)).slice(0, 6) : [] });
  }
  if (!o || typeof o !== 'object') continue;
  if (tool === 'manage_reservation') {
    // the booking's day, time, guests, phone and reference are facts the host may repeat
    bookingTexts.push(JSON.stringify(o));
    if (str(o.status) === 'REQUESTED' && o.ref_no) bookingRef = str(o.ref_no);
    for (const p of arr(o.problems)) toolProblems.push(p);
    continue;
  }
  if (str(o.status) === 'PLACED' && o.order_no) { placedNo = str(o.order_no); placedTotal = o.total; }
  if (o.payment && typeof o.payment === 'object') {
    bookingTexts.push(JSON.stringify(o.payment));
    if (str(o.payment.status) === 'LINK_READY' && o.payment.link) payLink = str(o.payment.link);
  }
  for (const k of ['subtotal', 'discount_total', 'vat', 'vat_percent', 'delivery_fee', 'total', 'minimum', 'short_by'])
    if (o[k] != null) toolNumbers.push(num(o[k]));
  for (const l of arr(o.cart)) if (l && l.line_total != null) toolNumbers.push(num(l.line_total));
  for (const a of arr(o.offers_applied)) if (a && a.amount != null) toolNumbers.push(num(a.amount));
  for (const a of arr(o.offers_almost)) if (a && a.short_by != null) toolNumbers.push(num(a.short_by));
  for (const p of arr(o.problems)) { toolProblems.push(p); for (const k of ['shortfall', 'minimum', 'price']) if (p && p[k] != null) toolNumbers.push(num(p[k])); }
}

// ---- messages: split, tidy ------------------------------------------------------------
let messages = arr(decision.reply_messages ?? decision.reply_text ?? decision.messages)
  .map(x => str(x)).filter(Boolean)
  .flatMap(m => m.split(/^\s*\[\[\s*NEXT\s*\]\]\s*$/m).map(x => x.trim()).filter(Boolean));
const HEARTS = /[❣❤♥\u{1F493}-\u{1F49F}\u{1F5A4}\u{1F90D}\u{1F90E}\u{1F60D}\u{1F970}\u{1F618}\u{1F61A}\u{1F617}\u{1F619}\u{1F63B}\u{1F48B}\u{1F491}\u{1F495}]\u{FE0F}?/gu;
let heartsStripped = 0;
messages = messages.map(m => {
  heartsStripped += (m.match(HEARTS) || []).length;
  return m.replace(HEARTS, '')
    .replace(/\*\*(.+?)\*\*/g, '*$1*')           // WhatsApp bold is one asterisk
    .replace(/^#{1,6}\s+/gm, '')                  // no markdown headings
    .replace(/\[\[\s*NEXT\s*\]\]/g, '')
    .replace(/\s*[؛;](?=\s)/g, '.')                // nobody types a semicolon on WhatsApp
    .replace(/(^|[\s،.؟!(])هل\s+/g, '$1')           // "هل الطلب دليفري؟" is MSA: Egyptians ask "الطلب دليفري؟"
    .replace(/(?<!\p{L})(?:اسمه|اسمها) حضرتك/gu, 'اسم حضرتك')   // "اسمه حضرتك إيه؟" → "اسم حضرتك إيه؟"
    .replace(/(?<!\p{L})(?:اسمه|اسمها)(?= (?:صوص|مشوي|مقلي|حجم|صغير|كبير|سادة|حار|بالصوص)(?!\p{L}))/gu, 'تحبه')   // "اسمه صوص أحمر ولا أبيض؟" → "تحبه صوص…"
    // "حلو يا عبدالرحمن 😊" opening a reply sounds scripted: drop the filler + name, keep the content
    .replace(/^(?:حلو|حلوة|تمام|ماشي|جميل|اوكي|أوكي|طيب|عظيم)\s+يا\s+(?!فندم)[^\s،,.!؟\n]+[،,!.]?\s*(?:[😊👌🙏✅]\uFE0F?\s*)?(?=\S)/u, '')
    .replace(/(\d{1,2}(?::\d{2})?)\s*مساءً?(?![\u0600-\u06FF])/g, '$1 بالليل')
    .replace(/(\d{1,2}(?::\d{2})?)\s*صباحاً?(?![\u0600-\u06FF])/g, '$1 الصبح')
    .replace(/[ \t]{2,}/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
}).filter(Boolean);
if (messages.length > 2) messages = [messages[0], messages.slice(1).join('\n\n')];
// the same filler opening two replies in a row reads like a script: drop it the second time
{
  const OPENERS = /^(حلو|تمام|ماشي|أكيد|اكيد|تحت أمرك|على عيني|جميل|طيب)(?=[\s،,!.😊👌🙏])[\s،,!.]*/u;
  const lastOut = arr(ctx.recent_messages).filter(m => m.direction === 'outbound').map(m => str(m.text || m.body)).pop() || '';
  const prev = (lastOut.trim().match(OPENERS) || [])[1];
  const now = messages.length ? (messages[0].match(OPENERS) || [])[1] : null;
  if (prev && now && prev === now && messages[0].replace(OPENERS, '').trim()) messages[0] = messages[0].replace(OPENERS, '').trim();
}
// an English reply says EGP 30, not 30ج
messages = messages.map(m => /[\u0600-\u06FF]/.test(m.replace(/(\d)\s*ج(?![\u0600-\u06FF])/g, '$1'))
  ? m : m.replace(/(\d[\d,.]*)\s*ج(?![\u0600-\u06FF])/g, 'EGP $1'));

// ---- facts after the tools ---------------------------------------------------------------
const state = obj(db.state);
const ledger = obj(state.ledger);
const location = obj(state.location);
const zone = obj(state.zone);
const order = db.active_order && db.active_order !== 'null' ? obj(db.active_order) : {};
const items = arr(obj(order.cart).items);
const pending = arr(ledger.pending_items);
const branchLookup = obj(db.branch_lookup);
const allLookup = obj(ctx.all_lookup);
const settings = obj(allLookup.settings);
const profile = obj(allLookup.profile);
const media = obj(allLookup.media);
const branchId = str(obj(state.branch).id);

// ---- numbers the host may say ------------------------------------------------------------
const allowed = new Set();
const add = (n) => { if (Number.isFinite(n)) { allowed.add(r2(n)); allowed.add(Math.round(n)); } };
const addDigits = (s) => { for (const m of toWesternDigits(s).match(/\d+(?:\.\d+)?/g) || []) add(Number(m)); };
const KG_STEPS = []; for (let q = 0.25; q <= 10.001; q += 0.25) KG_STEPS.push(Math.round(q * 100) / 100);
for (const e of Object.values(obj(branchLookup.items))) {
  const p = num(e.price, NaN); if (!Number.isFinite(p)) continue;
  if (e.unit === 'kg') KG_STEPS.forEach(q => add(p * q)); else for (let q = 1; q <= 12; q++) add(p * q);
}
for (const levels of Object.values(obj(branchLookup.choices)))
  for (const L of arr(obj(levels).levels)) for (const o of arr(L.options)) add(num(o.price, NaN));
for (const e of Object.values(obj(allLookup.items))) { add(num(e.price_min, NaN)); add(num(e.price_max, NaN)); }
for (const i of items) { add(num(i.unit_price)); add(num(i.line_total)); add(num(i.base_price)); add(num(i.quantity)); }
[order.subtotal, order.discount_total, order.vat, order.delivery_fee, order.total, placedTotal].forEach(v => add(num(v, NaN)));
for (const a of arr(order.applied_offers)) add(num(a.amount, NaN));
// the order's food + VAT with the delivery fee of the area saved since the last re-price
{
  const food = num(order.subtotal, NaN) - num(order.discount_total, 0) + num(order.vat, 0);
  for (const fee of [num(zone.delivery_fee, NaN), ...arr(allLookup.zones).map(z => num(z.delivery_fee, NaN))])
    if (Number.isFinite(food) && Number.isFinite(fee)) add(food + fee);
}
toolNumbers.forEach(add);
for (const b of arr(allLookup.branches)) {
  ['delivery_fee', 'min_order', 'max_delivery_km', 'vat_percent', 'prep_minutes'].forEach(k => add(num(b[k], NaN)));
  [b.phone, b.address_ar, b.address_en, b.hours_text_ar, b.delivery_eta_text, b.price_note_ar, b.busy_reason, JSON.stringify(b.hours || {})].forEach(addDigits);
}
for (const z of arr(allLookup.zones)) ['delivery_fee', 'min_order', 'eta_min', 'eta_max'].forEach(k => add(num(z[k], NaN)));
for (const o of arr(allLookup.offers)) {
  ['value', 'max_discount', 'min_subtotal', 'free_item_qty'].forEach(k => add(num(o[k], NaN)));
  [o.title_ar, o.title_en, o.description_ar, o.description_en, o.time_from, o.time_to, o.ends_at].forEach(addDigits);
}
for (const n of arr(location.nearest)) add(num(n.km, NaN));
['delivery_fee', 'min_order', 'eta_min', 'eta_max', 'km'].forEach(k => add(num(zone[k], NaN)));
add(num(settings.max_delivery_km, NaN));
for (const v of Object.values(obj(profile.contacts))) addDigits(v);
[profile.about_ar, profile.about_en, profile.tone, profile.cuisine].forEach(addDigits);
for (const f of arr(profile.brand_facts)) addDigits(f);
for (const k of arr(allLookup.knowledge)) { addDigits(k.content_ar); addDigits(k.content_en); }
for (const o of arr(ctx.last_orders)) { add(num(o.total, NaN)); addDigits(o.order_no); for (const i of arr(o.items)) { add(num(i.line_total, NaN)); add(num(i.quantity, NaN)); } }
for (const a of arr(ctx.saved_addresses)) addDigits(a.text);
[100, 200, 250, 500, 750, 1000, 1500, 2000].forEach(add);
const textPool = [pre.customer_message, pre.history_text, JSON.stringify(state.customer || {}), str(obj(db.last_placed).order_no),
                  placedNo, pre.wa_id, JSON.stringify(ctx.last_orders || null), JSON.stringify(ctx.customer || null),
                  pre.facts_text, JSON.stringify(ctx.reservation || null), JSON.stringify(ctx.reservations_upcoming || null),
                  ...bookingTexts].map(toWesternDigits).join(' ');
for (const m of textPool.match(/\d+(?:\.\d+)?/g) || []) add(Number(m));

// ---- links the host may send ------------------------------------------------------------------
const domainOf = (u) => str(u).toLowerCase().replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/\/+$/, '');
const payLinks = [payLink].concat(arr(ctx.last_orders).map(o => obj(obj(o).payment).link)).filter(Boolean);
const allowedLinks = [location.maps_url, profile.website, profile.instagram, profile.facebook, profile.tiktok, profile.google_maps_url]
  .concat(arr(allLookup.branches).map(b => b.maps_url)).concat(arr(settings.allowed_links)).concat(payLinks)
  .map(domainOf).filter(Boolean);
const mapsHosts = ['google.com/maps', 'maps.google.com', 'goo.gl/maps', 'maps.app.goo.gl'];

const violations = [];
const joined = messages.join('\n');
if (!joined) violations.push('The reply was empty — write the reply.');

// placement claim without a placement (a sentence about a table booking is judged below, not here)
const BOOKING_WORDS = /(حجز|ترابيز|طاول|booking|reservation|\btable\b)/i;
const orderText = joined.split(/(?<=[.؟?!\n])/).filter(x => !BOOKING_WORDS.test(x)).join('');
const CLAIM = /(الأوردر|الاوردر|الطلب|طلبك|طلب حضرتك|أوردرك|اوردرك)[^.؟!\n]{0,25}(اتسجل|اتأكد|تم تأكيده|تم تسجيله|اتبعت للفرع|في الطريق)|(تم|اتعمل|اتم)\s*(تأكيد|تسجيل)\s*(الأوردر|الاوردر|الطلب)|order\s+(is|has been|was)\s+(placed|confirmed|sent)/i;
if (!placedNo && CLAIM.test(orderText)) {
  const known = [str(obj(db.last_placed).order_no)].concat(arr(ctx.last_orders).map(o => str(o.order_no))).filter(Boolean);
  if (!known.some(no => joined.includes(no))) {
    violations.push('The reply says the order is placed/confirmed, but place_order did NOT return PLACED this turn. Do not claim it — say what is actually next (e.g. the summary to confirm, or what is still missing).');
  }
}

// a table booking is confirmed by the branch team, never by the host
const BOOKED = /(تم|اتم|اتعمل)\s*(تأكيد\s*)?(الحجز|حجزك|حجز حضرتك|حجزكم)|(الحجز|حجزك|حجز حضرتك|حجزكم|الترابيزة|ترابيزتك)\s*(اتأكد|اتأكدت|اتثبت|مؤكد|متأكد|تمام ومتأكد)|اتحجز(ت|تلك|تلكم)?(?![\u0600-\u06FF])|حجزت(لك|لكم|لكو)|حجزنا(لك|لكم|لكو)|(booking|reservation|table)\s+(is|has been|was)\s+(confirmed|booked|reserved)|(you'?re|you are)\s+(all\s+)?booked/i;
const NOT_YET = /(?<!\p{L})(مش|مو|لسه|لسا|لما|لو|عشان|علشان|بعد ما|أول ما|اول ما|not|once|until|will|pending|if|when)(?!\p{L})|(?<!\p{L})(هيت|هيأ|هيك|هير|هنت|هنأ|هنك|يأكد|يتأكد|بيأكد|للتأكيد)|n't/iu;
const confirmedBooking = arr(ctx.reservations_upcoming).some(x => str(obj(x).status) === 'confirmed');
if (!confirmedBooking) {
  const said = joined.split(/(?<=[.؟?!\n])/).find(x => BOOKED.test(x) && !NOT_YET.test(x));
  if (said) {
    violations.push('The reply says the table booking is booked or confirmed — it is not: ' + (bookingRef
      ? 'it was just SENT to the branch team, who will contact the customer to confirm it. Say that, with the reference number.'
      : 'only the branch team confirms a booking after it is sent. Say what is actually next.'));
  }
}

// an online payment is paid when Paymob says so (FACTS shows PAID), never before
const PAID = /(تم|اتم)\s*(استلام\s*)?الدفع|الدفع\s*(وصل|اتم|نجح|اتسجل|اتأكد)|استلمنا\s*(الدفع|المبلغ|فلوس)|(?<![\u0600-\u06FF])(اتدفع|اندفع)(?![\u0600-\u06FF])|payment\s+(received|confirmed|went through|was successful|is complete)|(has been|is|was)\s+paid\b/i;
const latest = obj(arr(ctx.last_orders)[0]);
const paidNow = !placedNo && latest.payment_status === 'paid';
if (!paidNow) {
  const said = joined.split(/(?<=[.؟?!\n])/).find(x => PAID.test(x) && !NOT_YET.test(x));
  if (said) violations.push('The reply says the payment arrived — it has not: FACTS does not show it PAID yet. Say the order is confirmed the moment the payment goes through (they get a message), and give the link again if they need it.');
}

// internal leakage
const LEAK = /\bM\d{3,5}\b|\bP\d+-M\d{3,5}\b|\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-|\bmanage_cart\b|\bsave_customer_details\b|\bpending_id\b|\bline_id\b|\bmenu_id\b|\bset_branch\b|\bplace_order\b|\breorder_last\b|\bapply_code\b|\buse_saved_address\b|\bsaved_address\b|\bitems_json\b|\bdetails_json\b|\bmanage_reservation\b|\bsummary_text\b|\bref_no\b|\bready_for_summary\b|\bjson\b|\bundefined\b|\bNaN\b|\bnull\b/i;
const leak = joined.match(LEAK);
if (leak) violations.push(`The reply shows an internal code or word ("${leak[0]}") — say it in plain words for the customer.`);

// sounding like a system, not a person (Arabic words have no \b: letters on either side end the match)
const SYSTEM_TALK = /(?<!\p{L})(لو وُجدت|لو وجدت|إن وجدت|ان وجدت|إن وُجدت|الرسوم المقررة|الخطوة الجاية|الخطوة التالية|بيانات السواق|بيانات الطيار|ظاهر عندي|ظاهرين عندي|ظاهرة عندي|مش ظاهر|مش ظاهرة|مش ظاهر له|مش ظاهر في المنيو|ظاهر في المنيو|ظاهر في منيو|ظاهرة في المنيو|ظاهرة في منيو|أضمن التسوية|بيانات سواق|بيانات تتبع|الفريق المختص|طلب نشط|المساعدة الافتراضية|الأسعار الإرشادية|التلامس العرضي|العربة|عربة التسوق|السلة|النظام|تم التسجيل|تمت الإضافة|تمت اضافة|تم الحفظ|تم إضافة|تم اضافة|أثبت الأوردر|اثبت الاوردر|أثبت الطلب|اثبت الطلب|تثبيت الطلب|تثبيت الأوردر|تثبيت الاوردر|البيانات المسجلة|رقم الواتساب المسجل)(?!\p{L})/u;
const sys = joined.match(SYSTEM_TALK);
if (sys) violations.push(`The reply sounds like a system ("${sys[1]}"). Say it the way a person at the restaurant would on WhatsApp ("الأوردر"، "طلبك"، "كده عندك…"، "أأكدلك الأوردر؟").`);
// a tool whose last call failed did nothing: the reply must not say it did
const lastCall = {};
for (const c of toolCalls) lastCall[c.tool] = c;
const failedTools = Object.values(lastCall).filter(c => c.status === 'ERROR');
if (failedTools.length && joined) {
  violations.push(`These tool calls FAILED and changed nothing: ${failedTools.map(c => `${c.tool} (${c.error})`).join('; ')}. `
    + `The order now has ${items.length} dish line(s)${branchId ? '' : ' and no branch is set'}. Do not say or imply that anything from those calls was added, set or saved, and don't repeat their order back as if it went in. `
    + 'Say warmly in one line that you are sorting one small thing out and will confirm in a moment, or ask the one thing still needed.');
}
// "معاكي" to Ahmed: the customer is "you" in the masculine unless their own words show a woman
const FEM_YOU = /(?<!\p{L})(معاكي|ليكي|عليكي|عندكي|بيكي|ليكِ|تحبي|تحبّي|عايزاه|ابعتيلي|ابعتي|قوليلي|اكتبيلي|تأكدي|حضرتِك)(?!\p{L})/u;
const SHE_SAID = /(?<!\p{L})(عايزة|عاوزة|عايزه|عاوزه|جاية|جايه|محتاجة|مبسوطة|متأكدة|أنا ست|انا ست|مدام)(?!\p{L})/u;
// …or a clearly female name (WhatsApp name or the name they gave)
const FEMALE = new Set(('منى منة منه مريم سارة ساره نور نورا نورهان هبة هبه ياسمين فاطمة فاطمه رحاب رانيا ريهام شيماء شيما سلمى سلمي ' +
  'ندى ندي دينا داليا مي مى ميار ملك جنى جنا حبيبة حبيبه رنا هند إيمان ايمان أسماء اسماء آية ايه آيه علياء عبير نهى نها نسمة ' +
  'نسمه سماح أمل امل منار مروة مروه نرمين نيرمين يارا لمياء ليلى ليلي هالة هاله غادة غاده ولاء وفاء رشا رضوى سهى سها شهد ' +
  'mona menna mariam maryam sara sarah nour noura nourhan heba yasmin yasmeen fatma rehab rania reham shaimaa salma nada dina dalia ' +
  'mai mayar malak jana habiba rana hend eman iman asmaa aya alia abeer noha nesma samah amal manar marwa nermin yara lamia laila ' +
  'layla hala ghada walaa wafaa rasha radwa soha shahd').split(' '));
const custNames = [state.customer && state.customer.full_name, obj(ctx.customer).full_name, obj(ctx.customer).display_name,
                   $('Normalize Inbound').first().json.customer_name];
const femaleName = custNames.some(n => FEMALE.has(str(n).trim().split(/\s+/)[0].toLowerCase().replace(/^ال/, '')));
const fem = joined.match(FEM_YOU);
if (fem && !femaleName && !SHE_SAID.test([pre.customer_message, pre.history_text].map(str).join(' ')))
  violations.push(`The reply speaks to the customer in the feminine ("${fem[1]}") but nothing they wrote says they are a woman. Use the masculine ("معاك"، "ليك"، "تحب"، "ابعتلي").`);
// an empty order: help them choose first — their name, number, address details and payment come after
const ASKS_DETAILS = /(?<!\p{L})(اسمك|اسم حضرتك|اسمه حضرتك|نكلمك على نفس الرقم|نكلمك على الرقم|رقمك|رقم موبايلك|رقم تليفونك|رقم تليفون|الدور كام|الشقة كام|رقم العمارة|هتدفع|الدفع كاش|تدفع كاش)(?!\p{L})/u;
const booking = toolsUsed.includes('manage_reservation') || pre.reservation_in_progress === true || /reservation/i.test(str(obj(pre.brain).stage));
if (!items.length && !pending.length && !booking && !placedNo && ASKS_DETAILS.test(joined))
  violations.push('The order is still empty: do not ask for their name, number, address details or payment yet. Help them choose what to eat first (the branch or delivery area first if it is not known). Details come once the order has dishes and they are done choosing.');
// dishes in, but they haven't said they're done choosing: "anything else?" comes before their details
// (unless they gave a detail themselves this turn)
if (items.length && !booking && !placedNo && pre.done_choosing === false && !toolsUsed.includes('save_customer_details')
    && ASKS_DETAILS.test(joined))
  violations.push('They have not said they are done choosing. Do not ask for their name, number, address details or payment yet: after what was added, ask lightly whether they would like anything else.');
const bothForms = joined.match(/[\u0600-\u06FF]\s*\/\s*[\u0600-\u06FF]/);
if (bothForms) violations.push('The reply writes two forms with a slash (like "تحبّي/تحب"). Pick one: masculine for the customer unless they showed they are a woman.');
const intlPhone = joined.match(/(?<!\d)\+?201\d{9}(?!\d)/);
if (intlPhone) violations.push(`Write the phone number the local way: ${intlPhone[0].replace(/^\+?20/, '0')}, not ${intlPhone[0]}.`);
const decimalKilo = joined.match(/(?<![\d.])0?\.(25|5|75)\s*(كيلو|ك)(?!\p{L})/u);
if (decimalKilo) violations.push(`Say the weight the way people say it (ربع كيلو / نص كيلو / تلت تربع كيلو), not "${decimalKilo[0]}".`);

// links
const links = joined.match(/https?:\/\/[^\s)]+/gi) || [];
for (const l of links) {
  const d = domainOf(l.replace(/[).,]+$/, ''));
  const ok = allowedLinks.some(a => a && (d.startsWith(a) || a.startsWith(d)))
          || (str(location.maps_url) && mapsHosts.some(h => d.startsWith(h)) && joined.includes(str(location.maps_url)));
  if (!ok) violations.push(`The link ${l} is not one of the restaurant's links — remove it.`);
}

// numbers
const scan = toWesternDigits(joined.replace(/https?:\/\/[^\s)]+/gi, ' ')).replace(/(\d),(\d{3})/g, '$1$2');
const bad = [];
for (const m of scan.match(/\d+(?:\.\d+)?/g) || []) {
  const n = Number(m);
  if (n < 20) continue;
  if (allowed.has(r2(n)) || allowed.has(Math.round(n))) continue;
  if (m.length >= 7 && textPool.includes(m)) continue;
  if (/^01\d{9}$/.test(m) && textPool.includes('20' + m.slice(1))) continue;   // a number on file, written the local way
  bad.push(m);
}
if (bad.length) violations.push(`These numbers are not prices, totals or details on file: ${[...new Set(bad)].join(', ')}. Use only the numbers in FACTS, the MENU and the tool results (or leave the number out).`);

// menu pictures
const pages = obj(media.menu_pages);
const pagesHere = branchId ? (num(pages[branchId]) || num(pages.all)) : num(pages.all);
let sendMenu = decision.send_menu_images === true || String(decision.send_menu_images).toLowerCase() === 'true';
// the pictures are the menu: the text with them is a line and a question, not the menu again
if (sendMenu && (joined.match(/\d+(?:\.\d+)?\s*ج/g) || []).length > 4)
  violations.push('The menu pictures are going out with this reply — do not write the menu out again. One short line pointing to them (a highlight or a price range at most) and one question.');
// VAT is for the summary, not for browsing
if (decision.showed_order_summary !== true && !placedNo && !/الإجمالي|الاجمالي|total/i.test(joined) && /ضريبة|القيمة المضافة|VAT/i.test(joined) && !/ضريبة|ضرايب|VAT|tax/i.test(str(pre.customer_message)))
  violations.push('Do not bring up VAT while they are choosing — it belongs in the order summary (or when they ask about it).');
if (sendMenu && !pagesHere) {
  sendMenu = false;
  if (/(المنيو|منيو|menu)/i.test(joined) && /(👆|👇|اهو|أهو|اهي|أهي|اتفضل|بعتلك|here)/i.test(joined)) {
    violations.push('There are no menu pictures to send — do not say they were sent; offer the dishes in text instead.');
  }
}

// dish photos: only dishes that have one, at most three
const photoCodes = new Set(arr(media.items_with_photos).map(str));
let photos = arr(decision.send_item_photos).map(x => (String(x).toUpperCase().match(/\bM\d{3,5}\b/) || [])[0]).filter(Boolean);
photos = [...new Set(photos.filter(c => photoCodes.has(c)))].slice(0, 3);
if (!photos.length && !sendMenu && /(صور[هةت]|الصوره|الصورة|photo|picture|pic)/i.test(joined) && /(👆|👇|اهي|أهي|اهو|أهو|اتفضل|بعتلك|here)/i.test(joined)) {
  violations.push('The reply says a photo is attached, but no photo is being sent (there may be none for that dish). Describe the dish instead.');
}

// length
if (joined.length > 2400) violations.push(`The reply is ${joined.length} characters — far too long for WhatsApp. Say less, or two short messages.`);

// summary flag only means something with a real cart
let showedSummary = decision.showed_order_summary === true || String(decision.showed_order_summary).toLowerCase() === 'true';
if (showedSummary && (!items.length || pending.length || placedNo)) showedSummary = false;

// a placement always carries its number
if (placedNo && !joined.includes(placedNo) && messages.length) {
  const en = /^[\x00-\x7F\s\p{P}\p{Emoji}]*$/u.test(messages[messages.length - 1]);
  messages[messages.length - 1] += (en ? `\nOrder number: ${placedNo}` : `\nرقم الأوردر: ${placedNo}`);
}

// an order just placed to pay online always carries its payment link
if (payLink && !joined.includes(payLink) && messages.length) {
  const en = /^[\x00-\x7F\s\p{P}\p{Emoji}]*$/u.test(messages[messages.length - 1]);
  messages[messages.length - 1] += (en ? `\nPayment link: ${payLink}` : `\nلينك الدفع: ${payLink}`);
}

// a booking sent to the branch always carries its reference
if (bookingRef && !joined.includes(bookingRef) && messages.length) {
  const en = /^[\x00-\x7F\s\p{P}\p{Emoji}]*$/u.test(messages[messages.length - 1]);
  messages[messages.length - 1] += (en ? `\nBooking reference: ${bookingRef}` : `\nرقم طلب الحجز: ${bookingRef}`);
}

const handoff = obj(decision.handoff);
return [{
  json: {
    ...pre,
    decision: {
      reply_messages: messages,
      send_menu_images: sendMenu,
      send_item_photos: photos,
      showed_order_summary: showedSummary,
      handoff: { needed: handoff.needed === true || String(handoff.needed) === 'true', reason: str(handoff.reason) },
      language: str(decision.language) || null,
      memory_note: str(decision.memory_note)
    },
    tools_used: toolsUsed,
    tool_problems: toolProblems,
    tool_calls: toolCalls,
    agent_error: agentError,
    order_placed_no: placedNo,
    booking_requested_ref: bookingRef,
    booking_confirmed: confirmedBooking,
    pay_link: payLink,
    paid_now: paidNow,
    cart_items_after: items.length,
    pending_after: pending.length,
    branch_after: branchId || null,
    allowed_numbers: [...allowed],
    allowed_links: allowedLinks,
    hearts_stripped: heartsStripped,
    violations,
    needs_rewrite: violations.length > 0,
    agent_tokens: obj(agent.tokenUsage)
  }
}];
