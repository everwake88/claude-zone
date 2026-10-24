// =====================================================================
// EVERWAKE — Tool: manage_reservation · NODE: Read Args
// Normalises what n8n hands over: details_json may arrive as a string or
// as an object; it reaches the database as base64 so no quote or comma
// in a name or a special request can break the query.
// =====================================================================
const t = $input.first().json || {};
let a = t;
let req = t.request;
if (typeof req === 'string') { try { req = JSON.parse(req); } catch (e) { req = null; } }
if (req && typeof req === 'object' && !Array.isArray(req)) {
  a = { action: req.action, details_json: req.details !== undefined ? req.details : (req.details_json ?? '') };
} else if (t.action === undefined && t.input !== undefined) {
  try { a = typeof t.input === 'string' ? JSON.parse(t.input) : (t.input || {}); } catch (e) { a = {}; }
  if (typeof a === 'string') { try { a = JSON.parse(a); } catch (e) { a = {}; } }
}
const s = (v) => String(v == null ? '' : v).trim();
let details = a.details_json !== undefined ? a.details_json : t.details_json;
if (details && typeof details === 'object') details = JSON.stringify(details);
details = s(details);

return [{
  json: {
    tenant_id: s(t.tenant_id || a.tenant_id),
    wa_id: s(t.wa_id || a.wa_id),
    action: s(a.action !== undefined ? a.action : t.action).toLowerCase(),
    details_b64: Buffer.from(details, 'utf8').toString('base64')
  }
}];
