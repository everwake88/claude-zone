// =====================================================================
// EVERWAKE CLINIC — Tool: staff_action · NODE: Read Args
// =====================================================================
// @include shared/basics.js

const t = $input.first().json;
let details = t.details;
if (typeof details === 'string') details = parseJson(details, {});
details = obj(details); delete details.none;
let staff = t.staff;
if (typeof staff === 'string') staff = parseJson(staff, {});
return [{ json: { tenant_id: str(t.tenant_id), wa_id: str(t.wa_id), action: str(t.action).toLowerCase().trim() || 'today',
                  staff_json: JSON.stringify(obj(staff)), details_json: JSON.stringify(details) } }];
