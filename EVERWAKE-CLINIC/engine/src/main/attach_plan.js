// =====================================================================
// EVERWAKE CLINIC — Main · NODE: Attach Plan
// Reads the Brain's plan and builds the Agent's message for this turn:
//   FACTS · CLINIC · PLAN · THE CHAT · LATEST MESSAGE
// The plan is passed on as the Brain wrote it. If the Brain failed or
// timed out, the Agent gets no plan and decides the move herself — the
// turn never stalls on the Brain. Without a Brain in the workflow the
// input is the brief itself.
// =====================================================================
// @include shared/basics.js

const b = $('Build Brief').first().json;
const raw = $input.first().json || {};
const noBrain = raw.facts_text !== undefined;
const text = noBrain ? '' : String(raw.text ?? raw.output ?? raw.response ?? '').trim();
const clip = (v, n) => { const s = String(v ?? '').replace(/\s+/g, ' ').trim(); return s.length > n ? s.slice(0, n - 1) + '…' : s; };
const list = (v) => (Array.isArray(v) ? v : (v ? [v] : [])).map(x => typeof x === 'string' ? clip(x, 220) : clip(JSON.stringify(x), 260)).filter(Boolean);
function parsePlan(t) {
  if (!t) return null;
  const s = t.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '');
  const a = s.indexOf('{'), z = s.lastIndexOf('}');
  if (a === -1 || z <= a) return null;
  try { return JSON.parse(s.slice(a, z + 1)); } catch (e) { return null; }
}
const plan = parsePlan(text);
const brainError = raw.error ? clip(raw.error.message ?? raw.error, 300) : null;
const bool = (v) => v === true || String(v).toLowerCase() === 'true';

let planText, brain;
if (!plan || typeof plan !== 'object') {
  planText = noBrain ? '' : 'PLAN\n(no plan this turn — read everything and make the best move yourself)';
  brain = noBrain ? { used: false } : { used: false, error: brainError || (text ? 'unreadable plan' : 'empty plan'), raw: text.slice(0, 500) };
} else {
  const actions = (Array.isArray(plan.actions) ? plan.actions : []).map(a => `- ${clip(a && a.tool, 40) || 'manage_booking'}: ${clip(a && (a.do || a.what || a.action), 400)}`);
  const urgency = obj(plan.urgency);
  const handoff = obj(plan.handoff);
  const askTeam = list(plan.ask_team).slice(0, 2);
  planText = [
    'PLAN (from the head receptionist — the thinking is theirs, the words are yours)',
    `What is going on: ${clip(plan.read, 400)}`,
    `Stage: ${clip(plan.stage, 60)}`,
    `This reply must: ${clip(plan.objective, 260)}`,
    `The move: ${clip(plan.move, 800)}`,
    'Actions with manage_booking (in this order):',
    actions.length ? actions.join('\n') : '- none',
    `Urgency: ${clip(urgency.level, 20) || 'none'}${urgency.reason ? ' — ' + clip(urgency.reason, 200) : ''}`,
    `Ask the doctor/clinic: ${askTeam.length ? 'YES — ' + askTeam.join(' | ') : 'no'}`,
    `Handoff to the team: ${bool(handoff.needed) ? 'YES — ' + clip(handoff.reason, 200) : 'no'}`,
    `End with: ${clip(plan.end_with, 240) || '(nothing in particular)'}`,
    `They already know / already answered (never say or ask again): ${list(plan.already_known).join(' · ') || '(nothing yet)'}`,
    `Avoid: ${list(plan.avoid).join(' · ') || '-'}`,
    `Reply language: ${clip(plan.language, 10) || 'their language'}`,
    `The person writing is: ${/^(f|w|woman|female|she)/i.test(str(plan.person || plan.customer)) ? 'a woman — address her as a woman' : 'a man — address him as a man (معاك، تحب، حضرتك — never معاكي، تحبي)'}`,
    `Next: ${clip(plan.next, 300)}`
  ].join('\n');
  brain = {
    used: true, stage: clip(plan.stage, 60), objective: clip(plan.objective, 260), read: clip(plan.read, 400),
    other_readings: clip(plan.other_readings, 400), move: clip(plan.move, 800), end_with: clip(plan.end_with, 240),
    planned: actions, already_known: list(plan.already_known), avoid: list(plan.avoid), language: clip(plan.language, 10),
    person: clip(plan.person || plan.customer, 20), urgency: { level: clip(urgency.level, 20) || 'none', reason: clip(urgency.reason, 200) },
    handoff: bool(handoff.needed), ask_team: askTeam
  };
}
const safe = (s) => String(s == null ? '' : s).replace(/\{/g, '(').replace(/\}/g, ')');
planText = safe(planText);
const agentPrompt = [
  b.facts_text, '', b.business_text, '',
  ...(planText ? ['================ ' + planText.split('\n')[0] + ' ================', planText.split('\n').slice(1).join('\n'), ''] : []),
  '================ THE CHAT SO FAR (oldest first) ================', b.history_text || '(this is the first message)', '',
  '================ THEIR LATEST MESSAGE ================', b.latest_text
].join('\n');
return [{ json: { ...b, agent_started_at: new Date().toISOString(), brain, plan_text: planText, agent_prompt: agentPrompt,
                  agent_prompt_chars: agentPrompt.length } }];
