// =====================================================================
// EVERWAKE — Tool: save_customer_details · NODE: Return To Agent
// The facts after the save — including which delivery zone the address
// falls in, which only the database can tell.
// =====================================================================
// @include shared/basics.js

const v = $('Validate + Patch').first().json;
const db = row($input.first().json);
const res = { ...obj(v.result) };
const st = obj(db.state);
const zone = st.zone && typeof st.zone === 'object' ? st.zone : null;
const area = obj(db.area_match);

if (zone && zone.branch_id) {
  res.delivery_area = {
    status: 'INSIDE_A_ZONE', zone: zone.name, branch: zone.branch_name, branch_code: zone.branch_code,
    delivery_fee: zone.delivery_fee, min_order: zone.min_order, from: zone.source,
    branch_is_the_chosen_one: !str(obj(st.branch).id) || str(obj(st.branch).id) === str(zone.branch_id)
  };
} else if (arr(area.matches).length > 1) {
  res.delivery_area = { status: 'AREA_MATCHES_SEVERAL_ZONES', options: arr(area.matches).map(m => ({ zone: m.zone_name, branch: m.branch_name })),
                        fact: 'ask which one, or ask for a location pin' };
} else if (area.text && !arr(area.matches).length && res.zones_drawn) {
  res.delivery_area = { status: 'AREA_NOT_RECOGNISED', fact: 'the typed area is not in any delivery zone by name — ask for a location pin to check' };
}
const mode = res.delivery_mode;
const missing = arr(res.still_missing_for_order).slice();
if (mode === 'delivery' && res.zones_drawn && res.require_zone && !(zone && zone.branch_id)) missing.push('delivery_area');
res.still_missing_for_order = missing;
delete res.zones_drawn; delete res.require_zone; delete res.had_zone;

return [{ json: { response: JSON.stringify(res) } }];
