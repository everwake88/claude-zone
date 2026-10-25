// =====================================================================
// EVERWAKE — Tool: manage_cart · NODE: Format Tool Response
//
// FACTS ONLY. No prose to repeat — the agent phrases everything itself.
// Each status says plainly what is now true, so the agent never has to
// guess whether the call worked.
// =====================================================================
const r = $('Apply + Recalculate').first().json;
const arr = (v) => Array.isArray(v) ? v : (v ? [v] : []);
let placed = null;
try { placed = $('Place Order').first().json; placed = placed && placed.r ? placed.r : placed; } catch (e) { placed = null; }
// paying online: the link the dashboard made with Paymob (only when the order needs one)
let payNeeded = false, pay = null;
try { const n = $('Payment Needed?').first().json; payNeeded = !!(n && n.r && n.r.needed); } catch (e) { payNeeded = false; }
if (payNeeded) { try { pay = $('Create Payment Link').first().json; } catch (e) { pay = null; } }
const payment = !payNeeded ? undefined
  : (pay && pay.ok && pay.link)
    ? { status: 'LINK_READY', link: pay.link, amount: pay.amount, works_until: pay.valid_until,
        fact: 'They pay online: put this payment link in your reply exactly as it is, with the amount and until when it works. The order is NOT paid until FACTS shows PAID — never say it is paid.' }
    : { status: (pay && pay.status) || 'LINK_FAILED', reason: pay && (pay.reason || (pay.error && (pay.error.message || pay.error))),
        fact: (pay && pay.fact) || 'The payment link could not be made right now. The order is placed; the team sends the link (or they can pay cash). Never invent a link.' };

const totals = {
  subtotal: r.subtotal,
  discount_total: r.discount_total,                 // offers, already taken off the total
  offers_applied: arr(r.offers_applied),
  offers_almost: arr(r.offers_almost),              // "add short_by more and this offer applies"
  vat_percent: r.vat_percent,                       // null = the branch confirms its fees
  vat: r.vat,
  delivery_fee: r.delivery_fee,                     // null = the branch confirms the fee
  delivery_fee_known: r.delivery_fee_known,
  delivery_zone: r.delivery_zone,
  total: r.total,
  currency_symbol: r.currency_symbol,
  branch_price_note: r.price_note,
  special_preparation_charge_pending_for: arr(r.extra_charge_items)
};
const problems = arr(r.cart_errors);
const changes = r.menu_changed ? r.menu_changes : undefined;
const out = (facts) => [{ json: { response: JSON.stringify(facts) } }];
const waiting = arr(r.pending_after).map(p => ({ pending_id: p.pid, name: p.name, levels_left: p.levels_left }));

// ---- a quote: what these dishes would cost, nothing added -------------------------------
if (r.action === 'quote') {
  return out({
    status: 'QUOTE',
    branch: r.branch_name,
    priced: r.cart_lines,
    ...totals,
    still_needs_a_choice: waiting,
    problems,
    fact: 'Nothing was added and their order is unchanged: these are the prices of the dishes you asked about, for a rough idea. Say the total in a few words (and what a dish still needs, if its price depends on a choice).'
  });
}

// ---- place_order --------------------------------------------------------------
if (r.action === 'place_order') {
  if (r.is_place && placed && placed.ok && placed.order_no) {
    return out({
      status: 'PLACED',
      order_no: placed.order_no,
      branch: r.branch_name,
      cart: r.cart_lines,
      ...totals,
      payment,
      fact: 'The order is placed and recorded for the branch. The cart is now empty; anything new starts a fresh order.'
    });
  }
  return out({
    status: 'NOT_PLACED',
    reasons: arr((r.place || {}).reasons),
    cart: r.cart_lines,
    ...totals,
    menu_changes: changes,
    items_waiting_on_choices: waiting,
    missing_details: arr(r.missing_details),
    fact: 'Nothing was placed. SUMMARY_NOT_SHOWN / SUMMARY_OUTDATED / MENU_CHANGED / TOTALS_CHANGED mean the customer must see and confirm an up-to-date summary first. BRANCH_CLOSED / BRANCH_BUSY: say when it can be ordered. OUT_OF_DELIVERY_AREA / ADDRESS_SERVED_BY_OTHER_BRANCH / DELIVERY_AREA_UNKNOWN: sort out the address or the branch, or offer pickup. PAYMENT_NOT_TAKEN_AT_BRANCH: that branch does not take their payment method — ask how they will pay from what it takes, save it, then show the summary again.'
  });
}

// ---- branch set / reorder ------------------------------------------------------------
if (r.action === 'set_branch' || r.action === 'reorder_last') {
  const pending = arr(r.pending_choices);
  return out({
    status: r.action === 'set_branch' ? 'BRANCH_SET' : 'REORDERED',
    branch: r.branch_name,
    branch_changed: r.branch_changed,
    menu_changes: changes,
    cart: r.cart_lines,
    ...totals,
    items_waiting_on_choices: waiting,
    next_question: pending[0] ? { pending_id: pending[0].pending_id, name: pending[0].item_name, ask_about: pending[0].ask_now } : null,
    problems,
    missing_details_for_order: arr(r.missing_details),
    payment_not_taken_here: r.payment_not_taken ? { method: r.payment_not_taken, this_branch_takes: arr(r.payment_methods_here) } : undefined,
    fact: r.action === 'set_branch'
      ? 'Every price and the menu now come from this branch.' + (r.payment_not_taken ? ' This branch does not take the payment method they chose — ask again from what it takes.' : '')
      : 'Their last order is back in the cart, priced from today\'s menu. Anything in problems or menu_changes did not come back as before — tell them.'
  });
}

// ---- a promo code ------------------------------------------------------------------------
if (r.action === 'apply_code') {
  const c = r.code_result || {};
  return out({
    status: c.status || 'CODE_NOT_VALID',
    code: c.code, offer: c.offer || null, min_subtotal: c.min_subtotal || null,
    cart: r.cart_lines,
    ...totals,
    fact: c.status === 'CODE_APPLIED'
      ? 'The code is saved for this order; discount_total shows what it takes off now (0 until its conditions are met).'
      : 'The code was not applied.'
  });
}

// ---- an item is waiting on a required choice ---------------------------------------------
const pending = arr(r.pending_choices);
if (pending.length) {
  const p = pending[0];
  return out({
    status: 'NEEDS_CHOICES',
    cart_saved: true,
    item_waiting: {
      pending_id: p.pending_id, menu_id: p.menu_id, name: p.item_name,
      quantity: p.quantity, unit: p.unit, price: p.base_price,
      already_answered: p.answered_so_far,
      auto_included: p.auto_filled || []
    },
    ask_about: { level: p.ask_now.level, label: p.ask_now.label_ar, pick_min: p.ask_now.min, pick_max: p.ask_now.max,
                 options: p.ask_now.options },
    still_to_ask_after_this: (p.remaining_preview || []).slice(1),
    other_items_waiting: pending.slice(1).map(x => ({ pending_id: x.pending_id, name: x.item_name, ask_about: x.ask_now })),
    menu_changes: changes,
    cart: r.cart_lines,
    ...totals,
    problems,
    fact: 'This item is not in the cart until its required choices are answered. Send pending_id back with the answer and earlier answers are kept.'
  });
}

// ---- done ----------------------------------------------------------------------------------
const optionalOpen = [];
for (const line of arr((r.cart || {}).items)) {
  for (const L of arr(line.optional_levels_open)) {
    optionalOpen.push({ line_id: line.line_id, item: line.display_name, level: L.level, label: L.label_ar, options: L.options });
  }
}
return out({
  status: 'DONE',
  cart_saved: true,
  branch: r.branch_name,
  menu_changes: changes,
  cart: r.cart_lines,
  ...totals,
  items_waiting_on_choices: waiting,
  optional_choices_available: optionalOpen,
  problems,
  missing_details_for_order: arr(r.missing_details),
  fact: (problems.some(x => x.code !== 'MATCHED_AS')
    ? 'The cart is saved as listed. Items in problems (other than MATCHED_AS) were NOT added; WHICH_ONE means ask the customer which of the candidates they mean.'
    : 'The cart is saved exactly as listed.')
    + (r.action === 'summary' && arr(r.missing_details).length
      ? ` It can't be placed yet: ${arr(r.missing_details).join(', ')} still open — ask that first, in a few words; a "yes" to a summary now would place nothing.`
      : '')
});
