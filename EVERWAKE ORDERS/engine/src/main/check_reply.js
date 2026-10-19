// =====================================================================
// EVERWAKE — Main · NODE: Check Reply
//
// NEVER rewrites the host's words. It only checks hard rails, and a
// broken rail sends the draft to one rewrite (no tools — nothing can be
// added to the cart twice) with the exact reason:
//   · a number that is not a real price / total / fee / detail on file
//   · saying the order is placed when place_order did not return PLACED
//   · internal codes, ids or tool names leaking to the customer
//   · a link that is not the restaurant's or the customer's own
//   · menu pictures or a dish photo promised when none is being sent
//   · far too long for WhatsApp
// Facts it may ADD without asking: the order number after a placement,
// when the host forgot to include it.
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
if (typeof decision === 'string') {
  const s = decision.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '');
  const a = s.indexOf('{'), z = s.lastIndexOf('}');
  try { decision = a !== -1 && z > a ? JSON.parse(s.slice(a, z + 1)) : { reply_messages: [decision] }; }
  catch (e) { decision = { reply_messages: [decision] }; }
}
decision = obj(decision);

// ---- what the tools did ----------------------------------------------------------
const steps = arr(agent.intermediateSteps ?? agent.intermediate_steps);
const toolsUsed = [];
let placedNo = null, placedTotal = null;
const toolNumbers = [];
const toolProblems = [];
for (const st of steps) {
  const tool = str(obj(obj(st).action).tool);
  if (tool) toolsUsed.push(tool);
  let o = obj(st).observation;
  try { o = typeof o === 'string' ? JSON.parse(o) : o; } catch (e) { o = null; }
  if (Array.isArray(o)) o = o[0];
  if (!o || typeof o !== 'object') continue;
  if (o.response && typeof o.response === 'string') { try { o = JSON.parse(o.response); } catch (e) {} }
  if (str(o.status) === 'PLACED' && o.order_no) { placedNo = str(o.order_no); placedTotal = o.total; }
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
    .replace(/[ \t]{2,}/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
}).filter(Boolean);
if (messages.length > 2) messages = [messages[0], messages.slice(1).join('\n\n')];

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
                  pre.facts_text].map(toWesternDigits).join(' ');
for (const m of textPool.match(/\d+(?:\.\d+)?/g) || []) add(Number(m));

// ---- links the host may send ------------------------------------------------------------------
const domainOf = (u) => str(u).toLowerCase().replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/\/+$/, '');
const allowedLinks = [location.maps_url, profile.website, profile.instagram, profile.facebook, profile.tiktok, profile.google_maps_url]
  .concat(arr(allLookup.branches).map(b => b.maps_url)).concat(arr(settings.allowed_links))
  .map(domainOf).filter(Boolean);
const mapsHosts = ['google.com/maps', 'maps.google.com', 'goo.gl/maps', 'maps.app.goo.gl'];

const violations = [];
const joined = messages.join('\n');
if (!joined) violations.push('The reply was empty — write the reply.');

// placement claim without a placement
const CLAIM = /(الأوردر|الاوردر|الطلب|طلبك|طلب حضرتك|أوردرك|اوردرك)[^.؟!\n]{0,25}(اتسجل|اتأكد|تم تأكيده|تم تسجيله|اتبعت للفرع|في الطريق)|(تم|اتعمل|اتم)\s*(تأكيد|تسجيل)\s*(الأوردر|الاوردر|الطلب)|order\s+(is|has been|was)\s+(placed|confirmed|sent)/i;
if (!placedNo && CLAIM.test(joined)) {
  const known = [str(obj(db.last_placed).order_no)].concat(arr(ctx.last_orders).map(o => str(o.order_no))).filter(Boolean);
  if (!known.some(no => joined.includes(no))) {
    violations.push('The reply says the order is placed/confirmed, but place_order did NOT return PLACED this turn. Do not claim it — say what is actually next (e.g. the summary to confirm, or what is still missing).');
  }
}

// internal leakage
const LEAK = /\bM\d{3,5}\b|\bP\d+-M\d{3,5}\b|\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-|\bmanage_cart\b|\bsave_customer_details\b|\bpending_id\b|\bline_id\b|\bmenu_id\b|\bset_branch\b|\bplace_order\b|\breorder_last\b|\bapply_code\b|\buse_saved_address\b|\bsaved_address\b|\bitems_json\b|\bdetails_json\b|\bjson\b|\bundefined\b|\bNaN\b|\bnull\b/i;
const leak = joined.match(LEAK);
if (leak) violations.push(`The reply shows an internal code or word ("${leak[0]}") — say it in plain words for the customer.`);

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
  bad.push(m);
}
if (bad.length) violations.push(`These numbers are not prices, totals or details on file: ${[...new Set(bad)].join(', ')}. Use only the numbers in FACTS, the MENU and the tool results (or leave the number out).`);

// menu pictures
const pages = obj(media.menu_pages);
const pagesHere = branchId ? (num(pages[branchId]) || num(pages.all)) : num(pages.all);
let sendMenu = decision.send_menu_images === true || String(decision.send_menu_images).toLowerCase() === 'true';
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
    order_placed_no: placedNo,
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
