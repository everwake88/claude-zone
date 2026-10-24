// =====================================================================
// EVERWAKE — Tool: save_customer_details · NODE: Validate + Patch
//
// Whitelists fields, normalises enums, rejects junk. The agent cannot
// invent a field name or write an invalid delivery / payment method.
//
// From Seagull: phone_confirmed + phone derivation, clearable fields, the
// ledger (asked / details_log) that stops a detail being asked twice,
// reset_address for a different address.
// New:
//   · use_saved_address: <id> | "last"  — an address from a previous order
//   · a typed area is matched to a delivery zone (in the persist query)
//   · a phone typed for the order is remembered as this customer's, so a
//     customer hidden behind a WhatsApp private id is found by it later
//   · payment methods are the ones the customer's branch takes
// The branch is NOT a field here — manage_cart set_branch re-prices.
// =====================================================================
// @include shared/basics.js

const t = $('Tool Called By Agent').first().json || {};
const db = row($input.first().json);

let args = t;
// the agent's one JSON object (details), or the older details_json string
if (t.details !== undefined && t.details !== null && t.details !== '') args = { details_json: t.details };
else if (t.details_json === undefined && t.input !== undefined) {
  try { args = typeof t.input === 'string' ? JSON.parse(t.input) : (t.input || {}); } catch (e) { args = {}; }
  if (typeof args === 'string') { try { args = JSON.parse(args); } catch (e) { args = {}; } }
}
const tenantId = str(t.tenant_id || args.tenant_id);
const waId = str(t.wa_id || args.wa_id);
const rawDetails = args.details_json !== undefined ? args.details_json : args;

const ADDRESS_FIELDS = ['address_governorate', 'address_city', 'address_area', 'address_street',
  'address_building', 'address_floor', 'address_apartment', 'address_landmark', 'address_notes'];
const ALLOWED_FIELDS = ['full_name', 'phone', 'phone_confirmed', 'alt_phone', 'delivery_method', 'payment_method',
  ...ADDRESS_FIELDS, 'address_confirmed', 'order_notes', 'food_prefs'];
const TYPED_ADDRESS = ['address_governorate', 'address_city', 'address_area', 'address_street'];
const CLEARABLE = ['food_prefs', 'address_landmark', 'address_notes', 'order_notes', 'alt_phone'];

let incoming;
try {
  incoming = obj(typeof rawDetails === 'string' ? JSON.parse(rawDetails || '{}') : rawDetails);
} catch (e) {
  return [{ json: { ok: false, response: JSON.stringify({
    ok: false, error_code: 'BAD_DETAILS_JSON',
    expected: '{"full_name":"أحمد","address_area":"المعادي"}' }) } }];
}

const state = obj(db.state);
const settings = obj(db.settings);
const saved = arr(db.saved_addresses);
const existing = obj(state.customer);
const phoneHidden = obj(state.contact).phone_hidden === true;
const ledger = obj(state.ledger);
const prevLog = arr(ledger.details_log);
const prevAsked = obj(ledger.asked);
const nowIso = new Date().toISOString();
// each branch takes its own payment methods; before a branch is chosen, what any branch takes
const payByBranch = obj(db.payment_methods_by_branch);
const branchNow = str(obj(state.branch).id);
const PAY_OK = (branchNow && Array.isArray(payByBranch[branchNow]) ? payByBranch[branchNow]
  : (Object.keys(payByBranch).length ? [...new Set(Object.values(payByBranch).flatMap(arr))] : arr(settings.payment_methods)))
  .map(s => str(s).toLowerCase());

const accepted = {};
const cleared = [];
const rejected = [];
let base = { ...existing };
let location = obj(state.location);
let resetAddress = false;
let savedUsed = null;

// ---- a different address: wipe the old one first --------------------------------
const resetFlag = incoming.reset_address;
if (resetFlag === true || /^(true|yes|1)$/i.test(str(resetFlag))) {
  resetAddress = true;
  for (const f of ADDRESS_FIELDS) if (str(base[f])) { delete base[f]; cleared.push(f); }
  delete base.address_source; delete base.address_confirmed;
  location = {};
}
delete incoming.reset_address;

// ---- an address from a previous order ----------------------------------------------
const useSaved = incoming.use_saved_address;
delete incoming.use_saved_address;
if (useSaved !== undefined && useSaved !== null && str(useSaved) !== '') {
  const a = /^last$/i.test(str(useSaved)) ? saved[0] : saved.find(x => str(x.id) === str(useSaved).replace(/\D/g, ''));
  if (!a) {
    rejected.push({ field: 'use_saved_address', reason: 'NO_SUCH_SAVED_ADDRESS', saved: saved.map(x => x.id) });
  } else {
    for (const f of ADDRESS_FIELDS) delete base[f];
    const map = { address_governorate: a.governorate, address_city: a.city, address_area: a.area, address_street: a.street,
                  address_building: a.building, address_floor: a.floor, address_apartment: a.apartment,
                  address_landmark: a.landmark, address_notes: a.notes };
    for (const [k, v] of Object.entries(map)) if (str(v)) accepted[k] = str(v);
    accepted.address_confirmed = 'yes';
    base.address_source = 'saved';
    savedUsed = { id: a.id, zone_id: a.zone_id || null, lat: a.lat, lng: a.lng, maps_url: a.maps_url || null };
    if (a.lat != null && a.lng != null) {
      location = { lat: a.lat, lng: a.lng, maps_url: a.maps_url || `https://www.google.com/maps?q=${a.lat},${a.lng}`,
                   at: nowIso, source: 'saved_address' };
    } else if (!resetAddress) {
      location = {};
    }
  }
}

for (const [k, v] of Object.entries(incoming)) {
  if (k === 'pickup_branch' || k === 'branch' || k === 'branch_id') {
    rejected.push({ field: k, reason: 'USE_manage_cart_set_branch' });
    continue;
  }
  if (!ALLOWED_FIELDS.includes(k)) { rejected.push({ field: k, reason: 'UNKNOWN_FIELD' }); continue; }

  const val = str(v);
  if ((val === '' || val.toLowerCase() === 'null') && CLEARABLE.includes(k)) {
    accepted[k] = ''; cleared.push(k); continue;
  }
  if (!val || val.toLowerCase() === 'null') continue;

  if (k === 'delivery_method') {
    const dm = /pick|استلام|تيك|take/i.test(val) ? 'pickup' : (/deliv|توصيل|دليفري|ديليفري/i.test(val) ? 'delivery' : val.toLowerCase());
    if (!['delivery', 'pickup'].includes(dm)) { rejected.push({ field: k, reason: 'MUST_BE delivery|pickup' }); continue; }
    accepted[k] = dm; continue;
  }
  if (k === 'payment_method') {
    let pm = val.toLowerCase();
    if (/كاش|cash|نقد/.test(pm)) pm = 'cash';
    else if (/أونلاين|اونلاين|أون لاين|اون لاين|online|لينك|link|paymob|باي ?موب/.test(pm)) pm = 'online';
    else if (/فيزا|كارت|card|visa|ماستر|master|ميزة|meeza/.test(pm)) pm = 'card';
    else if (/محفظ|wallet|فودافون|vodafone|اتصالات|etisalat|اورنج|orange/.test(pm)) pm = 'wallet';
    else if (/انستا|إنستا|instapay/.test(pm)) pm = 'instapay';
    // card or wallet at a restaurant that takes them only online (a payment link), not at the door
    if ((pm === 'card' || pm === 'wallet') && PAY_OK.includes('online') && !PAY_OK.includes(pm)) pm = 'online';
    if (!['cash', 'card', 'wallet', 'instapay', 'online'].includes(pm)) { rejected.push({ field: k, reason: 'MUST_BE cash|card|wallet|instapay|online' }); continue; }
    if (PAY_OK.length && !PAY_OK.includes(pm)) {
      rejected.push({ field: k, reason: branchNow ? 'NOT_TAKEN_AT_THIS_BRANCH' : 'NOT_ACCEPTED_BY_THE_RESTAURANT', accepted: PAY_OK }); continue;
    }
    accepted[k] = pm; continue;
  }
  if (k === 'phone_confirmed' || k === 'address_confirmed') {
    accepted[k] = /^(yes|y|true|1|نعم|ايوه|أيوه|ايوة|اه|آه|تمام|أكيد|اكيد)$/i.test(val) ? 'yes' : 'no';
    continue;
  }
  if (k === 'phone' || k === 'alt_phone') {
    const digits = val.replace(/[٠-٩]/g, d => String('٠١٢٣٤٥٦٧٨٩'.indexOf(d))).replace(/\D/g, '');
    if (digits.length < 8) { rejected.push({ field: k, reason: 'TOO_SHORT' }); continue; }
    accepted[k] = digits; continue;
  }
  accepted[k] = val.slice(0, 200);
}

const merged = { ...base, ...accepted };
for (const k of cleared) if (merged[k] === '') delete merged[k];
// a typed address is the customer's own words (confirmed by definition);
// a pin-derived one waits for their confirmation
const typedNow = TYPED_ADDRESS.some(f => accepted[f] !== undefined && accepted[f] !== '') && !savedUsed;
if (typedNow) {
  merged.address_source = 'typed';
  if (accepted.address_confirmed === undefined) merged.address_confirmed = 'yes';
}

if (str(merged.phone_confirmed) === 'yes' && !str(merged.phone) && !phoneHidden) {
  const wa = waId.replace(/\D/g, '');
  if (wa.length >= 8) { merged.phone = wa; accepted.phone = wa; }
}

// ---- what is still missing (the zone part is settled after the persist) -----------------
const REQ = obj(settings.required_fields);
const dm = str(merged.delivery_method).toLowerCase();
const mode = ['delivery', 'pickup'].includes(dm) ? dm : 'unknown';
const hasPin = location.lat != null && location.lng != null;
const missing = arr(REQ[mode] || ['phone_confirmed', 'full_name', 'delivery_method'])
  .map(f => (phoneHidden && f === 'phone_confirmed') ? 'phone' : f)
  .filter(f => !(f === 'address_street' && hasPin))
  .filter(f => fieldNeeded(f, merged))
  .filter(f => !str(merged[f]));

const askedNow = { ...prevAsked };
for (const k of Object.keys(merged)) if (str(merged[k])) askedNow[k] = askedNow[k] || nowIso;
if (str(merged.phone_confirmed)) askedNow.confirm_phone = askedNow.confirm_phone || nowIso;
if (resetAddress) for (const f of ADDRESS_FIELDS) delete askedNow[f];

const statePatch = { customer: merged };
if (resetAddress || savedUsed) statePatch.location = Object.keys(location).length ? location : null;
if (resetAddress && !savedUsed) statePatch.zone = null;

const ledgerPatch = {
  asked: askedNow,
  details_log: prevLog.concat([{ at: nowIso, saved: Object.keys(accepted), cleared, still_missing: missing, mode,
    reset_address: resetAddress || undefined, saved_address: savedUsed ? savedUsed.id : undefined }]).slice(-20)
};

// the typed area decides the zone (unless a pin already did)
const areaText = typedNow ? [merged.address_area, merged.address_city, merged.address_street].filter(Boolean).join(' ') : '';
const phoneForLink = phoneHidden && accepted.phone ? accepted.phone : '';

return [{
  json: {
    ok: true,
    tenant_id: tenantId,
    wa_id: waId,
    b64_persist: b64({ tenant_id: tenantId, wa_id: waId, state_patch: statePatch, ledger_patch: ledgerPatch,
                       area_text: areaText, address_reset: resetAddress, link_phone: phoneForLink,
                       zone_id: savedUsed && savedUsed.zone_id ? savedUsed.zone_id : null }),
    result: {
      status: 'SAVED',
      saved_fields: Object.keys(accepted),
      cleared_fields: cleared,
      rejected,
      details_on_file: merged,
      still_missing_for_order: missing,
      branch_chosen: !!str(obj(state.branch).id),
      delivery_mode: mode,
      gps_pin_on_file: hasPin,
      address_from: str(merged.address_source) || null,
      address_confirmed_by_customer: str(merged.address_confirmed) === 'yes',
      saved_address_used: savedUsed ? savedUsed.id : null,
      zones_drawn: db.zones_drawn === true,
      require_zone: settings.require_zone_for_delivery !== false,
      had_zone: !!(state.zone && state.zone.id) && !resetAddress
    }
  }
}];
