// =====================================================================
// EVERWAKE CLINIC — Tool: manage_booking · NODE: Read Args
// What the agent sent → the SQL call. details arrives as an object (n8n
// "json" type) or as text; it goes to the database base64-encoded, so
// quotes in Arabic text can never break the query.
// =====================================================================
// @include shared/basics.js

const t = $input.first().json;
let details = t.details;
if (typeof details === 'string') details = parseJson(details, {});
details = obj(details);
delete details.none;
return [{ json: { tenant_id: str(t.tenant_id), wa_id: str(t.wa_id), action: str(t.action).toLowerCase().trim() || 'status',
                  details_b64: Buffer.from(JSON.stringify(details), 'utf8').toString('base64') } }];
