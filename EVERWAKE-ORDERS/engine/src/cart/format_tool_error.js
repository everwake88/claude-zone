// =====================================================================
// EVERWAKE — Tool: manage_cart · NODE: Format Tool Error
// Nothing was written. Facts only.
// =====================================================================
const r = $input.first().json || {};
const NOTE = {
  BAD_ACTION: 'action must be one of the allowed values.',
  BAD_ITEMS_JSON: 'items_json was not a valid JSON array.',
  BRANCH_NEEDED: 'No branch is chosen yet, so nothing can be priced or added. The branch comes from where the customer is (delivery) or where they will collect (pickup). Call set_branch first.',
  BRANCH_NOT_FOUND: 'That name did not match any branch.',
  BRANCH_NOT_ACCEPTING: 'That branch is not taking orders right now.',
  NO_PREVIOUS_ORDER: 'This customer has no previous order to repeat.'
};
return [{
  json: {
    response: JSON.stringify({
      status: r.error_code || 'REJECTED',
      written: false,
      ...(r.facts || {}),
      fact: NOTE[r.error_code] || 'Nothing was changed.'
    })
  }
}];
