import 'server-only';

// A cart from a QR code, priced on the server — the same arithmetic as the
// WhatsApp agent's cart (engine/src/cart/apply_recalculate.js) and the same
// offers (engine/src/shared/offers.js, ported below: keep the two in step).
// The customer's browser only says which dishes, how many and which choices;
// every price comes from the branch's menu snapshot.

type Obj = Record<string, unknown>;
interface Option { name: string; price: number | null; extra_charge?: boolean }
interface Level { level: number; label_ar: string; required: boolean; min: number | null; max: number | null; options: Option[] }
interface MenuEntry {
  id: string; name: string; price: number | null; unit: string; qty_step: number | null; min_qty: number | null;
  category_id: string | null; orderable: boolean; available: boolean; sold_out_until: string | null;
}
export interface PricingContext {
  ok: boolean; error?: string; tenant_id: string; branch_id: string; branch_state: string; timezone: string;
  vat_percent: number | null; currency: string; items: Record<string, MenuEntry>; choices: Record<string, { levels: Level[] }> | null;
  offers: Obj[] | null; orders_count: number; table: string | null;
}
export interface CartRequestLine { code: string; quantity: number; choices?: { level: number; selected: string[] }[]; notes?: string }
export interface PricedLine {
  line_id: string; item_id: string | null; code: string; item_name: string; display_name: string; unit: string; quantity: number;
  unit_price: number; line_total: number; choices: { level: number; label_ar: string; selected: { name: string; adds: number }[] }[];
  notes: string | null; gift?: boolean; offer_id?: string; offer_title?: string;
}
export interface Priced {
  ok: boolean; error?: string; detail?: string;
  lines: PricedLine[]; subtotal: number; discount_total: number; applied_offers: Obj[]; vat: number | null; total: number;
}

const money = (n: number) => Math.round(n * 100) / 100;
const DAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
const toMin = (t: unknown) => { const [h, m] = String(t || '0:0').split(':').map(Number); return (h || 0) * 60 + (m || 0); };

function localNow(tz: string) {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: tz || 'Africa/Cairo', weekday: 'short', hour: '2-digit', minute: '2-digit', hour12: false })
    .formatToParts(new Date());
  const g = (t: string) => parts.find(p => p.type === t)?.value || '';
  return { day: DAYS.indexOf(g('weekday').toLowerCase().slice(0, 3)), minutes: (Number(g('hour')) % 24) * 60 + Number(g('minute')) };
}

// ---- offers (engine/src/shared/offers.js) ---------------------------------------
function offerActiveNow(o: Obj, now: { day: number; minutes: number }, branchId: string) {
  const t = Date.now();
  if (o.starts_at && new Date(String(o.starts_at)).getTime() > t) return false;
  if (o.ends_at && new Date(String(o.ends_at)).getTime() <= t) return false;
  const days = ((o.days_of_week as unknown[]) || []).map(Number);
  if (days.length && !days.includes(now.day)) return false;
  if (o.time_from && o.time_to) {
    const f = toMin(o.time_from), to = toMin(o.time_to), m = now.minutes;
    if (!(f <= to ? (m >= f && m < to) : (m >= f || m < to))) return false;
  }
  const br = ((o.branch_ids as unknown[]) || []).map(String);
  return !(br.length && branchId && !br.includes(String(branchId)));
}

function applyOffers(lines: PricedLine[], offers: Obj[], ctx: { now: { day: number; minutes: number }; branchId: string;
                     ordersCount: number; items: Record<string, MenuEntry> }) {
  const paid = lines.filter(l => !l.gift);
  const subtotal = paid.reduce((s, l) => s + l.line_total, 0);
  const results: { id: string; title: string; kind: string; amount: number; gift: { code: string; name: string; quantity: number; value: number; unit: string; item_id: string } | null;
                   stackable: boolean; priority: number }[] = [];
  for (const o of offers) {
    if (!offerActiveNow(o, ctx.now, ctx.branchId)) continue;
    if (o.promo_code) continue;                                   // codes are for the WhatsApp chat
    if (o.first_order_only && ctx.ordersCount > 0) continue;
    if (o.every_nth_order && (ctx.ordersCount + 1) % Number(o.every_nth_order) !== 0) continue;
    const scoped = o.scope === 'items' ? paid.filter(l => ((o.item_codes as string[]) || []).includes(l.code))
      : o.scope === 'categories' ? paid.filter(l => ((o.category_ids as string[]) || []).map(String).includes(String(ctx.items[l.code]?.category_id)))
      : paid;
    if (o.scope !== 'order' && !scoped.length) continue;
    if (o.min_subtotal && subtotal < Number(o.min_subtotal)) continue;
    const scopeTotal = scoped.reduce((s, l) => s + l.line_total, 0);
    const scopeQty = scoped.reduce((s, l) => s + (l.unit === 'kg' ? 1 : l.quantity), 0);
    let amount = 0;
    let gift = null;
    if (o.kind === 'percent_off') amount = scopeTotal * Number(o.value || 0) / 100;
    else if (o.kind === 'amount_off') amount = o.scope === 'order' ? Number(o.value || 0) : Number(o.value || 0) * scopeQty;
    else if (o.kind === 'fixed_price') amount = scoped.reduce((s, l) => s + Math.max(0, l.unit_price - Number(o.value || 0)) * (l.unit === 'kg' ? 1 : l.quantity), 0);
    else if (o.kind === 'free_item' && o.free_item_code) {
      const e = ctx.items[String(o.free_item_code)];
      if (e && e.available !== false && e.orderable !== false)
        gift = { code: String(o.free_item_code), name: e.name, quantity: Number(o.free_item_qty || 1), value: Number(e.price || 0) * Number(o.free_item_qty || 1), unit: e.unit, item_id: e.id };
    }
    if (o.max_discount) amount = Math.min(amount, Number(o.max_discount));
    amount = money(Math.min(amount, scopeTotal || subtotal));
    if (amount <= 0 && !gift) continue;
    results.push({ id: String(o.id), title: String(o.title_ar || ''), kind: String(o.kind), amount, gift, stackable: !!o.stackable, priority: Number(o.priority || 100) });
  }
  const single = results.filter(r => !r.stackable)
    .sort((a, b) => (b.amount + (b.gift ? b.gift.value : 0)) - (a.amount + (a.gift ? a.gift.value : 0)) || a.priority - b.priority)[0];
  const applied = results.filter(r => r.stackable).concat(single ? [single] : []);
  const itemDiscount = Math.min(applied.reduce((s, r) => s + r.amount, 0), subtotal);
  return {
    subtotal: money(subtotal), item_discount: money(itemDiscount),
    applied: applied.map(r => ({ id: r.id, title: r.title, kind: r.kind, amount: r.amount,
                                 gift: r.gift ? { code: r.gift.code, name: r.gift.name, quantity: r.gift.quantity } : null })),
    gifts: applied.filter(r => r.gift).map(r => ({ ...r.gift!, offer_id: r.id, offer_title: r.title }))
  };
}

// ---- the cart ------------------------------------------------------------------------
export function priceCart(ctx: PricingContext, request: CartRequestLine[]): Priced {
  const fail = (error: string, detail?: string): Priced =>
    ({ ok: false, error, detail, lines: [], subtotal: 0, discount_total: 0, applied_offers: [], vat: null, total: 0 });
  if (!Array.isArray(request) || !request.length) return fail('EMPTY');
  if (request.length > 40) return fail('TOO_MANY');
  const items = ctx.items || {};
  const lines: PricedLine[] = [];
  for (const [i, r] of request.entries()) {
    const e = items[String(r.code)];
    if (!e) return fail('NOT_ON_MENU', r.code);
    if (e.available === false || (e.sold_out_until && new Date(e.sold_out_until) > new Date())) return fail('SOLD_OUT', e.name);
    if (e.orderable === false && !ctx.table) return fail('DINE_IN_ONLY', e.name);
    if (e.price == null) return fail('NO_PRICE', e.name);
    // the quantity: whole portions, or kilos in the dish's own steps
    const step = e.unit === 'kg' ? Number(e.qty_step || 0.25) : 1;
    let q = Number(r.quantity);
    if (!Number.isFinite(q) || q <= 0 || q > 50) return fail('QUANTITY', e.name);
    q = Math.round(q / step) * step;
    if (e.min_qty && q < Number(e.min_qty)) q = Number(e.min_qty);
    // the choices: each answered from the dish's own, required ones present
    const levels = ctx.choices?.[r.code]?.levels || [];
    const chosen: PricedLine['choices'] = [];
    let adds = 0;
    for (const lv of levels) {
      const picked = (r.choices || []).find(c => Number(c.level) === Number(lv.level))?.selected || [];
      const names = [...new Set(picked.map(String))];
      const min = lv.required ? Math.max(1, Number(lv.min || 1)) : Number(lv.min || 0);
      if (names.length < min) return fail('CHOICE_MISSING', `${e.name}: ${lv.label_ar}`);
      if (lv.max && names.length > Number(lv.max)) return fail('CHOICE_TOO_MANY', `${e.name}: ${lv.label_ar}`);
      const sel: { name: string; adds: number }[] = [];
      for (const n of names) {
        const opt = lv.options.find(o => o.name === n);
        if (!opt) return fail('CHOICE_UNKNOWN', `${e.name}: ${n}`);
        if (opt.extra_charge) return fail('CHOICE_PRICED_AT_BRANCH', `${e.name}: ${n}`);
        sel.push({ name: n, adds: Number(opt.price || 0) });
        adds += Number(opt.price || 0);
      }
      if (sel.length) chosen.push({ level: lv.level, label_ar: lv.label_ar, selected: sel });
    }
    const unit = money(Number(e.price) + adds);
    const names = chosen.flatMap(c => c.selected.map(s => s.name));
    lines.push({
      line_id: 'Q' + (i + 1), item_id: e.id || null, code: r.code, item_name: e.name,
      display_name: names.length ? `${e.name} (${names.join('، ')})` : e.name,
      unit: e.unit, quantity: q, unit_price: unit, line_total: money(unit * q), choices: chosen,
      notes: r.notes ? String(r.notes).slice(0, 200) : null
    });
  }
  const offers = applyOffers(lines, (ctx.offers || []) as Obj[], {
    now: localNow(ctx.timezone), branchId: ctx.branch_id, ordersCount: Number(ctx.orders_count || 0), items });
  let g = 0;
  for (const gift of offers.gifts) {
    lines.push({ line_id: 'G' + (++g), item_id: gift.item_id || null, code: gift.code, item_name: gift.name, display_name: gift.name,
                 unit: gift.unit, quantity: gift.quantity, unit_price: 0, line_total: 0, choices: [], notes: null,
                 gift: true, offer_id: gift.offer_id, offer_title: gift.offer_title });
  }
  const vat = ctx.vat_percent == null ? null : money((offers.subtotal - offers.item_discount) * Number(ctx.vat_percent) / 100);
  return { ok: true, lines, subtotal: offers.subtotal, discount_total: offers.item_discount, applied_offers: offers.applied,
           vat, total: money(offers.subtotal - offers.item_discount + (vat || 0)) };
}
