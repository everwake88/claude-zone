// =====================================================================
// EVERWAKE CLINIC — Test Runner · NODE: Format Test Result
// The reply exactly as the patient would get it, then what the assistant did.
// =====================================================================
const cmd = $('Read Test Command').first().json;
const prep = $('Prepare Test Chat').first().json.r || {};
const res = ($input.first().json.r) || {};
const short = (v, n = 600) => { const s = typeof v === 'string' ? v : JSON.stringify(v); return !s ? '' : s.length > n ? s.slice(0, n - 1) + '…' : s; };
if (cmd.empty) return [{ json: { output: 'Type a patient message, or /reset, /last, /later 5 <message>.' } }];
if (prep.reset) return [{ json: { output: `RESET — ${prep.clinic}: the test chat ${prep.wa_id} starts from zero (a brand-new patient).` } }];
const replies = Array.isArray(res.replies) ? res.replies : [];
const said = replies.map(m => m.kind === 'text' ? m.text : `[${m.kind}] ${m.text || ''}`).join('\n[[NEXT]]\n');
const t = res.turn || {};
const b = t.plan && typeof t.plan === 'object' ? t.plan : null;
const lines = [
  `${cmd.last ? '(the latest turn again) ' : ''}${prep.later_hours ? `(${prep.later_hours} hours later) ` : ''}PATIENT: ${res.patient ?? cmd.text}`,
  `ASSISTANT: ${said || '(no reply — see the Main execution)'}`,
  '',
  `${prep.clinic} · ${prep.status}${res.mode === 'human' ? ' · A PERSON TOOK OVER' : ''}${res.urgency ? ' · FLAGGED ' + res.urgency.toUpperCase() : ''} · stage=${t.stage ?? '-'} · ${t.seconds ?? '-'}s · ${t.tokens ?? '-'} tokens`,
  ...((t.calls || []).map(c => `→ ${c.tool} ${short(c.asked, 220)} ⇒ ${c.status || '?'}${c.error ? ' «' + c.error + '»' : ''}${(c.problems || []).length ? ' ' + c.problems.join(',') : ''}`)),
  (t.caught || []).length ? `caught=${short(t.caught, 800)}${t.rewritten ? ' → repaired' : ''}` : 'caught=none',
  b && b.used ? `plan: ${b.stage} — ${b.objective}\n  move: ${b.move}\n  urgency: ${JSON.stringify(b.urgency || {})}` : `plan=${b ? '(none: ' + b.error + ')' : '-'}`,
  res.draft ? `booking in progress=${short(res.draft, 400)}` : '',
  res.appointments ? `appointments=${short(res.appointments, 500)}` : '',
  t.booked ? `BOOKED ${t.booked}` : '',
  t.handoff && t.handoff.needed ? `HANDOFF: ${t.handoff.reason}` : '',
  t.ask_team && t.ask_team.length ? `ASKED THE DOCTOR: ${[].concat(t.ask_team).join(' | ')}` : ''
].filter(l => l !== '');
return [{ json: { output: lines.join('\n'), reply: said || null } }];
