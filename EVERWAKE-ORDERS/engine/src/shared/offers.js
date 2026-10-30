// ---- shared: offers --------------------------------------------------------
// The model persuades, the code calculates. Which offers run right now, and
// what they take off this cart, is decided here — never by the model.
function offerActiveNow(o, now, branchId) {
  const t = Date.now();
  if (o.starts_at && new Date(o.starts_at).getTime() > t) return false;
  if (o.ends_at && new Date(o.ends_at).getTime() <= t) return false;
  const days = (o.days_of_week || []).map(Number);
  if (days.length && !days.includes(now.day)) return false;
  if (o.time_from && o.time_to) {
    const f = toMin(o.time_from), to = toMin(o.time_to), m = now.minutes;
    const inside = f <= to ? (m >= f && m < to) : (m >= f || m < to);
    if (!inside) return false;
  }
  const br = (o.branch_ids || []).map(String);
  if (br.length && branchId && !br.includes(String(branchId))) return false;
  return true;
}

// ctx: { now, branchId, ordersCount, promoCodes[], deliveryFee, menuItems (branch lookup items) }
function applyOffers(lines, offers, ctx) {
  const codes = (ctx.promoCodes || []).map(c => String(c).toUpperCase());
  const paid = lines.filter(l => !l.gift);
  const subtotal = paid.reduce((s, l) => s + Number(l.line_total || 0), 0);
  const results = [];
  const almost = [];
  for (const o of offers || []) {
    if (!offerActiveNow(o, ctx.now, ctx.branchId)) continue;
    if (o.promo_code && !codes.includes(String(o.promo_code).toUpperCase())) continue;
    if (o.first_order_only && Number(ctx.ordersCount || 0) > 0) continue;
    // loyalty: only their every Nth order (the 10th, the 20th…)
    if (o.every_nth_order && (Number(ctx.ordersCount || 0) + 1) % Number(o.every_nth_order) !== 0) continue;
    const scoped = o.scope === 'items' ? paid.filter(l => (o.item_codes || []).includes(l.code))
                 : o.scope === 'categories' ? paid.filter(l => (o.category_ids || []).map(String).includes(String(l.category_id)))
                 : paid;
    if (o.scope !== 'order' && !scoped.length) continue;
    if (o.min_subtotal && subtotal < Number(o.min_subtotal)) {
      almost.push({ id: o.id, title: o.title_ar, short_by: Math.round((Number(o.min_subtotal) - subtotal) * 100) / 100 });
      continue;
    }
    const scopeTotal = scoped.reduce((s, l) => s + Number(l.line_total || 0), 0);
    const scopeQty = scoped.reduce((s, l) => s + (l.unit === 'kg' ? 1 : Number(l.quantity || 0)), 0);
    let amount = 0, gift = null, freeDelivery = false;
    if (o.kind === 'percent_off') amount = scopeTotal * Number(o.value || 0) / 100;
    else if (o.kind === 'amount_off') amount = o.scope === 'order' ? Number(o.value || 0) : Number(o.value || 0) * scopeQty;
    else if (o.kind === 'fixed_price') amount = scoped.reduce((s, l) => s + Math.max(0, Number(l.unit_price || 0) - Number(o.value || 0)) * (l.unit === 'kg' ? 1 : Number(l.quantity || 0)), 0);
    else if (o.kind === 'free_delivery') { if (ctx.deliveryFee > 0) { amount = ctx.deliveryFee; freeDelivery = true; } }
    else if (o.kind === 'free_item' && o.free_item_code) {
      const e = (ctx.menuItems || {})[o.free_item_code];
      if (e && e.available !== false && e.orderable !== false) gift = { code: o.free_item_code, name: e.name, quantity: Number(o.free_item_qty || 1), value: Number(e.price || 0) * Number(o.free_item_qty || 1), unit: e.unit, item_id: e.id };
    }
    if (o.max_discount) amount = Math.min(amount, Number(o.max_discount));
    amount = Math.min(amount, o.kind === 'free_delivery' ? amount : scopeTotal || subtotal);
    amount = Math.round(amount * 100) / 100;
    if (amount <= 0 && !gift) continue;
    results.push({ id: o.id, title: o.title_ar, title_en: o.title_en, kind: o.kind, amount, gift, free_delivery: freeDelivery,
                   stackable: !!o.stackable, priority: Number(o.priority || 100), promo_code: o.promo_code || null });
  }
  // every stackable offer applies; of the rest, only the best one
  const single = results.filter(r => !r.stackable).sort((a, b) => (b.amount + (b.gift ? b.gift.value : 0)) - (a.amount + (a.gift ? a.gift.value : 0)) || a.priority - b.priority)[0];
  const applied = results.filter(r => r.stackable).concat(single ? [single] : []);
  let itemDiscount = applied.filter(r => !r.free_delivery).reduce((s, r) => s + r.amount, 0);
  itemDiscount = Math.min(itemDiscount, subtotal);
  const deliveryDiscount = applied.filter(r => r.free_delivery).reduce((s, r) => s + r.amount, 0);
  return {
    subtotal: Math.round(subtotal * 100) / 100,
    item_discount: Math.round(itemDiscount * 100) / 100,
    delivery_discount: Math.min(Math.round(deliveryDiscount * 100) / 100, ctx.deliveryFee || 0),
    applied: applied.map(r => ({ id: r.id, title: r.title, kind: r.kind, amount: r.amount,
                                 gift: r.gift ? { code: r.gift.code, name: r.gift.name, quantity: r.gift.quantity } : null })),
    gifts: applied.filter(r => r.gift).map(r => ({ ...r.gift, offer_id: r.id, offer_title: r.title })),
    almost
  };
}
