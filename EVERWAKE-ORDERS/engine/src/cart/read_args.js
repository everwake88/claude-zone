// =====================================================================
// EVERWAKE — Tool: manage_cart · NODE: Read Args
// Normalises whatever shape n8n hands over into clean arguments: the
// agent's fields (action, branch, items — items a list; [{}] is n8n's
// stand-in when the agent left it out), one request object, the older
// items_json text, or the legacy single `input` blob.
// =====================================================================
const t = $input.first().json || {};
let a = t;
let req = t.request;
if (typeof req === 'string') { try { req = JSON.parse(req); } catch (e) { req = null; } }
if (t.items !== undefined || t.branch !== undefined) {
  a = { action: t.action, branch_id: t.branch, items_json: t.items };
} else if (req && typeof req === 'object' && !Array.isArray(req)) {
  a = { action: req.action, branch_id: req.branch ?? req.branch_id,
        items_json: req.items !== undefined ? req.items : (req.items_json !== undefined ? req.items_json : []) };
} else if (t.action === undefined && t.input !== undefined) {
  try { a = typeof t.input === 'string' ? JSON.parse(t.input) : (t.input || {}); } catch (e) { a = {}; }
  if (typeof a === 'string') { try { a = JSON.parse(a); } catch (e) { a = {}; } }
}
const s = (v) => String(v == null ? '' : v).trim();
const action = s(a.action !== undefined ? a.action : t.action).toLowerCase();
let branch = s(a.branch_id !== undefined ? a.branch_id : t.branch_id);
if (branch.toLowerCase() === 'none') branch = '';   // n8n's stand-in when the agent left it out
// "same as last time" with no branch chosen yet → the branch of that order
if (action === 'reorder_last' && !branch) branch = '__last_order__';

return [{
  json: {
    tenant_id: s(t.tenant_id || a.tenant_id),
    wa_id: s(t.wa_id || a.wa_id),
    action,
    items_json: (v => {
      if (typeof v === 'string') { try { v = JSON.parse(v); } catch (e) { return v; } }
      const list = Array.isArray(v) ? v : (v && typeof v === 'object' ? [v] : []);
      return JSON.stringify(list.filter(x => x && typeof x === 'object' && Object.keys(x).length));
    })(a.items_json !== undefined ? a.items_json : (t.items_json !== undefined ? t.items_json : '[]')),
    branch_id: action === 'set_branch' || action === 'reorder_last' ? branch : ''
  }
}];
