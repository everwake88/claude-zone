// =====================================================================
// EVERWAKE — Tool: manage_reservation · NODE: Return To Agent
// The database's answer, as it is: the booking so far, what is still
// missing, any problem with a value, the summary to show, or the
// reference once it went to the branch team.
// =====================================================================
const r = $input.first().json.r;
const res = typeof r === 'string' ? r : JSON.stringify(r || { ok: false, error: 'NO_ANSWER', fact: 'the booking could not be saved — try once more' });
return [{ json: { response: res } }];
