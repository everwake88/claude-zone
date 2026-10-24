// =====================================================================
// EVERWAKE — Tool: manage_cart · NODE: Apply + Recalculate
//
// Owns ALL cart math, the branch the order goes to, the offers, and
// placing the order. Prices only ever come from the branch menu
// snapshot; the agent cannot supply one.
//
// actions
//   add | update | remove | replace | clear   — the cart
//   set_branch    — choose / change the branch; the whole cart and every
//                   half-configured item is re-checked and re-priced
//   reorder_last  — the customer's latest order back in the cart,
//                   re-priced from today's menu
//   apply_code    — a promo code the customer gave ([{"promo_code":"X"}])
//   place_order   — final step. Refuses unless the cart, the details, the
//                   branch (open, taking orders), the delivery area and
//                   the confirmed summary all check out.
//
// Every call first re-checks the cart against the live menu: a dish the
// restaurant switched off since it went in the cart is taken out and
// reported, a changed price is re-priced — and an order is never placed
// on a menu that changed under the customer.
//
// From Seagull (all live-tested): choice levels asked one at a time,
// pending_id accumulation, stable line ids, amend-not-duplicate, single-
// answer levels auto-filled, the ledger.
// =====================================================================
// @include shared/basics.js
// @include shared/arabic.js
// @include shared/clock.js
// @include shared/offers.js

const args = $('Read Args').first().json;
const db = row($input.first().json);
const nowIso = new Date().toISOString();

const state = obj(db.state);
const customer = obj(state.customer);
const location = obj(state.location);
const ledger = obj(state.ledger);
const zone = state.zone && typeof state.zone === 'object' ? state.zone : null;
const all = obj(db.all_lookup);
const tenant = obj(all.tenant);
const settings = obj(all.settings);
const branches = arr(all.branches);
const allItems = obj(all.items);
const branchStates = obj(db.branch_states);
const prevPending = arr(ledger.pending_items);
const prevCartLog = arr(ledger.cart_log);
const tz = str(tenant.timezone) || 'Africa/Cairo';
const now = localNow(tz);

const currentBranchId = str(obj(state.branch).id);
const branchById = (id) => branches.find(b => str(b.id) === str(id)) || null;
const branchName = (id) => str(obj(branchById(id)).name_ar) || id;
const branchByCode = (code) => branches.find(b => str(b.code) === str(code)) || null;

const activeOrder = db.active_order && db.active_order !== 'null' ? obj(db.active_order) : {};
const seedCart = obj(activeOrder.cart).items ? obj(activeOrder.cart) : { items: [] };

const ALLOWED = ['add', 'update', 'remove', 'replace', 'clear', 'set_branch', 'place_order', 'reorder_last', 'apply_code', 'summary'];
// "summary": nothing changes — the order is re-priced with what is known now (the delivery
// area saved since the last call, today's menu) and the totals come back for the summary
const SUMMARY_WORDS = ['summary', 'view', 'show', 'recalculate', 'totals', 'review', 'get', 'status'];
const asked = str(args.action).toLowerCase();
const action = SUMMARY_WORDS.includes(asked) ? 'summary' : (ALLOWED.includes(asked) ? asked : '');

function fail(code, facts) {
  return [{ json: { ok: false, error_code: code, facts: facts || {}, tenant_id: args.tenant_id, wa_id: args.wa_id } }];
}
if (!action) return fail('BAD_ACTION', { allowed: ALLOWED });

// ---- arguments ------------------------------------------------------------
let patchItems = [];
if (['add', 'update', 'remove', 'replace', 'apply_code'].includes(action)) {
  try {
    const raw = args.items_json;
    patchItems = typeof raw === 'string' ? JSON.parse(raw || '[]') : arr(raw);
    if (!Array.isArray(patchItems)) patchItems = [patchItems];
  } catch (e) {
    return fail('BAD_ITEMS_JSON', {
      expected: '[{"menu_id":"M003","quantity":1,"choices":[{"level":1,"selected":["فرخة كاملة"]}],"notes":null}]'
    });
  }
}

// accepted line choices -> the raw shape resolveChoices reads
const rawFromAccepted = (ch) => arr(ch).map(c => ({ level: c.level, selected: arr(c.selected).map(s => str(obj(s).name || s)) }));

// ---------------------------------------------------------------------
// The menu this call works against: the NEW branch for set_branch (and a
// reorder with no branch yet), otherwise the branch already chosen.
// ---------------------------------------------------------------------
let targetBranchId = currentBranchId;
let lookup = obj(db.menu_lookup);
let branchSetBy = null;
let effective = action;

if (action === 'set_branch') {
  const reqId = str(db.requested_branch_id);
  if (!reqId) {
    return fail('BRANCH_NOT_FOUND', {
      requested: str(args.branch_id),
      branches: branches.map(b => ({ code: b.code, name: b.name_ar, state: branchStates[b.id] || 'unknown' }))
    });
  }
  const br = branchById(reqId);
  if (!br || br.accepting_orders === false) {
    return fail('BRANCH_NOT_ACCEPTING', {
      branch: { code: obj(br).code, name: branchName(reqId), seasonal: !!obj(br).seasonal, hours: str(obj(br).hours_text_ar) },
      open_branches: branches.filter(b => b.accepting_orders !== false).map(b => ({ code: b.code, name: b.name_ar, area: b.area_ar, state: branchStates[b.id] }))
    });
  }
  targetBranchId = reqId;
  lookup = obj(db.requested_lookup);
  branchSetBy = 'agent';
}

if (action === 'reorder_last') {
  const last = obj(db.last_order);
  const lastItems = arr(last.items).filter(i => !i.gift);
  if (!lastItems.length) return fail('NO_PREVIOUS_ORDER', {});
  if (!targetBranchId) {
    const reqId = str(db.requested_branch_id);
    const br = branchById(reqId);
    if (!reqId || !br || br.accepting_orders === false) {
      return fail('BRANCH_NEEDED', {
        reason: 'the branch of their last order is not taking orders — choose a branch first',
        open_branches: branches.filter(b => b.accepting_orders !== false).map(b => ({ code: b.code, name: b.name_ar, area: b.area_ar }))
      });
    }
    targetBranchId = reqId;
    lookup = obj(db.requested_lookup);
    branchSetBy = 'reorder';
  }
  patchItems = lastItems.map(i => ({ menu_id: i.code, item_name: i.display_name || i.item_name, quantity: i.quantity,
                                     choices: rawFromAccepted(i.choices), notes: i.notes || null }));
  effective = 'add';
}

if (['add', 'update', 'remove', 'replace'].includes(effective) && !targetBranchId) {
  // nothing is priced until the branch is known: each can have its own menu and prices
  const wanted = patchItems.map(p => {
    const id = str(obj(p).menu_id).toUpperCase();
    const hit = allItems[id] ? { id, e: allItems[id] } : findIn(allItems, str(obj(p).item_name) || id);
    return hit
      ? { menu_id: hit.id, name: hit.e.name, branches: arr(hit.e.branches).map(c => obj(branchByCode(c)).name_ar || c) }
      : { requested: str(obj(p).item_name) || id, branches: [] };
  });
  return fail('BRANCH_NEEDED', {
    wanted,
    open_branches: branches.filter(b => b.accepting_orders !== false).map(b => ({ code: b.code, name: b.name_ar, area: b.area_ar, serves: b.serves_hint_ar }))
  });
}
const branchInfo = branchById(targetBranchId) || {};
const menuItems = obj(lookup.items);
const menuChoices = obj(lookup.choices);

// ---- text matching ---------------------------------------------------------
function labelsOf(e) {
  return [e.name, e.name_en].concat(arr(e.aliases)).filter(Boolean).map(normalizeArabic).filter(Boolean);
}
// the other branches worth offering for a dish this branch doesn't have: taking orders now, and
// for a delivery, only the ones that deliver where the customer is (never Cairo to Alexandria)
function branchesThatCanTakeIt(codes) {
  const delivery = str(customer.delivery_method).toLowerCase() !== 'pickup';
  const area = normalizeArabic(str(customer.address_area));
  return codes.map(c => branchByCode(c)).filter(b => b && str(b.id) !== str(targetBranchId)
    && b.accepting_orders !== false && !['not_accepting', 'closed', 'paused'].includes(str(branchStates[b.id])))
    .filter(b => !delivery || (!area && !zone) || arr(all.zones).some(z => str(z.branch_id) === str(b.id)
      && ((zone && str(z.id) === str(zone.id)) || (area && arr(z.areas).some(a => normalizeArabic(str(a)) === area)))))
    .map(b => str(b.name_ar));
}

function findIn(items, text) {
  const target = normalizeArabic(text);
  if (!target) return null;
  let partial = null;
  for (const [key, e] of Object.entries(items)) {
    const ls = labelsOf(e);
    if (ls.includes(target)) return { id: key, e };
    if (!partial && ls.some(n => n.length >= 3 && (n.includes(target) || target.includes(n)))) partial = { id: key, e };
  }
  return partial;
}

// a code first; a name is accepted only when it points at ONE dish
function resolveMenuItem(p) {
  const id = str(p.menu_id).toUpperCase();
  if (id && menuItems[id]) return { id, entry: menuItems[id] };
  const target = normalizeArabic(p.item_name || (id && !menuItems[id] && allItems[id] ? allItems[id].name : p.menu_id));
  if (!target) return null;
  const exact = [], partial = [];
  for (const [key, e] of Object.entries(menuItems)) {
    const ls = labelsOf(e);
    if (ls.includes(target)) exact.push({ id: key, entry: e });
    else if (ls.some(n => n.length >= 3 && (n.includes(target) || target.includes(n)))) partial.push({ id: key, entry: e });
  }
  if (exact.length === 1) return exact[0];
  // a dish the restaurant has but this branch doesn't sell: never swap in a
  // look-alike ("جمبري وسط" → "جمبري وسط قزاز" is another dish at another
  // price) — the customer is told and chooses
  if (id && allItems[id] && !p.item_name) return exact.length > 1 ? { ambiguous: exact.slice(0, 6) } : null;
  const pool = exact.length ? exact : partial;
  if (pool.length === 1) return { ...pool[0], inexact: true };
  if (pool.length > 1) return { ambiguous: pool.slice(0, 6) };
  return null;
}

const soldOut = (e) => e.available === false || (e.sold_out_until && new Date(e.sold_out_until).getTime() > Date.now());
function outsideWindow(e) {
  const w = e.window;
  if (!w || !w.from || !w.to) return false;
  const f = toMin(w.from), t = toMin(w.to), m = now.minutes;
  return f <= t ? !(m >= f && m < t) : !(m >= f || m < t);
}

// ---- choices engine (Seagull / 5 Roosters V3 behaviour) ---------------------
function matchOption(levelDef, wanted) {
  const target = normalizeArabic(wanted);
  if (!target) return null;
  const opts = arr(levelDef.options);
  const labels = (o) => [o.name, o.name_en].concat(arr(o.aliases)).filter(Boolean).map(normalizeArabic).filter(Boolean);
  for (const o of opts) if (labels(o).some(n => n === target)) return o;
  let partial = null;
  for (const o of opts) if (labels(o).some(n => n.includes(target) || target.includes(n))) { partial = partial || o; }
  return partial;
}

function resolveChoices(choicesMap, code, parentName, rawChoices) {
  const levels = arr(obj(choicesMap[code]).levels);
  if (!levels.length) {
    return { needs: null, accepted: [], addon_total: 0, errors: [], optional_pending: [],
             done_levels: [], required_pending: [], auto_filled: [] };
  }
  const sent = placeChoices(choicesMap, code, rawChoices).byLevel;
  const accepted = [], autoFilled = [], errors = [], doneLevels = [], requiredPending = [], optionalPending = [];
  let addonTotal = 0;

  for (const L of levels) {
    const picks = sent[L.level] || [];
    const minSel = num(L.min, 0);
    const maxSel = L.max == null ? arr(L.options).length : num(L.max, arr(L.options).length);
    const isRequired = !!L.required && minSel >= 1 && arr(L.options).length > 0;

    if (!picks.length) {
      const opts = arr(L.options);
      const forced = isRequired && opts.length === minSel && opts.every(o => !money(o.price));
      if (forced) {
        accepted.push({ level: L.level, label_ar: L.label_ar || null, required: true,
          selected: opts.map(o => ({ name: o.name, adds: 0 })), adds: 0, auto: true });
        doneLevels.push(L.level);
        autoFilled.push({ level: L.level, names: opts.map(o => o.name) });
        continue;
      }
      if (isRequired) requiredPending.push(L); else optionalPending.push(L);
      continue;
    }
    const resolvedPicks = [];
    for (const p of picks) {
      const found = matchOption(L, p);
      if (!found) {
        errors.push({ code: 'CHOICE_NOT_IN_LEVEL', menu_id: code, item_name: parentName,
          level: L.level, label: L.label_ar, requested: p, available: arr(L.options).map(o => o.name) });
        continue;
      }
      if (resolvedPicks.some(x => x.name === found.name)) continue;
      resolvedPicks.push(found);
    }
    if (resolvedPicks.length < minSel) {
      errors.push({ code: 'CHOICE_TOO_FEW', menu_id: code, item_name: parentName, level: L.level,
        need: minSel, got: resolvedPicks.length, available: arr(L.options).map(o => o.name) });
      if (isRequired) requiredPending.push(L);
      continue;
    }
    if (resolvedPicks.length > maxSel) {
      errors.push({ code: 'CHOICE_TOO_MANY', menu_id: code, item_name: parentName, level: L.level,
        max: maxSel, got: resolvedPicks.length });
      if (isRequired) requiredPending.push(L);
      continue;
    }
    const lvlAdd = resolvedPicks.reduce((s, o) => s + money(o.price), 0);
    addonTotal += lvlAdd;
    accepted.push({ level: L.level, label_ar: L.label_ar || null, required: !!L.required,
      selected: resolvedPicks.map(o => ({ name: o.name, adds: money(o.price), extra_charge: o.extra_charge === true || undefined })),
      adds: money(lvlAdd) });
    doneLevels.push(L.level);
  }
  const describe = (L) => ({
    level: L.level, label_ar: L.label_ar || null, required: !!L.required,
    min: num(L.min, L.required ? 1 : 0),
    max: L.max == null ? arr(L.options).length : num(L.max, arr(L.options).length),
    options: arr(L.options).map(o => ({ name: o.name, adds: money(o.price) }))
  });
  requiredPending.sort((a, b) => a.level - b.level);
  return {
    needs: requiredPending[0] ? describe(requiredPending[0]) : null,
    accepted, auto_filled: autoFilled, addon_total: money(addonTotal), errors,
    done_levels: doneLevels,
    required_pending: requiredPending.map(describe),
    optional_pending: optionalPending.sort((a, b) => a.level - b.level).map(describe)
  };
}

// Put every answer on the level it actually belongs to: the agent may send
// the right option under the wrong level, or with no level at all.
function placeChoices(choicesMap, code, rawChoices) {
  const levels = arr(obj(choicesMap[code]).levels);
  const byNum = {};
  for (const L of levels) byNum[L.level] = L;
  const byLevel = {};
  const unplaced = [];
  const put = (l, v) => { (byLevel[l] = byLevel[l] || []); if (byLevel[l].indexOf(v) === -1) byLevel[l].push(v); };
  for (const c of arr(rawChoices)) {
    const lvl = num(obj(c).level, 0);
    const sel = arr(obj(c).selected !== undefined ? c.selected : (obj(c).options !== undefined ? c.options : c))
      .map(x => str(obj(x).name || x)).filter(Boolean);
    for (const pick of sel) {
      if (lvl && byNum[lvl] && matchOption(byNum[lvl], pick)) { put(lvl, pick); continue; }
      const home = levels.find(L => matchOption(L, pick));
      if (home) { put(home.level, pick); continue; }
      if (lvl && byNum[lvl]) { put(lvl, pick); continue; }   // reported as CHOICE_NOT_IN_LEVEL
      unplaced.push(pick);
    }
  }
  return { byLevel, unplaced, levels };
}
function choicesFromLevels(byLevel) {
  return Object.keys(byLevel).sort((a, b) => a - b).map(l => ({ level: Number(l), selected: byLevel[l] }));
}

// ---- units -------------------------------------------------------------------
const UNIT_AR = { kg: 'كيلو', piece: 'قطعة', person: 'فرد', portion: '' };
function normQty(entry, q, fallback) {
  const unit = str(entry.unit) || 'portion';
  let n = num(q, fallback == null ? 1 : fallback);
  if (unit === 'kg') {
    const step = num(entry.qty_step, 0.25) || 0.25;
    const min = num(entry.min_qty, 0.25) || 0.25;
    n = Math.round(n / step) * step;
    if (n < min) n = min;
    if (n > 20) n = 20;
    return Math.round(n * 100) / 100;
  }
  n = Math.round(n);
  if (n < 1) n = 1;
  if (n > 50) n = 50;
  return n;
}

// ---- suggestions (this branch only, tag based) --------------------------------
function suggestAlternatives(query, limit) {
  const q = normalizeArabic(query);
  const qTokens = q.split(' ').filter(t => t.length > 2);
  const fromAll = findIn(allItems, query);
  const wantTags = fromAll ? arr(obj(menuItems[fromAll.id]).tags).concat(arr(fromAll.e.tags)) : [];
  const scored = [];
  for (const [id, e] of Object.entries(menuItems)) {
    if (e.orderable === false || soldOut(e)) continue;
    const hay = normalizeArabic([e.name, e.name_en, e.category, e.desc].join(' '));
    let score = 0;
    for (const t of qTokens) if (hay.indexOf(t) !== -1) score += 3;
    for (const t of arr(e.tags)) if (wantTags.indexOf(t) !== -1) score += 2;
    if (e.signature || e.featured) score += score ? 1 : 0;
    if (score > 0) scored.push({ menu_id: id, name: e.name, price: e.price, unit: e.unit, score });
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, limit || 3).map(({ score, ...x }) => x);
}

// ---- lines --------------------------------------------------------------------------
function lineKey(i) {
  const ch = arr(i.choices)
    .map(c => `${c.level}=${arr(c.selected).map(s => normalizeArabic(s.name || s)).sort().join('+')}`)
    .sort().join(';');
  return [str(i.code).toLowerCase(), normalizeArabic(i.notes || ''), ch].join('::');
}
function buildLine(code, entry, p, cr, qtyFallback) {
  const qty = normQty(entry, obj(p).quantity, qtyFallback);
  const priceKnown = entry.price != null && entry.price !== '';
  const base = money(entry.price);
  const unitPrice = money(base + money(cr.addon_total));
  return {
    item_id: entry.id || null, code, item_name: entry.name, name_en: entry.name_en || null, display_name: entry.name,
    category: entry.category || null, category_id: entry.category_id || null, unit: entry.unit || 'portion',
    quantity: qty, base_price: base, price_known: priceKnown,
    choices: cr.accepted, choices_total: money(cr.addon_total),
    unit_price: unitPrice, line_total: money(unitPrice * qty),
    // a preparation the branch charges extra for, without a published price
    extra_charge: arr(cr.accepted).some(c => arr(c.selected).some(s => s.extra_charge === true)),
    notes: str(obj(p).notes) || null
  };
}

// ---- seed the cart from the DB, never from the agent ----------------------------------
let lineSeq = num(ledger.line_seq, 0);
for (const i of arr(seedCart.items)) {
  const m = /^L(\d+)$/.exec(str(i.line_id));
  if (m) lineSeq = Math.max(lineSeq, num(m[1]));
}
const nextLineId = () => 'L' + (++lineSeq);

// gift lines are rebuilt from the offers at the end of every call
let items = arr(seedCart.items).filter(i => !i.gift).map(i => ({ ...i, line_id: str(i.line_id) || nextLineId() }));
const cartErrors = [];
const pendingChoices = [];
const resolvedPids = [];
const menuChanges = { removed: [], repriced: [], to_pending: [], pending_dropped: [] };
let carriedPending = prevPending.slice();

// =========================================================================
// re-check every line against the menu this call works with
// (a new branch on set_branch; otherwise today's state of the same menu)
// =========================================================================
if (targetBranchId) {
  const kept = [];
  for (const line of items) {
    const entry = menuItems[str(line.code)];
    if (!entry || entry.orderable === false || soldOut(entry)) {
      menuChanges.removed.push({ line_id: line.line_id, name: line.display_name || line.item_name,
        reason: !entry ? 'NOT_ON_THIS_BRANCH_MENU' : (entry.orderable === false ? 'DINE_IN_ONLY' : 'SOLD_OUT'),
        suggestions: suggestAlternatives(line.display_name || line.item_name, 2) });
      continue;
    }
    const cr = resolveChoices(menuChoices, line.code, entry.name, rawFromAccepted(line.choices));
    if (cr.needs) {
      const pid = 'P' + (carriedPending.length + 1) + '-' + line.code;
      carriedPending.push({ pid, code: line.code, name: entry.name, quantity: line.quantity,
        choices: rawFromAccepted(cr.accepted), levels_done: cr.done_levels,
        levels_left: cr.required_pending.map(x => x.level), notes: line.notes || null, at: nowIso });
      menuChanges.to_pending.push({ name: entry.name, ask_about: cr.needs });
      continue;
    }
    const rebuilt = buildLine(line.code, entry, { quantity: line.quantity, notes: line.notes }, cr, line.quantity);
    rebuilt.line_id = line.line_id;
    if (money(rebuilt.line_total) !== money(line.line_total)) {
      menuChanges.repriced.push({ line_id: line.line_id, name: rebuilt.display_name,
        was: money(line.line_total), now: rebuilt.line_total });
    }
    kept.push(rebuilt);
  }
  items = kept;
  carriedPending = carriedPending.filter(p => {
    const e = menuItems[str(p.code)];
    if (!e || e.orderable === false || soldOut(e)) {
      menuChanges.pending_dropped.push({ name: p.name, reason: !e ? 'NOT_ON_THIS_BRANCH_MENU' : 'NOT_AVAILABLE' });
      return false;
    }
    return true;
  });
}
const menuChanged = !!(menuChanges.removed.length || menuChanges.repriced.length || menuChanges.to_pending.length || menuChanges.pending_dropped.length);

// =========================================================================
// a promo code
// =========================================================================
let promoCodes = arr(ledger.promo_codes).map(c => str(c).toUpperCase());
let codeResult = null;
if (action === 'apply_code') {
  const wanted = str(obj(patchItems[0]).promo_code || obj(patchItems[0]).code || patchItems[0]).toUpperCase().replace(/\s+/g, '');
  const offer = arr(all.offers).find(o => o.promo_code && str(o.promo_code).toUpperCase().replace(/\s+/g, '') === wanted);
  if (!wanted || !offer) codeResult = { status: 'CODE_NOT_VALID', code: wanted };
  else if (!offerActiveNow(offer, now, targetBranchId || null)) codeResult = { status: 'CODE_NOT_ACTIVE_NOW', code: wanted, offer: offer.title_ar };
  else if (offer.first_order_only && num(db.orders_count) > 0) codeResult = { status: 'CODE_FIRST_ORDER_ONLY', code: wanted, offer: offer.title_ar };
  else {
    if (!promoCodes.includes(str(offer.promo_code).toUpperCase())) promoCodes.push(str(offer.promo_code).toUpperCase());
    codeResult = { status: 'CODE_APPLIED', code: wanted, offer: offer.title_ar, min_subtotal: offer.min_subtotal || null };
  }
}

// =========================================================================
// cart actions
// =========================================================================
if (effective === 'clear') {
  items = [];
  carriedPending = [];
} else if (['add', 'update', 'remove', 'replace'].includes(effective)) {
  for (const p0 of patchItems) {
    const p = { ...obj(p0) };
    // "update line L4" with no dish named: the dish is the one on that line
    if (!str(p.menu_id) && !str(p.item_name) && str(p.line_id)) {
      const onLine = items.find(i => str(i.line_id) === str(p.line_id));
      if (onLine) p.menu_id = str(onLine.code);
    }
    const resolved = resolveMenuItem(p);
    if (resolved && resolved.ambiguous) {
      cartErrors.push({ code: 'WHICH_ONE', requested: str(p.item_name) || str(p.menu_id),
        candidates: resolved.ambiguous.map(c => ({ menu_id: c.id, name: c.entry.name, price: c.entry.price, unit: c.entry.unit })) });
      continue;
    }
    if (resolved && resolved.inexact) {
      cartErrors.push({ code: 'MATCHED_AS', requested: str(p.item_name), matched: resolved.entry.name, menu_id: resolved.id,
        note: 'added under this name — tell the customer which dish it is' });
    }
    if (!resolved) {
      const requested = str(p.item_name) || str(p.menu_id);
      const elsewhere = findIn(allItems, requested) || (allItems[str(p.menu_id).toUpperCase()] ? { id: str(p.menu_id).toUpperCase(), e: allItems[str(p.menu_id).toUpperCase()] } : null);
      if (elsewhere && arr(elsewhere.e.branches).length) {
        // by the dish's name, not its code: "جمبري وسط" finds this branch's other shrimp
        const dishName = str(elsewhere.e.name) || requested;
        const availableAt = branchesThatCanTakeIt(arr(elsewhere.e.branches));
        cartErrors.push({ code: 'NOT_ON_THIS_BRANCH_MENU', requested: dishName, branch: branchName(targetBranchId),
          available_at: availableAt, suggestions: suggestAlternatives(dishName, 4),
          note: 'offer the suggestions (this branch\'s closest dishes) by name and price'
            + (availableAt.length ? ', or the branches in available_at (they can take this order)' : '; no other branch can take this order, so don\'t offer one') });
      } else {
        cartErrors.push({ code: 'ITEM_NOT_FOUND', requested, suggestions: suggestAlternatives(requested, 3) });
      }
      continue;
    }
    const { id, entry } = resolved;
    if (effective !== 'remove' && entry.orderable === false) {
      cartErrors.push({ code: 'DINE_IN_ONLY', requested: entry.name, menu_id: id });
      continue;
    }
    if (effective !== 'remove' && soldOut(entry)) {
      cartErrors.push({ code: 'SOLD_OUT', requested: entry.name, menu_id: id,
        back_at: entry.sold_out_until ? localTime(entry.sold_out_until, tz) : null, suggestions: suggestAlternatives(entry.name, 3) });
      continue;
    }
    if (effective !== 'remove' && outsideWindow(entry)) {
      cartErrors.push({ code: 'NOT_SERVED_NOW', requested: entry.name, menu_id: id, served: `${entry.window.from}–${entry.window.to}`,
        suggestions: suggestAlternatives(entry.name, 3) });
      continue;
    }

    // carry forward anything already answered for this item
    const pidIn = str(p.pending_id);
    const priorPending = carriedPending.find(x =>
      (pidIn && str(obj(x).pid) === pidIn) || (!pidIn && str(obj(x).code) === id));

    // update / replace may name ONE changed choice: start from the line in the cart
    const lineIdIn = str(p.line_id);
    const existingLine = (effective === 'update' || effective === 'replace')
      ? (items.find(i => lineIdIn && str(i.line_id) === lineIdIn) || items.find(i => str(i.code) === id) || null)
      : null;
    if (existingLine && str(existingLine.code) === id) {
      if (p.quantity === undefined || p.quantity === null || p.quantity === '') p.quantity = existingLine.quantity;
      if (p.notes === undefined) p.notes = existingLine.notes;
      if (!lineIdIn) p.line_id = existingLine.line_id;
    }
    const basePlaced = existingLine && str(existingLine.code) === id
      ? placeChoices(menuChoices, id, rawFromAccepted(existingLine.choices))
      : (priorPending ? placeChoices(menuChoices, id, obj(priorPending).choices) : { byLevel: {}, unplaced: [] });
    const newPlaced = placeChoices(menuChoices, id, p.choices);
    // a dish with no choices at all ("كاليماري مقلي" when it is only made one way):
    // the word goes to the kitchen as a note, not back to the customer as a problem
    if (!arr(newPlaced.levels).length && newPlaced.unplaced.length) {
      p.notes = [str(p.notes), ...newPlaced.unplaced.map(str)].filter(Boolean).join(' · ');
      newPlaced.unplaced = [];
    }
    for (const u of newPlaced.unplaced) {
      cartErrors.push({ code: 'CHOICE_NOT_AN_OPTION', menu_id: id, item_name: entry.name, requested: u,
        levels: arr(newPlaced.levels).map(L => ({ level: L.level, label: L.label_ar, options: arr(L.options).map(o => o.name) })) });
    }
    const incomingChoices = choicesFromLevels({ ...basePlaced.byLevel, ...newPlaced.byLevel });

    const mustHaveChoices = (effective === 'add' || effective === 'update' || effective === 'replace');
    const cr = resolveChoices(menuChoices, id, entry.name, incomingChoices);
    for (const e of cr.errors) cartErrors.push(e);

    if (mustHaveChoices && cr.needs) {
      const qty = normQty(entry, p.quantity !== undefined ? p.quantity : obj(priorPending).quantity, 1);
      pendingChoices.push({
        pending_id: priorPending ? str(obj(priorPending).pid) : ('P' + (carriedPending.length + pendingChoices.length + 1) + '-' + id),
        answered_so_far: rawFromAccepted(cr.accepted.filter(a => !a.auto)),
        quantity: qty, unit: entry.unit, menu_id: id, item_name: entry.name,
        notes: str(p.notes) || str(obj(priorPending).notes) || null,
        base_price: entry.price,
        ask_now: cr.needs, levels_done: cr.done_levels,
        required_levels_remaining: cr.required_pending.map(x => x.level),
        auto_filled: cr.auto_filled,
        remaining_preview: cr.required_pending.map(L => ({ level: L.level, label: L.label_ar, options: arr(L.options).map(o => o.name) })),
        total_questions_left: cr.required_pending.length,
        optional_levels_remaining: cr.optional_pending
      });
      continue;   // NOT added — the customer has to answer first
    }

    if (priorPending) resolvedPids.push(str(obj(priorPending).pid));
    const built = buildLine(id, entry, { ...p, notes: p.notes !== undefined ? p.notes : obj(priorPending).notes },
                            cr, obj(priorPending).quantity);
    if (!built.price_known) cartErrors.push({ code: 'PRICE_UNKNOWN', requested: entry.name, menu_id: id });
    if (mustHaveChoices && cr.optional_pending.length) built.optional_levels_open = cr.optional_pending;

    const key = lineKey(built);
    const idx = items.findIndex(i => lineKey(i) === key);
    const askedLineId = str(p.line_id);
    const byLineId = askedLineId ? items.findIndex(i => str(i.line_id) === askedLineId) : -1;
    const forceNew = p.force_new === true || str(p.force_new) === 'true';
    let amendIdx = -1;
    if (!forceNew && idx < 0 && byLineId < 0) {
      amendIdx = items.findIndex(i => {
        if (str(i.code) !== str(built.code)) return false;
        const have = arr(i.choices).map(c => num(c.level));
        const want = arr(built.choices).map(c => num(c.level));
        return have.every(l => want.indexOf(l) !== -1) && want.length > have.length;
      });
    }

    if (effective === 'add') {
      if (byLineId >= 0) {
        items[byLineId] = { ...built, line_id: items[byLineId].line_id };
      } else if (idx >= 0) {
        const q = normQty(entry, num(items[idx].quantity) + num(built.quantity));
        items[idx] = { ...items[idx], quantity: q, line_total: money(items[idx].unit_price * q) };
      } else if (amendIdx >= 0) {
        const q = Math.max(num(items[amendIdx].quantity), num(built.quantity));
        items[amendIdx] = { ...built, line_id: items[amendIdx].line_id, quantity: q, line_total: money(built.unit_price * q) };
      } else {
        built.line_id = nextLineId();
        items.push(built);
      }
    } else if (effective === 'update' || effective === 'replace') {
      const target = byLineId >= 0 ? byLineId
                   : (idx >= 0 ? idx
                   : (amendIdx >= 0 ? amendIdx
                   : items.findIndex(i => str(i.code) === str(built.code))));
      if (target >= 0) items[target] = { ...built, line_id: items[target].line_id };
      else { built.line_id = nextLineId(); items.push(built); }
    } else if (effective === 'remove') {
      const ri = byLineId >= 0 ? byLineId
               : (idx >= 0 ? idx : items.findIndex(i => str(i.code) === str(built.code)));
      if (ri >= 0) {
        const takeAway = p.quantity === undefined || p.quantity === null || p.quantity === ''
          ? num(items[ri].quantity) : num(p.quantity, items[ri].quantity);
        const left = Math.round((num(items[ri].quantity) - takeAway) * 100) / 100;
        if (left <= 0 || (str(items[ri].unit) === 'kg' && left < num(entry.min_qty, 0.25))) items.splice(ri, 1);
        else items[ri] = { ...items[ri], quantity: left, line_total: money(items[ri].unit_price * left) };
      } else {
        const pi = carriedPending.findIndex(x => str(x.code) === id || (pidIn && str(x.pid) === pidIn));
        if (pi >= 0) resolvedPids.push(str(carriedPending[pi].pid));
        else cartErrors.push({ code: 'NOT_IN_CART', requested: entry.name });
      }
    }
  }
}

items = items.filter(i => i.item_name && num(i.quantity) > 0);

// ---- money ------------------------------------------------------------------------------
const dm = str(customer.delivery_method).toLowerCase();
const isPickup = dm === 'pickup';
const zoneHere = zone && str(zone.branch_id) === str(targetBranchId) ? zone : null;
const feeRaw = zoneHere && zoneHere.delivery_fee != null ? zoneHere.delivery_fee : branchInfo.delivery_fee;
const feeKnown = isPickup || (feeRaw !== null && feeRaw !== undefined && feeRaw !== '');
const deliveryFee = isPickup || !items.length ? 0 : (feeKnown ? money(feeRaw) : null);

const offerResult = applyOffers(items, all.offers, {
  now, branchId: targetBranchId || null, ordersCount: num(db.orders_count), promoCodes,
  deliveryFee: deliveryFee || 0, menuItems
});
// gifts the offers give: real lines at no charge, so the kitchen sees them
let giftSeq = 0;
for (const g of offerResult.gifts) {
  const e = menuItems[g.code];
  if (!e || soldOut(e)) continue;
  items.push({ line_id: 'G' + (++giftSeq), item_id: e.id || null, code: g.code, item_name: e.name, display_name: e.name,
               category: e.category || null, category_id: e.category_id || null, unit: e.unit || 'portion',
               quantity: g.quantity, base_price: 0, price_known: true, choices: [], choices_total: 0,
               unit_price: 0, line_total: 0, gift: true, offer_id: g.offer_id, offer_title: g.offer_title, notes: null });
}

const subtotal = offerResult.subtotal;
const itemDiscount = offerResult.item_discount;
const deliveryDiscount = offerResult.delivery_discount;
const vatRaw = branchInfo.vat_percent;
const vatPercent = vatRaw === null || vatRaw === undefined || vatRaw === '' ? null : num(vatRaw);
const vat = vatPercent === null ? null : money((subtotal - itemDiscount) * vatPercent / 100);
const deliveryNet = deliveryFee === null ? null : money(deliveryFee - deliveryDiscount);
const total = money(subtotal - itemDiscount + (vat || 0) + (deliveryNet || 0));
const discountTotal = money(itemDiscount + deliveryDiscount);
const extraChargeLines = items.filter(i => i.extra_charge).map(i => i.display_name);
const minOrder = zoneHere && zoneHere.min_order != null ? num(zoneHere.min_order) : num(branchInfo.min_order, 0);
if (!isPickup && items.some(i => !i.gift) && minOrder > 0 && subtotal < minOrder) {
  cartErrors.push({ code: 'BELOW_MINIMUM', subtotal, minimum: minOrder, shortfall: money(minOrder - subtotal) });
}

// ---- what is still missing for the order ----------------------------------------------------
const REQ = obj(settings.required_fields);
const mode = ['delivery', 'pickup'].includes(dm) ? dm : 'unknown';
const hasPin = location.lat != null && location.lng != null;
const phoneHidden = obj(state.contact).phone_hidden === true;
const zonesDrawn = arr(all.zones).length > 0;
const needZone = mode === 'delivery' && zonesDrawn && settings.require_zone_for_delivery !== false;
const missingDetails = arr(REQ[mode] || ['phone_confirmed', 'full_name', 'delivery_method'])
  .map(f => (phoneHidden && f === 'phone_confirmed') ? 'phone' : f)
  .filter(f => !(f === 'address_street' && hasPin))
  .filter(f => fieldNeeded(f, customer))
  .filter(f => !str(customer[f]));
if (needZone && !zoneHere) missingDetails.push('delivery_area');
// each branch takes its own payment methods (the restaurant's when it set none)
const payHere = arr(branchInfo.payment_methods).length ? arr(branchInfo.payment_methods).map(str) : arr(settings.payment_methods).map(str);
const payOnFile = str(customer.payment_method);
const payNotTaken = targetBranchId && payOnFile && payHere.length && !payHere.includes(payOnFile) ? payOnFile : null;
if (payNotTaken && !missingDetails.includes('payment_method')) missingDetails.push('payment_method');

// ---- pending workspace after this call -------------------------------------------------------
const pendingAfter = pendingChoices.map(pc => ({
  pid: pc.pending_id, code: pc.menu_id, name: pc.item_name, quantity: pc.quantity,
  choices: pc.answered_so_far, levels_done: pc.levels_done, levels_left: pc.required_levels_remaining,
  notes: pc.notes, at: nowIso
})).concat(carriedPending.filter(x => {
  const pid = str(obj(x).pid);
  return pid && resolvedPids.indexOf(pid) === -1 && !pendingChoices.some(pc => str(pc.pending_id) === pid);
})).slice(0, 8);

// =========================================================================
// place_order — the gate
// =========================================================================
let place = null;
if (action === 'place_order') {
  const reasons = [];
  const bState = str(branchStates[targetBranchId]) || 'unknown';
  if (!items.some(i => !i.gift)) reasons.push({ code: 'EMPTY_CART' });
  if (pendingAfter.length) reasons.push({ code: 'ITEMS_WAITING_ON_CHOICES', items: pendingAfter.map(p => p.name) });
  if (!targetBranchId) reasons.push({ code: 'NO_BRANCH' });
  else if (bState === 'not_accepting') reasons.push({ code: 'BRANCH_NOT_ACCEPTING', branch: branchInfo.name_ar });
  else if (bState === 'busy') reasons.push({ code: 'BRANCH_BUSY', branch: branchInfo.name_ar, until: branchInfo.busy_until ? localTime(branchInfo.busy_until, tz) : null });
  else if (bState === 'closed' && !settings.accept_orders_when_closed) {
    reasons.push({ code: 'BRANCH_CLOSED', branch: branchInfo.name_ar, opens: openStatus(branchInfo.hours, now).opens || null });
  }
  if (mode === 'delivery' && branchInfo.delivery_enabled === false) reasons.push({ code: 'DELIVERY_NOT_OFFERED_BY_BRANCH' });
  if (mode === 'pickup' && branchInfo.pickup_enabled === false) reasons.push({ code: 'PICKUP_NOT_OFFERED_BY_BRANCH' });
  if (payNotTaken) reasons.push({ code: 'PAYMENT_NOT_TAKEN_AT_BRANCH', method: payNotTaken, branch: branchInfo.name_ar, takes: payHere });
  if (needZone && !zoneHere) {
    reasons.push(zone && zone.branch_id
      ? { code: 'ADDRESS_SERVED_BY_OTHER_BRANCH', branch: zone.branch_name, branch_code: zone.branch_code }
      : { code: hasPin && location.in_delivery_area === false ? 'OUT_OF_DELIVERY_AREA' : 'DELIVERY_AREA_UNKNOWN' });
  }
  if (missingDetails.filter(f => f !== 'delivery_area').length) reasons.push({ code: 'MISSING_DETAILS', fields: missingDetails.filter(f => f !== 'delivery_area') });
  if (cartErrors.some(e => e.code === 'BELOW_MINIMUM')) reasons.push({ code: 'BELOW_MINIMUM', minimum: minOrder, short_by: money(minOrder - subtotal) });
  if (menuChanged) reasons.push({ code: 'MENU_CHANGED', changes: menuChanges });
  // an offer that started or ended since the summary changes what they pay
  const giftsNow = items.filter(i => i.gift).map(i => i.code).sort().join(',');
  const giftsBefore = arr(obj(activeOrder.cart).items).filter(i => i.gift).map(i => i.code).sort().join(',');
  if (!menuChanged && activeOrder.total != null && (money(activeOrder.total) !== total || giftsNow !== giftsBefore)) {
    reasons.push({ code: 'TOTALS_CHANGED', was: money(activeOrder.total), now: total });
  }
  const shownHash = str(ledger.review_hash);
  if (!shownHash) reasons.push({ code: 'SUMMARY_NOT_SHOWN' });
  else if (shownHash !== str(db.current_review_hash)) reasons.push({ code: 'SUMMARY_OUTDATED' });

  if (reasons.length) {
    place = { ok: false, reasons };
  } else {
    const c = customer;
    const address = isPickup ? null : {
      governorate: str(c.address_governorate) || null, city: str(c.address_city) || null, area: str(c.address_area) || null,
      street: str(c.address_street) || null, building: str(c.address_building) || null, floor: str(c.address_floor) || null,
      apartment: str(c.address_apartment) || null, landmark: str(c.address_landmark) || null, notes: str(c.address_notes) || null
    };
    const addrParts = isPickup ? [] : [
      str(c.address_street) && ('الشارع: ' + str(c.address_street).replace(/^شارع\s+/, '')),
      str(c.address_area) && ('المنطقة: ' + str(c.address_area)),
      str(c.address_city) && ('المدينة: ' + str(c.address_city)),
      str(c.address_governorate) && ('المحافظة: ' + str(c.address_governorate).replace(/^محافظة\s+/, '')),
      str(c.address_building) && ('عمارة ' + str(c.address_building)),
      str(c.address_floor) && ('الدور ' + str(c.address_floor)),
      str(c.address_apartment) && ('شقة ' + str(c.address_apartment)),
      str(c.address_landmark) && ('علامة مميزة: ' + str(c.address_landmark)),
      str(c.address_notes) && ('ملاحظات: ' + str(c.address_notes))
    ].filter(Boolean);
    const etaText = isPickup ? (branchInfo.prep_minutes ? `${branchInfo.prep_minutes} دقيقة` : null)
      : (zoneHere && (zoneHere.eta_min || zoneHere.eta_max) ? `${zoneHere.eta_min || zoneHere.eta_max}–${zoneHere.eta_max || zoneHere.eta_min} دقيقة` : (branchInfo.delivery_eta_text || null));
    place = {
      ok: true,
      payload: {
        tenant_id: args.tenant_id, wa_id: args.wa_id, branch_id: targetBranchId, zone_id: zoneHere ? zoneHere.id : null,
        customer: { ...c, phone: str(c.phone) || (phoneHidden ? '' : str(args.wa_id)) },
        address, address_text: isPickup ? ('استلام من فرع ' + str(branchInfo.name_ar)) : addrParts.join('، '),
        location: hasPin && !isPickup ? { lat: location.lat, lng: location.lng, maps_url: location.maps_url || null } : null,
        notes: str(c.order_notes) || null,
        eta_text: etaText,
        totals: { subtotal, discount_total: discountTotal, applied_offers: offerResult.applied, vat,
                  delivery_fee: deliveryNet, total }
      }
    };
  }
}

// ---- ledger / state patches (merged one level deep by the persist query) ----------------------
const ledgerPatch = {
  pending_items: pendingAfter,
  line_seq: lineSeq,
  promo_codes: promoCodes,
  cart_log: prevCartLog.concat([{ at: nowIso, action, branch: targetBranchId || null, lines: items.length, subtotal }]).slice(-15)
};
const statePatch = {};
if (branchSetBy) {
  statePatch.branch = { id: targetBranchId, code: branchInfo.code, name_ar: branchInfo.name_ar, source: branchSetBy, set_at: nowIso };
  ledgerPatch.branch_history = arr(ledger.branch_history)
    .concat([{ at: nowIso, from: currentBranchId || null, to: targetBranchId }]).slice(-6);
}

const totals = { subtotal, discount_total: discountTotal, applied_offers: offerResult.applied, vat, delivery_fee: deliveryNet,
                 total, currency: str(tenant.currency) || 'EGP' };
const placeNow = action === 'place_order' && !!place && place.ok === true;

return [{
  json: {
    ok: true,
    action,
    tenant_id: args.tenant_id,
    wa_id: args.wa_id,
    branch_id: targetBranchId,
    branch_name: str(branchInfo.name_ar) || null,
    branch_changed: branchSetBy ? { from: currentBranchId || null, to: targetBranchId, by: branchSetBy,
      matched_by: num(db.requested_match_rank, 0) === 5 ? 'area_it_serves' : 'branch_name' } : null,
    menu_changes: menuChanges,
    menu_changed: menuChanged,
    code_result: codeResult,
    cart: { items },
    subtotal, discount_total: discountTotal, item_discount: itemDiscount, delivery_discount: deliveryDiscount,
    offers_applied: offerResult.applied, offers_almost: offerResult.almost,
    vat_percent: vatPercent, vat, price_note: str(branchInfo.price_note_ar) || null,
    extra_charge_items: extraChargeLines,
    delivery_fee: deliveryNet, delivery_fee_before_offers: deliveryFee, delivery_fee_known: deliveryNet !== null,
    delivery_zone: zoneHere ? { name: zoneHere.name, fee: zoneHere.delivery_fee, min_order: zoneHere.min_order } : null,
    total,
    currency_symbol: str(tenant.currency_symbol) || 'ج',
    cart_lines: items.map(i => ({
      line_id: i.line_id, menu_id: i.code, name: i.display_name, quantity: i.quantity,
      unit: UNIT_AR[i.unit] || '',
      // how to say the quantity: "نص كيلو", "كيلو ونص", or a count
      say: i.unit === 'kg' ? kiloText(i.quantity) : (num(i.quantity) === 1 ? '' : `${fmt(i.quantity)}`),
      choices: arr(i.choices).map(c => arr(c.selected).map(s => s.name).join(' + ')).filter(Boolean),
      notes: i.notes || null, line_total: i.line_total, price_known: i.price_known !== false,
      free_gift: i.gift === true || undefined,
      special_prep_charge_to_add: i.extra_charge === true || undefined
    })),
    cart_errors: cartErrors,
    pending_choices: pendingChoices,
    pending_after: pendingAfter,
    missing_details: missingDetails,
    payment_methods_here: targetBranchId ? payHere : null,
    payment_not_taken: payNotTaken,
    place,
    is_place: placeNow,
    b64_place: placeNow ? b64(place.payload) : '',
    b64_cart: b64({ tenant_id: args.tenant_id, wa_id: args.wa_id, branch_id: targetBranchId || null,
                    zone_id: zoneHere ? zoneHere.id : null, cart: { items }, totals,
                    ledger_patch: ledgerPatch, state_patch: statePatch }),
    ready_to_place: items.some(i => !i.gift) && !pendingAfter.length && !missingDetails.length && !!targetBranchId
  }
}];
