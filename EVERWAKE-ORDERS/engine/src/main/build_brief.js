// =====================================================================
// EVERWAKE — Main · NODE: Build Brief
//
// FACTS ONLY. This node never decides what the customer means and never
// tells the model what to say. It turns the restaurant's database into
// plain facts — time, branch and whether it is open, the delivery zone,
// the cart and its offers, items still waiting on a choice, details on
// file and what is still missing, whether the summary still matches,
// the pin, the customer's previous orders — and hands them, with the
// menu and the chat, to the Brain (who plans) and the Agent (who acts).
//
// Nothing here is about one restaurant: every name, rule and number
// comes from that restaurant's rows. Only the knowledge changes.
// =====================================================================
// @include shared/basics.js
// @include shared/clock.js
// @include shared/offers.js

const norm = $('Normalize Inbound').first().json;
const intake = row($('Intake').first().json);
const claim = row($('Claim Debounce Window').first().json);
const ctx = row($input.first().json);

const state = obj(ctx.state);
const ledger = obj(state.ledger);
const details = obj(state.customer);
const location = obj(state.location);
const zone = state.zone && typeof state.zone === 'object' ? state.zone : null;
const allLookup = obj(ctx.all_lookup);
const tenant = obj(allLookup.tenant);
const profile = obj(allLookup.profile);
const settings = obj(allLookup.settings);
const branches = arr(allLookup.branches);
const zones = arr(allLookup.zones);
const branchLookup = obj(ctx.branch_lookup);
const menuItems = obj(branchLookup.items);
const media = obj(allLookup.media);
const activeOrder = ctx.active_order && ctx.active_order !== 'null' ? obj(ctx.active_order) : {};
const cartItems = arr(obj(activeOrder.cart).items);
const lastOrders = arr(ctx.last_orders);
const savedAddresses = arr(ctx.saved_addresses);
const customer = obj(ctx.customer);
const recent = arr(ctx.recent_messages);
const tz = str(tenant.timezone) || 'Africa/Cairo';
const SYM = str(tenant.currency_symbol) || 'ج';
const money$ = (n) => `${fmt(n)}${SYM}`;

const customerText = str(claim.combined_text) || str(norm.customer_message);
const agentName = obj(profile.agent_name);
const contacts = obj(profile.contacts);
const now = localNow(tz);

// ---- branch ----------------------------------------------------------------
const branchId = str(obj(state.branch).id);
const branch = branches.find(b => str(b.id) === branchId) || null;
const branchSource = str(obj(state.branch).source);
const bStatus = branch ? branchStatus(branch, now, tz) : null;
const SOURCE_TEXT = { zone: 'automatically from their location pin', only_branch: 'the restaurant has one branch',
                      agent: 'during this conversation', gps: 'automatically from their location pin' };
// each branch takes its own payment methods (the restaurant's when it set none)
const payOf = (b) => arr(b && b.payment_methods).length ? arr(b.payment_methods).map(str) : arr(settings.payment_methods).map(str);
const seating = (b) => b.dine_in === true ? 'seating: yes (they can eat there)' : (b.dine_in === false ? 'NO seating — delivery and pickup only' : '');

// ---- order type, zone, fee ---------------------------------------------------
const dm = str(details.delivery_method).toLowerCase();
const mode = ['delivery', 'pickup'].includes(dm) ? dm : 'unknown';
const zonesDrawn = zones.length > 0;
const zoneHere = zone && (!branchId || str(zone.branch_id) === branchId) ? zone : null;
const zoneElsewhere = zone && branchId && str(zone.branch_id) !== branchId ? zone : null;
const fee = zoneHere && zoneHere.delivery_fee != null ? num(zoneHere.delivery_fee) : (branch && branch.delivery_fee != null ? num(branch.delivery_fee) : null);
const minOrder = zoneHere && zoneHere.min_order != null ? num(zoneHere.min_order) : (branch ? num(branch.min_order) : 0);
const eta = zoneHere && (zoneHere.eta_min || zoneHere.eta_max)
  ? `${zoneHere.eta_min || '?'}–${zoneHere.eta_max || '?'} min`
  : (branch && branch.delivery_eta_text ? branch.delivery_eta_text : null);

// ---- cart & pending ------------------------------------------------------------
const UNIT_AR = { kg: 'كيلو', piece: 'قطعة', person: 'فرد' };
const qtyText = (i) => { const u = UNIT_AR[str(i.unit)]; return u ? `${fmt(i.quantity)} ${u}` : `× ${fmt(i.quantity)}`; };
const cartLines = cartItems.map(i => {
  const ch = arr(i.choices).map(c => arr(c.selected).map(s => str(obj(s).name || s)).join(' + ')).filter(Boolean);
  return `- [${i.line_id}] ${i.display_name || i.item_name} ${qtyText(i)}`
    + (ch.length ? ` · ${ch.join(' · ')}` : '')
    + (i.notes ? ` · note: ${i.notes}` : '')
    + (i.gift ? ' · FREE (offer)' : ` = ${i.price_known === false ? 'price to be confirmed' : money$(i.line_total)}`);
});
// a dish switched off or taken off this branch since it went in the cart
const stale = branchId ? cartItems.filter(i => !i.gift).filter(i => {
  const e = menuItems[str(i.code)];
  return !e || e.available === false || e.orderable === false || (e.sold_out_until && new Date(e.sold_out_until).getTime() > Date.now());
}).map(i => i.display_name || i.item_name) : [];
const pending = arr(ledger.pending_items);
const choiceTree = obj(branchLookup.choices);
const pendingLines = pending.map(p => {
  const levels = arr(obj(choiceTree[str(p.code)]).levels);
  const left = arr(p.levels_left).map(l => {
    const L = levels.find(x => num(x.level) === num(l));
    return L ? `${L.label_ar} (${arr(L.options).map(o => o.name).join(' / ')})` : `level ${l}`;
  });
  const done = arr(p.choices).map(c => arr(c.selected).join('+')).filter(Boolean);
  return `- [pending_id ${p.pid}] ${p.name} ${p.quantity ? fmt(p.quantity) : ''}`
    + (done.length ? ` · answered: ${done.join(', ')}` : '')
    + ` · still needs: ${left.join('; ') || '?'}`;
});
const discountLines = arr(activeOrder.applied_offers).map(a => `  offer applied: ${a.title}${num(a.amount) ? ' −' + money$(a.amount) : ''}${a.gift ? ` (free ${a.gift.name})` : ''}`);

// ---- offers running now ------------------------------------------------------------
const offersNow = arr(allLookup.offers).filter(o => offerActiveNow(o, now, branchId || null));
const promoCodes = arr(ledger.promo_codes).map(c => str(c).toUpperCase());
const offerLines = offersNow.map(o => {
  const cond = [o.min_subtotal ? `orders over ${money$(o.min_subtotal)}` : '', o.first_order_only ? 'first order only' : '',
                arr(o.item_codes).length ? `on ${arr(o.item_codes).join(', ')}` : '',
                arr(o.category_names).length ? `on ${arr(o.category_names).join('، ')}` : '',
                o.time_from && o.time_to ? `${String(o.time_from).slice(0, 5)}–${String(o.time_to).slice(0, 5)} only` : '',
                o.ends_at ? `until ${String(o.ends_at).slice(0, 10)}` : ''].filter(Boolean).join(', ');
  const what = o.kind === 'percent_off' ? `${fmt(o.value)}% off` : o.kind === 'amount_off' ? `${money$(o.value)} off`
    : o.kind === 'fixed_price' ? `special price ${money$(o.value)}` : o.kind === 'free_delivery' ? 'free delivery'
    : `free ${o.free_item_name || 'item'}`;
  if (o.promo_code && !promoCodes.includes(str(o.promo_code).toUpperCase())) {
    // the code itself never reaches the model until the customer has given it
    return `- a promo-code offer: ${what}${cond ? ' (' + cond + ')' : ''} · ONLY for a customer who gives its code — never mention it first; when they give a code, apply_code checks it`;
  }
  const code = o.promo_code ? ` · code APPLIED for this customer` : ' · applies automatically';
  return `- ${o.title_ar}${o.description_ar ? ' — ' + o.description_ar : ''} [${what}]${cond ? ' (' + cond + ')' : ''}${code}`;
});

// ---- details -------------------------------------------------------------------------
const REQ = obj(settings.required_fields);
const hasPin = location.lat != null && location.lng != null;
const phoneHidden = obj(state.contact).phone_hidden === true || intake.phone_hidden === true;
const missing = arr(REQ[mode] || ['phone_confirmed', 'full_name', 'delivery_method'])
  .map(f => (phoneHidden && f === 'phone_confirmed') ? 'phone' : f)
  .filter(f => !(f === 'address_street' && hasPin))
  .filter(f => fieldNeeded(f, details))
  .filter(f => !str(details[f]));
if (!branchId) missing.push('branch');
const payNotTaken = branch && str(details.payment_method) && !payOf(branch).includes(str(details.payment_method)) ? str(details.payment_method) : '';
if (payNotTaken && !missing.includes('payment_method')) missing.push('payment_method');
if (mode === 'delivery' && zonesDrawn && settings.require_zone_for_delivery !== false && !zoneHere) missing.push('delivery_area');
const pinAddress = hasPin && str(details.address_source) === 'pin';
const pinAddressUnconfirmed = pinAddress && str(details.address_confirmed) !== 'yes';
if (pinAddressUnconfirmed && mode !== 'pickup') missing.push('confirm_pin_address');
const LABEL = {
  phone_confirmed: 'whether we call them on this same number (ask it lightly: "نكلمك على نفس الرقم ده؟")', full_name: 'name',
  phone: 'a phone number for the order (WhatsApp hides their number — ask them to type it)',
  delivery_method: 'delivery or pickup', payment_method: 'payment method', branch: 'branch',
  address_area: 'area/district', address_street: 'street', address_building: 'building no.',
  address_floor: 'floor', address_apartment: 'apartment', address_city: 'city',
  delivery_area: 'where they are, inside a delivery zone (a location pin is easiest, or their area name)',
  confirm_pin_address: 'their OK that the address from their pin is where the order goes (one line, with building/floor/apartment)'
};
const detailLines = Object.entries(details).filter(([, v]) => str(v))
  .map(([k, v]) => `- ${k} = ${['phone', 'alt_phone'].includes(k) ? localPhone(v) : v}`);

// ---- the order summary on file -----------------------------------------------------------
const reviewHash = str(ledger.review_hash);
let summaryStatus;
if (!reviewHash) summaryStatus = 'not shown yet';
else if (reviewHash === str(ctx.current_review_hash)) summaryStatus = 'shown and STILL MATCHES the cart, details and branch — a clear yes from the customer can be placed now';
else summaryStatus = 'shown before, but the cart, the details or the branch changed since — the updated summary must be shown and confirmed before placing';

// ---- location and delivery area -------------------------------------------------------------
let locationLines = ['none shared'];
if (hasPin) {
  const geo = obj(location.geo);
  locationLines = [
    `pin: ${location.maps_url || ''}`,
    `resolved address: ${[geo.street && 'street ' + geo.street, geo.district && 'area ' + geo.district,
      geo.city && 'city ' + geo.city, geo.governorate].filter(Boolean).join('، ') || 'could not be resolved'}`
    + (geo.source ? ` (via ${geo.source})` : ''),
    `nearest branches: ${arr(location.nearest).map(n => `${n.name} ${n.km} km (${n.state})`).join(' · ')}`,
    'a pin never includes building, floor or apartment'
  ];
  if (claim.has_location) locationLines.unshift('THIS TURN: the customer just shared this pin');
}
let areaLine;
if (!zonesDrawn) areaLine = 'no delivery zones are drawn — delivery goes by distance from the branch' + (zone ? ` (pin is ${zone.km} km from ${zone.branch_name})` : '');
else if (zoneHere) areaLine = `INSIDE the delivery zone "${zoneHere.name}" of ${zoneHere.branch_name} (from ${zoneHere.source === 'pin' ? 'their pin' : zoneHere.source === 'saved_address' ? 'their saved address' : 'the area they typed: ' + (zoneHere.matched || '')}) · delivery fee ${zoneHere.delivery_fee == null ? 'confirmed by the branch' : money$(zoneHere.delivery_fee)}${zoneHere.min_order ? ' · minimum ' + money$(zoneHere.min_order) : ''}${eta ? ' · usually ' + eta : ''}`;
else if (zoneElsewhere) areaLine = `their location is in the zone "${zoneElsewhere.name}", served by ${zoneElsewhere.branch_name} — NOT the branch chosen now (${branch ? branch.name_ar : '?'}). For delivery, ${zoneElsewhere.branch_name} is the branch that delivers there.`;
else if (hasPin && location.in_delivery_area === false) areaLine = 'their pin is OUTSIDE every delivery zone — delivery is not possible there; pickup is (say which branch is nearest)';
else areaLine = 'unknown yet — a location pin (or the area name) decides the zone, the fee and the branch';

// ---- paying ------------------------------------------------------------------------------
const PAY_FACT = {
  cash: 'cash', card: 'card on delivery', wallet: 'mobile wallet on delivery', instapay: 'InstaPay',
  online: 'online (payment_method "online": a secure payment link by card or mobile wallet, sent right after the order is placed)'
};
const PAY_SHORT = { cash: 'cash', card: 'card on delivery', wallet: 'mobile wallet on delivery', instapay: 'InstaPay', online: 'online payment link' };
const payNames = (list, long) => list.map(m => (long ? PAY_FACT : PAY_SHORT)[m] || m).join(', ') || 'cash';
let payFact;
if (branch) {
  payFact = `PAYMENT METHODS YOU MAY PROMISE at ${branch.name_ar}: ${payNames(payOf(branch), true)} (anything else: the branch confirms)`;
} else {
  const lists = branches.map(b => [b, payOf(b)]);
  payFact = lists.length > 1 && lists.some(([, l]) => l.join() !== lists[0][1].join())
    ? `PAYMENT METHODS YOU MAY PROMISE — each branch its own: ${lists.map(([b, l]) => `${b.name_ar}: ${payNames(l, false)}`).join(' · ')}`
      + (lists.some(([, l]) => l.includes('online')) ? ' · online = payment_method "online": a secure payment link by card or mobile wallet, sent right after the order is placed' : '')
      + ' (anything else: the branch confirms)'
    : `PAYMENT METHODS YOU MAY PROMISE: ${payNames(lists.length ? lists[0][1] : arr(settings.payment_methods), true)} (anything else: the branch confirms)`;
}
if (payNotTaken) payFact += `\n  ⚠ the payment method on file (${PAY_SHORT[payNotTaken] || payNotTaken}) is NOT taken at ${branch.name_ar} — ask how they will pay instead`;
const payLine = (o) => {
  if (o.payment_method !== 'online' && (!o.payment_status || o.payment_status === 'none')) return '';
  const p = obj(o.payment);
  const st = o.payment_status;
  if (st === 'paid') return `\n    payment: PAID online ${money$(o.paid_amount != null ? o.paid_amount : o.total)}`;
  if (st === 'refunded') return '\n    payment: paid online, then REFUNDED';
  if (st === 'pending' && p.link) return `\n    payment: NOT PAID YET — link ${p.link} (works until ${localTime(p.expires_at, tz)})`
    + (num(p.declined_attempts) ? ` · ${num(p.declined_attempts)} declined attempt(s)${p.last_error ? ': ' + p.last_error : ''}` : '');
  if (st === 'expired') return '\n    payment: NOT PAID — the payment link expired; the branch was asked to call them (a new link or cash)';
  return '\n    payment: online, NO LINK YET — the team sends it (or switches to cash)';
};

// ---- returning customer ------------------------------------------------------------------
const UNIT_EN = { kg: 'kg', piece: 'pcs', person: 'ppl' };
// what a status means, the way the host would put it
const ORDER_STATUS = {
  placed: 'sent to the branch, waiting for them to start it', accepted: 'the branch accepted it, being prepared in the kitchen',
  preparing: 'being prepared in the kitchen', ready: 'ready at the branch', out_for_delivery: 'with the driver, on the way',
  delivered: 'delivered', picked_up: 'picked up', cancelled: 'cancelled'
};
const sinceText = (t) => {
  const m = Math.round((Date.now() - new Date(t).getTime()) / 60000);
  return !Number.isFinite(m) || m < 0 ? '' : m < 120 ? ` · placed ${m} min ago` : m < 2880 ? ` · placed ${Math.round(m / 60)} h ago` : '';
};
const orderLine = (o) => {
  const items = arr(o.items).filter(i => !i.gift).map(i => `${i.name} ${UNIT_EN[i.unit] ? fmt(i.quantity) + ' ' + UNIT_EN[i.unit] : '×' + fmt(i.quantity)}`
    + (arr(i.choices).length ? ` (${arr(i.choices).map(c => arr(c.selected).map(s => str(obj(s).name || s)).join('+')).join(', ')})` : '')).join('، ');
  const driver = obj(o.driver), track = obj(o.tracking);
  return `${o.order_no} · ${str(o.placed_at).slice(0, 10)}${sinceText(o.placed_at)} · ${o.branch_name || ''} · ${o.delivery_method || ''} · total ${money$(o.total)} · status ${o.status} (${ORDER_STATUS[o.status] || o.status})`
    + (o.last_update_at ? ` (last update ${String(o.last_update_at).slice(0, 16).replace('T', ' ')} UTC)` : '')
    + (driver.name ? `\n    driver: ${driver.name} (${driver.phone || 'no number'})`
       + (track.eta_min != null ? ` · about ${track.km_left} km / ${track.eta_min} min from the customer (position from ${num(track.minutes_ago)} min ago)` : '') : '')
    + payLine(o)
    + `\n    items: ${items || '—'}`;
};
const historyFacts = [];
if (lastOrders.length) {
  historyFacts.push(`RETURNING CUSTOMER: ${num(customer.orders_count)} previous order(s). Their latest:`);
  lastOrders.slice(0, 2).forEach(o => historyFacts.push('  ' + orderLine(o)));
  historyFacts.push('  (manage_cart reorder_last puts the latest order back in the cart, re-priced from today\'s menu)');
} else {
  historyFacts.push('RETURNING CUSTOMER: no — first order with us');
}
if (savedAddresses.length) {
  historyFacts.push('SAVED ADDRESSES (from previous orders — offer to reuse instead of asking from scratch):');
  savedAddresses.forEach(a => historyFacts.push(`  - [saved_address ${a.id}] ${a.text || [a.area, a.street, a.building && 'building ' + a.building].filter(Boolean).join(', ')}`));
}
const profileName = str(customer.full_name);

// ---- table bookings ----------------------------------------------------------------------------
const rsv = obj(ctx.reservation_setup);
const rsvBranches = arr(rsv.branches);
const rsvWa = rsvBranches.filter(b => b.mode === 'whatsapp');
const rsvPhone = rsvBranches.filter(b => b.mode === 'phone');
const draft = ctx.reservation && typeof ctx.reservation === 'object' ? ctx.reservation : null;
const upcoming = arr(ctx.reservations_upcoming);
const RSV_STATUS = {
  requested: 'REQUESTED — sent to the branch team, who contact the customer to confirm it (NOT confirmed yet)',
  confirmed: 'CONFIRMED by the branch team'
};
const RSV_NEED = { branch: 'which branch', date: 'the day', time: 'the time', guests: 'how many people', full_name: 'the name', phone: 'a phone number' };
const bookingLines = [];
if (!rsvBranches.length && !upcoming.length) {
  bookingLines.push('TABLE BOOKINGS: not taken on WhatsApp — someone who wants a table: a team member follows up (handoff)');
} else {
  bookingLines.push('TABLE BOOKINGS (dine-in — not an order: no cart, no prices):');
  if (rsvWa.length) {
    const [yy, mm, dd] = now.date.split('-').map(Number);
    const days = Array.from({ length: 8 }, (_, i) => {
      const iso = new Date(Date.UTC(yy, mm - 1, dd + i)).toISOString().slice(0, 10);
      return `${i === 0 ? 'today ' : i === 1 ? 'tomorrow ' : ''}${DAY_AR[DAYS[(now.day + i) % 7]] || ''} ${iso}`;
    });
    bookingLines.push(`- taken here on WhatsApp (manage_reservation) at: ${rsvWa.map(b => `${b.name_ar} (code ${b.code}, up to ${num(b.max_guests)} guests${b.note ? ' — ' + b.note : ''})`).join(' · ')}`);
    bookingLines.push(`- rules: at least ${num(rsv.lead_minutes, 60)} min ahead · up to ${num(rsv.days_ahead, 30)} days ahead · within the branch's opening hours`);
    bookingLines.push(`- the coming days (for the date field): ${days.join(' · ')}`);
    if (arr(rsv.occasions).length) bookingLines.push(`- occasions people book for here: ${arr(rsv.occasions).join('، ')} (optional — never required)`);
  } else {
    bookingLines.push('- NOT taken on WhatsApp');
  }
  if (rsvPhone.length) {
    bookingLines.push(`- by phone only — give the number, do not take the booking: ${rsvPhone.map(b => `${b.name_ar} ${b.phone || '(number not on file)'}${b.note ? ' — ' + b.note : ''}`).join(' · ')}`);
  }
  if (draft) {
    const waLocal = str(customer.phone || intake.wa_id).replace(/^20(\d{10})$/, '0$1');
    const parts = [
      draft.branch ? `branch ${draft.branch}` : '',
      draft.date ? `date ${draft.date} (${draft.day})` : '',
      draft.time ? `time ${draft.time} (${draft.time_ar})` : '',
      draft.guests ? `${draft.guests} guests` : '',
      draft.occasion ? `occasion: ${draft.occasion}` : '',
      draft.full_name ? `name ${draft.full_name}` : '',
      draft.phone ? `phone ${draft.phone}${draft.phone === waLocal ? ' (their WhatsApp number — the summary shows it; another only if they give one)' : ''}` : '',
      draft.requests ? `special requests: ${draft.requests}` : ''
    ].filter(Boolean);
    const need = Object.keys(RSV_NEED).filter(k => !draft[k]).map(k => RSV_NEED[k]);
    bookingLines.push(`- BOOKING IN PROGRESS: ${parts.join(' · ') || 'just started'}`);
    bookingLines.push(`  still needed: ${need.length ? need.join(' · ') : 'nothing — ready for the summary'} · summary: ${draft.summary || 'not shown yet'}`);
  }
  if (upcoming.length) {
    bookingLines.push('- THEIR BOOKINGS:');
    upcoming.forEach(u => bookingLines.push(`  ${u.ref_no} · ${u.branch || ''} · ${u.day || ''} ${u.time_ar || ''} · ${num(u.guests)} guests`
      + `${u.occasion ? ' · ' + u.occasion : ''} · ${RSV_STATUS[u.status] || u.status}`));
  }
}

// ---- conversation -------------------------------------------------------------------------------
const spokeBefore = recent.some(m => m.direction === 'outbound');
let gapH = null;
if (str(state.last_turn_at)) gapH = (Date.now() - new Date(str(state.last_turn_at)).getTime()) / 3600000;
const isFirstReply = !spokeBefore || (gapH !== null && gapH >= 12);
// a pin, a voice note or a photo has no words of theirs: "[shared a location pin]"
// is our marker, not English — the language they used before decides
const ownWords = customerText.replace(/\[[a-z ]+\]/gi, ' ');
const earlierWords = ownWords.trim() ? '' : recent.filter(m => m.direction === 'inbound').map(m => str(m.text || m.body)).join(' ').replace(/\[[a-z ]+\]/gi, ' ');
const langText = ownWords.trim() ? ownWords : earlierWords;
// done choosing: they said so ("بس كده"، "كده تمام"، "that's all"), or said no to "anything else?";
// until then their name, number, address and payment wait — a detail they give on their own is still taken
const DONE_RE = /(?<!\p{L})(بس كده|بس كدا|كده بس|كدا بس|وبس|كده تمام|كدا تمام|كده كفاية|كفاية كده|كفايه كده|خلاص كده|كده خلاص|مش عايز حاجة تانية|مش عايز حاجه تانيه|مش عاوز حاجة تانية|مفيش حاجة تانية|مفيش حاجه تانيه|لا كده|لأ كده|bas keda|bas kda|keda bas|kda bas|keda tamam|kda tmam|that'?s all|that'?s it|nothing else)(?!\p{L})/iu;
const ASKED_MORE_RE = /(حاجة تانية|حاجه تانيه|حاجة كمان|تزود|تضيف|أزودلك|اضيفلك|أضيفلك|anything else|something else)/iu;
const NO_RE = /^\s*(لا|لأ|لاء|لا شكرا|لا شكراً|لا متشكر|لا ميرسي|no|nope|la2|la|no thanks)(?!\p{L})/iu;
const chatMsgs = [...recent];
if (customerText && !chatMsgs.some(m => m.direction === 'inbound' && str(m.text || m.body) === customerText))
  chatMsgs.push({ direction: 'inbound', text: customerText });
let doneChoosing = false;
chatMsgs.forEach((m, i) => {
  if (m.direction !== 'inbound') return;
  const t = str(m.text || m.body);
  const before = chatMsgs.slice(0, i).reverse().find(x => x.direction === 'outbound');
  if (DONE_RE.test(t) || (NO_RE.test(t) && t.trim().length <= 24 && before && ASKED_MORE_RE.test(str(before.text || before.body)))) doneChoosing = true;
});
const ar = (langText.match(/[؀-ۿ]/g) || []).length;
const la = (langText.match(/[A-Za-z]/g) || []).length;
// Franco: Egyptian Arabic typed in Latin letters ("3ayez", "a7la", "ezayak") — an Egyptian, answered in Egyptian Arabic
const FRANCO = /[a-z][2357689]|[2357689][a-z]|\b(ana|enta|enty|ezay|ezayak|3ayez|3ayza|3awz|3awza|keda|kda|leh|eh|feen|fen|emta|bekam|b kam|kam|el|fe|mesh|msh|momken|tab|ya3ni|yaany|ba2a|delwa2ty|dlw2ty|lazem|3ala|3and|3ando|3andko|ma3a|wala|aw|ah|aywa|la2|shokran|7aga|7elw|tamam)\b/gi;
const francoHits = (langText.match(FRANCO) || []).length;
const franco = !ar && la && francoHits >= 2;
const lang = franco ? 'Franco-Arabic — Egyptian Arabic typed in Latin letters: answer in Egyptian Arabic (Arabic letters), never in English'
  : ar && la ? (ar >= la ? 'Arabic (some English words)' : 'English (some Arabic words)') : (la ? 'English' : 'Arabic');
// nothing in words at all (a first message that is only a pin) → Egyptian Arabic, the default here

const clip = (s, n) => { s = str(s); return s.length > n ? s.slice(0, n - 1) + '…' : s; };
const who = (m) => m.direction === 'inbound' ? 'customer: '
  : (m.sender === 'staff' ? `team member${m.staff_name ? ' (' + m.staff_name + ')' : ''}: `
  : (m.sender === 'system' ? 'automatic message from the restaurant: '
  : (m.sender === 'driver' ? 'the delivery driver (via the restaurant number): ' : 'you: ')));
const historyLines = recent.slice(-18).map(m => who(m) + clip(m.text || `[${m.kind}]`, m.direction === 'inbound' ? 600 : 450).replace(/\n+/g, ' ⏎ '));
const memory = arr(state.memory_notes).slice(-10);

const situation = [];
const handback = obj(state.handback);
if (handback.at && (Date.now() - new Date(handback.at).getTime()) < 6 * 3600000) {
  situation.push(`A TEAM MEMBER handled this chat${handback.human_since ? ' from ' + String(handback.human_since).slice(11, 16) : ''} until ${String(handback.at).slice(11, 16)} UTC and handed it back to you. Their messages are in the chat as "team member". Continue from where they left off — never repeat or contradict what they told the customer.`);
}
const pause = ctx.pause && typeof ctx.pause === 'object' ? ctx.pause : null;
if (pause && pause.apologized_at) {
  situation.push(`The WhatsApp ordering line was PAUSED by the restaurant (busy) when this customer wrote; they got an automatic apology${pause.resume_notified_at ? ' and later an automatic "we are back, you can order now" message' : ''}. Thank them warmly for waiting once, then serve them normally.`);
}

// ---- pictures --------------------------------------------------------------------------------------
const pages = obj(media.menu_pages);
const pageCount = branchId ? num(pages[branchId]) || num(pages.all) : num(pages.all);
const menuSentFor = arr(ledger.menu_sent_branches).map(str);
const menuKey = branchId || 'all';
const menuPics = pageCount
  ? `${pageCount} page(s) available${branchId ? ' for ' + (branch ? branch.name_ar : '') : ''}; already sent to this customer: ${menuSentFor.includes(menuKey) ? 'YES' : 'no'}`
  : 'none uploaded — describe the dishes in text';
const photoCodes = arr(media.items_with_photos);
const photosSent = arr(ledger.photos_sent).map(str);

// ---- FACTS --------------------------------------------------------------------------------------------
const brandAr = str(tenant.name_ar), brandEn = str(tenant.name_en);
const facts = [
  'FACTS FOR THIS TURN (from the restaurant\'s systems — true right now)',
  `- Now (${tz}): ${DAY_AR[DAYS[now.day]] || ''} ${now.date} ${now.label}`,
  `- You are: ${str(agentName.ar) || 'ياسمين'} (${str(agentName.en) || 'Yasmin'}) from ${brandAr}${brandEn && brandEn !== brandAr ? ' (' + brandEn + ')' : ''}`,
  `- Customer: WhatsApp name "${str(norm.customer_name) || str(customer.display_name) || '—'}" (often a nickname — do not assume it is their real name)`
    + (profileName ? ` · name on file from previous orders: ${profileName}` : '')
    + ` · ${phoneHidden ? 'their phone number is HIDDEN by WhatsApp privacy — you cannot see it; ask them to type a number for the order, and never quote the internal ID' : 'their WhatsApp number: ' + localPhone(customer.phone || intake.wa_id)}`,
  `- Their latest message is in: ${lang}`,
  `- First reply of this conversation: ${isFirstReply ? 'YES' : 'no'}${gapH !== null ? ` (last turn ${gapH < 1 ? Math.round(gapH * 60) + ' min' : Math.round(gapH) + ' h'} ago)` : ''}`,
  `- Messages bundled into this turn: ${num(claim.buffered_count, 1)}`,
  ...situation.map(s => '- ' + s),
  '',
  `BRANCH: ${branch
    ? `${branch.name_ar} (code ${branch.code}) — chosen ${SOURCE_TEXT[branchSource] || 'earlier'} · ${bStatus.text}`
      + ` · delivery ${branch.delivery_enabled === false ? 'NOT offered' : 'yes'} · pickup ${branch.pickup_enabled === false ? 'NOT offered' : 'yes'}`
      + (seating(branch) ? ' · ' + seating(branch) : '')
      + ` · delivery fee: ${fee == null ? 'not set — the branch confirms it' : money$(fee)}${minOrder ? ' · minimum order ' + money$(minOrder) : ''}`
      + (bStatus.state === 'closed' && settings.accept_orders_when_closed ? ' · orders taken now are prepared when it opens' : '')
      + (bStatus.state === 'closed' && !settings.accept_orders_when_closed ? ' · orders cannot be placed until it opens' : '')
    : (branches.length ? 'NOT CHOSEN YET — nothing can be priced or added until it is (each branch can have its own menu and prices)' : 'the restaurant has no branch set up')}`,
  branch && branch.price_note_ar ? `  prices at this branch (for you; tell the customer only if they ask about prices or fees): ${branch.price_note_ar}` : '',
  `ORDER TYPE: ${mode === 'delivery' ? 'delivery' : (mode === 'pickup' ? 'pickup from the branch' : 'not chosen yet — delivery or pickup')}`,
  `DELIVERY AREA: ${areaLine}`,
  '',
  'LOCATION:', ...locationLines.map(l => '  ' + l),
  '',
  'CART (the only truth — not the chat):',
  cartLines.length ? cartLines.join('\n') : '- (empty)',
  ...discountLines,
  cartLines.length ? `  subtotal ${money$(activeOrder.subtotal)}${num(activeOrder.discount_total) ? ' · discount −' + money$(activeOrder.discount_total) : ''} · ${activeOrder.vat == null ? 'taxes/fees: the branch adds its fees (amount not published)' : `VAT ${branch ? fmt(branch.vat_percent) : ''}% ${money$(activeOrder.vat)}`} · delivery ${activeOrder.delivery_fee == null ? (mode === 'pickup' ? '0 (pickup)' : 'to be confirmed by the branch') : money$(activeOrder.delivery_fee)} · total ${money$(activeOrder.total)}` : '',
  cartItems.some(i => i.extra_charge) ? `  a preparation charge the branch has not published is still to be added for: ${cartItems.filter(i => i.extra_charge).map(i => i.display_name || i.item_name).join('، ')}` : '',
  stale.length ? `  ⚠ NO LONGER AVAILABLE (switched off by the restaurant since it went in the cart): ${stale.join('، ')} — tell the customer, offer an alternative, and update the cart` : '',
  '',
  'ITEMS WAITING ON A REQUIRED CHOICE (not in the cart until answered):',
  pendingLines.length ? pendingLines.join('\n') : '- (none)',
  '',
  'DETAILS ON FILE FOR THIS ORDER (never ask for these again):',
  detailLines.length ? detailLines.join('\n') : '- (none yet)',
  `- delivery mode: ${mode}`,
  pinAddress ? `- the street / area / city above came from their GPS pin — ${pinAddressUnconfirmed ? 'NOT yet confirmed by them as the delivery address' : 'they confirmed it'}` : '',
  '',
  ...historyFacts,
  '',
  // an empty order: the branch and the food come first — their name, number, address details and
  // payment are not on the list yet (anything they volunteer is still saved)
  (cartItems.length || pending.length)
    ? (doneChoosing
        ? 'CHOOSING: done — they said that\'s all.'
        : 'CHOOSING: they have NOT said they are done choosing — after what you add or change, ask lightly, in your own words, whether they\'d like anything else. Their name, number, building/floor and payment wait until they say that\'s all (or move on to their details themselves).')
      + `\nSTILL MISSING TO PLACE AN ORDER: ${missing.length ? missing.map(f => LABEL[f] || f).join(' · ') : 'nothing — details complete'}`
    : `THE ORDER IS STILL EMPTY — first: ${missing.filter(f => ['delivery_method', 'branch', 'delivery_area'].includes(f)).map(f => LABEL[f] || f).join(' · ') || 'nothing — help them choose what to eat'}`
      + ' · then help them choose their food. Their name, number, building/floor and payment are NOT asked until the order has dishes and they are done choosing (save any they give on their own).',
  `ORDER SUMMARY: ${cartItems.length ? summaryStatus : 'n/a (cart empty)'}`,
  `OFFERS RUNNING NOW:\n${offerLines.length ? offerLines.join('\n') : '- none'}`,
  `MENU PICTURES: ${menuPics}`,
  `DISH PHOTOS: ${photoCodes.length ? `dishes marked 📷 in the MENU have a photo you can send (send_item_photos)${photosSent.length ? '; already sent: ' + photosSent.join(', ') : ''}` : 'none uploaded'}`,
  `RULED OUT BY THE CUSTOMER (food_prefs): ${str(details.food_prefs) || 'nothing — everything is open'}`,
  payFact,
  '',
  ...bookingLines,
  memory.length ? 'NOTES FROM EARLIER IN THIS CONVERSATION:\n' + memory.map(m => '- ' + m).join('\n') : ''
].filter(x => x !== '').join('\n');

// ---- BUSINESS FACTS ---------------------------------------------------------------------------------------
const branchBlock = branches.map(b => {
  const st = branchStatus(b, now, tz);
  return `- ${b.name_ar}${b.name_en ? ' (' + b.name_en + ')' : ''}, code ${b.code}: ${b.address_ar || 'address not on file'}`
    + ` · ${b.hours_text_ar || 'hours: see status'} · ${b.phone || ''}`
    + ` · ${st.text}`
    + ` · ${[b.delivery_enabled === false ? 'no delivery' : 'delivery', b.pickup_enabled === false ? 'no pickup' : 'pickup'].join(' + ')}`
    + (seating(b) ? ' · ' + seating(b) : '')
    + (b.own_payment_methods ? ` · pays: ${payNames(payOf(b), false)}` : '')
    + (b.serves_hint_ar ? ` · usually serves: ${b.serves_hint_ar}` : '')
    + (b.vat_percent != null ? ` · +${fmt(b.vat_percent)}% VAT` : ' · prices exclude the branch fees')
    + (b.maps_url ? ` · map: ${b.maps_url}` : '');
}).join('\n');
const zoneBlock = zones.map(z => `- ${z.name_ar} → ${branches.find(b => str(b.id) === str(z.branch_id))?.name_ar || z.branch_code}`
  + `${z.delivery_fee != null ? ' · fee ' + money$(z.delivery_fee) : ''}${z.min_order ? ' · min ' + money$(z.min_order) : ''}`
  + `${z.eta_min || z.eta_max ? ` · ${z.eta_min || '?'}–${z.eta_max || '?'} min` : ''}`
  + `${arr(z.areas).length ? ' · areas: ' + arr(z.areas).join('، ') : ''}`).join('\n');
const knowledge = arr(allLookup.knowledge).map(k => `- ${k.topic}: ${str(k.content_ar) || str(k.content_en)}`);
const business = [
  'BUSINESS FACTS',
  str(profile.about_ar) ? `- ${profile.about_ar}` : '',
  str(profile.about_en) ? `- ${profile.about_en}` : '',
  str(profile.cuisine) ? `- Cuisine: ${profile.cuisine}` : '',
  str(profile.tone) ? `- House style for the host: ${profile.tone}` : '',
  ...arr(profile.brand_facts).map(f => '- ' + f),
  [contacts.hotline && `hotline ${contacts.hotline}`, contacts.complaints && `complaints ${contacts.complaints}`,
   profile.website && `website ${profile.website}`, profile.instagram && `Instagram ${profile.instagram}`,
   profile.facebook && `Facebook ${profile.facebook}`].filter(Boolean).length
    ? '- Contacts: ' + [contacts.hotline && `hotline ${contacts.hotline}`, contacts.complaints && `complaints ${contacts.complaints}`,
                        profile.website && `website ${profile.website}`, profile.instagram && `Instagram ${profile.instagram}`,
                        profile.facebook && `Facebook ${profile.facebook}`].filter(Boolean).join(' · ') : '',
  '',
  'THE BRANCHES:',
  branchBlock || '- (none)',
  zonesDrawn ? '\nDELIVERY ZONES:\n' + zoneBlock : '',
  knowledge.length ? '\nANSWERS THE RESTAURANT GAVE (use them as they are):\n' + knowledge.join('\n') : ''
].filter(x => x !== '').join('\n');

// ---- MENU ------------------------------------------------------------------------------------------------------
// a choice with a preparation charge the branch sets: a marker for the host, not words to read out
let menuText = str(ctx.menu_digest).replace(/\s*\(\+رسوم تسوية يحددها الفرع\)/g, ' †');
if (menuText.includes('†')) menuText = '† = a preparation charge the branch sets. Never mention it while they choose; only in the summary, briefly, if they picked it.\n\n' + menuText;
if (branchId) {
  const here = menuItems;
  const elsewhere = Object.entries(obj(allLookup.items))
    .filter(([code, e]) => !here[code] && arr(e.branches).length && !e.dine_in_only)
    .map(([, e]) => `${e.name} (${arr(e.branches).map(c => (branches.find(x => x.code === c) || {}).name_ar || c).join('، ')})`);
  if (elsewhere.length) menuText += '\n\n### not on this branch\'s menu — only at other branches:\n' + elsewhere.join(' · ');
}

// the model's prompt templates read { } as variables: none may reach them
const safe = (s) => String(s == null ? '' : s).replace(/\{/g, '(').replace(/\}/g, ')');
const latest = safe(customerText || '(no text)');
const factsText = safe(facts), businessText = safe(business), menuSafe = safe(menuText);
const historyText = safe(historyLines.join('\n'));
const brief = [
  factsText, '', businessText, '', '================ MENU ================', menuSafe, '',
  '================ THE CHAT SO FAR (oldest first) ================',
  historyText || '(this is the first message)',
  '', '================ THE CUSTOMER\'S LATEST MESSAGE ================', latest
].join('\n');

return [{
  json: {
    run_id: norm.run_id,
    tenant_id: intake.tenant_id,
    wa_id: intake.wa_id,
    turn_started_at: norm.received_at,
    brain_started_at: new Date().toISOString(),
    customer_message: customerText,
    buffered_count: num(claim.buffered_count, 1),
    has_location: !!claim.has_location,
    branch_id: branchId || null,
    branch_name: branch ? branch.name_ar : null,
    is_first_reply: isFirstReply,
    done_choosing: doneChoosing,
    language_hint: lang,
    cart_has_items: cartItems.length > 0,
    pending_count: pending.length,
    missing_details: missing,
    summary_status: summaryStatus,
    menu_version: str(ctx.menu_version),
    menu_pages_available: pageCount,
    menu_already_sent: menuSentFor.includes(menuKey),
    photo_codes: photoCodes,
    reservations_on_whatsapp: rsvWa.length > 0,
    reservation_in_progress: !!draft,
    facts_text: factsText,
    business_text: businessText,
    menu_text: menuSafe,
    history_text: historyText,
    latest_text: latest,
    brief,
    brief_chars: brief.length
  }
}];
