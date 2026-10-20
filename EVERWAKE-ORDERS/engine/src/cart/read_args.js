// =====================================================================
// EVERWAKE — Tool: manage_cart · NODE: Read Args
// Normalises whatever shape n8n hands over (mapped fields, or the legacy
// single `input` blob) into clean arguments.
// =====================================================================
const t = $input.first().json || {};
let a = t;
if (t.action === undefined && t.input !== undefined) {
  try { a = typeof t.input === 'string' ? JSON.parse(t.input) : (t.input || {}); } catch (e) { a = {}; }
  if (typeof a === 'string') { try { a = JSON.parse(a); } catch (e) { a = {}; } }
}
const s = (v) => String(v == null ? '' : v).trim();
const action = s(a.action !== undefined ? a.action : t.action).toLowerCase();
let branch = s(a.branch_id !== undefined ? a.branch_id : t.branch_id);
// "same as last time" with no branch chosen yet → the branch of that order
if (action === 'reorder_last' && !branch) branch = '__last_order__';

return [{
  json: {
    tenant_id: s(t.tenant_id || a.tenant_id),
    wa_id: s(t.wa_id || a.wa_id),
    action,
    items_json: a.items_json !== undefined ? a.items_json : (t.items_json !== undefined ? t.items_json : '[]'),
    branch_id: action === 'set_branch' || action === 'reorder_last' ? branch : ''
  }
}];
