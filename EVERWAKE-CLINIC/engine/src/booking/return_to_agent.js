// =====================================================================
// EVERWAKE CLINIC — Tool: manage_booking · NODE: Return To Agent
// The database's answer, as the agent reads it. Options keep their
// number and their label (the true day and time) and lose the ids.
// =====================================================================
// @include shared/basics.js

const r = row($input.first().json);
const trimSlot = (o) => { const x = obj(o); return { option: x.option, label: x.label_ar, label_en: x.label_en, doctor: x.doctor, location: x.location,
                                                    kind: x.kind, queue_no: x.queue_no, date: x.date, time: x.time, band: x.band }; };
const out = { ...r };
if (Array.isArray(r.options)) out.options = r.options.map(trimSlot);
for (const p of arr(out.problems)) if (Array.isArray(p.suggested)) p.suggested = p.suggested.slice(0, 3).map(trimSlot);
if (Array.isArray(r.suggested)) out.suggested = r.suggested.slice(0, 3).map(trimSlot);
return [{ json: { response: JSON.stringify(out) } }];
