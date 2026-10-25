// =====================================================================
// EVERWAKE — Test Runner · NODE: Format Test Result
// What the chat (and whoever is testing) reads back: the reply exactly as
// the customer would get it, then what the agent did and why.
// =====================================================================
const cmd = $('Read Test Command').first().json;
const prep = $('Prepare Test Chat').first().json.r || {};
const res = ($input.first().json.r) || {};
const short = (v, n = 600) => { const s = typeof v === 'string' ? v : JSON.stringify(v); return !s ? '' : s.length > n ? s.slice(0, n - 1) + '…' : s; };

if (cmd.empty) return [{ json: { output: 'Type a customer message, or /reset, /last, /later 5 <message>, /pin <lat>,<lng>.' } }];
if (prep.reset) return [{ json: { output: `RESET — ${prep.restaurant}: the test chat ${prep.wa_id} starts from zero (a brand-new customer).` } }];

let route = null;
try { route = $('Run The Agent (Main)').first().json?.r?.route || null; } catch (e) { /* not run */ }
const replies = Array.isArray(res.replies) ? res.replies : [];
const said = replies.map(m => m.kind === 'text' ? m.text : `[${m.kind}] ${m.text || ''}`).join('\n[[NEXT]]\n');
const t = res.turn || {};
const b = t.plan && typeof t.plan === 'object' ? t.plan : null;
const plan = !b ? null : b.used ? `${b.stage} — ${b.objective}${b.place_order ? ' · PLACE' : ''}${b.show_summary ? ' · SUMMARY' : ''}` : `(no plan: ${b.error})`;

const lines = [
  `${cmd.last ? '(the latest turn again) ' : ''}${prep.later_hours ? `(${prep.later_hours} hours later) ` : ''}CUSTOMER: ${res.customer ?? cmd.text}`,
  `AGENT: ${said || `(no reply — ${route && route !== 'agent' ? 'route ' + route : 'see the Main execution'})`}`,
  '',
  `${prep.restaurant} · ${prep.status}${res.mode === 'human' ? ' · A PERSON TOOK OVER' : ''} · stage=${t.stage ?? '-'} · ${t.seconds ?? '-'}s · ${t.tokens ?? '-'} tokens`,
  ...((t.calls || []).length
    ? t.calls.map(c => `→ ${c.tool} ${short(c.asked, 220)} ⇒ ${c.status || '?'}${c.error ? ' «' + c.error + '»' : ''}${c.payment ? ' · payment ' + c.payment : ''}${(c.problems || []).length ? ' ' + c.problems.join(',') : ''}`)
    : [`tools=${short(t.tools || [])}`]),
  (t.tool_problems || []).length ? `problems=${short(t.tool_problems, 400)}` : '',
  t.agent_error ? `AGENT ERROR: ${t.agent_error}` : '',
  (t.caught || []).length ? `caught=${short(t.caught, 800)}${t.rewritten ? ' → rewritten' : ''}` : 'caught=none',
  `plan=${plan ?? '(none)'}`,
  ...(b && b.used && b.read ? [
    `  read: ${b.read}`,
    `  move: ${b.move}`,
    `  planned actions: ${(b.planned || []).length ? b.planned.join(' | ') : 'none'}`,
    `  end with: ${b.end_with || '-'} · language: ${b.language || '-'}`,
    `  already known: ${(b.already_known || []).join(' · ') || '-'}`,
    `  avoid: ${(b.avoid || []).join(' · ') || '-'}`
  ] : []),
  `branch=${res.branch ?? '-'} · cart=${short(res.cart || [])}`,
  `details=${short(res.details || {}, 500)}`,
  res.orders ? `orders=${short(res.orders)}` : '',
  t.order_placed ? `ORDER PLACED ${t.order_placed} (no ticket sent to the kitchen in a test)` : '',
  t.handoff && t.handoff.needed ? `HANDOFF: ${t.handoff.reason}` : ''
].filter(l => l !== '');
return [{ json: { output: lines.join('\n'), reply: said || null } }];
