// =====================================================================
// EVERWAKE — Main · NODE: Attach Plan
//
// Reads the Brain's plan and builds the Agent's message for this turn:
//   FACTS · BUSINESS FACTS · MENU · PLAN · THE CHAT · LATEST MESSAGE
//
// The plan is passed on as the Brain wrote it — no trimming of its
// thinking, no overriding. Only fact checks:
//   · a dish code the Brain named that is not on the menu is flagged
//   · menu pictures are dropped when there are none
//   · dish photos are kept only for dishes that have one
// If the Brain failed or timed out, the Agent gets no plan and decides
// the move herself — the turn never stalls on the Brain.
// Without a Brain in the workflow (the default) the input is the brief
// itself: there is no plan, and the Agent thinks the turn through alone.
// =====================================================================
// @include shared/basics.js

const b = $('Build Brief').first().json;
const raw = $input.first().json || {};
const noBrain = raw.facts_text !== undefined;          // the input is Build Brief's own output
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
const CODE = /\bM\d{3,5}\b/g;

let planText, brain;
if (!plan || typeof plan !== 'object') {
  planText = noBrain ? '' : 'PLAN\n(no plan this turn — read everything and make the best move yourself)';
  brain = noBrain ? { used: false } : { used: false, error: brainError || (text ? 'unreadable plan' : 'empty plan'), raw: text.slice(0, 500) };
} else {
  const menuIds = new Set(b.menu_text.match(CODE) || []);
  const actions = (Array.isArray(plan.actions) ? plan.actions : []).map(a => {
    const tool = clip(a && a.tool, 40);
    const doing = clip(a && (a.do || a.what || a.action), 400);
    const ids = (doing.match(CODE) || []).filter(id => !menuIds.has(id));
    return `- ${tool}: ${doing}${ids.length ? `  (note: ${ids.join(', ')} is not on the current menu — check before using)` : ''}`;
  });
  let sendMenu = bool(plan.send_menu_images);
  let menuNote = '';
  // a branch found this turn (from their area) may have its own pages — Check Reply decides with that branch
  if (sendMenu && !b.menu_pages_available && !b.menu_pages_by_branch) {
    sendMenu = false;
    menuNote = ' (no menu pictures are uploaded — offer the dishes in text)';
  }
  const photoCodes = new Set(arr(b.photo_codes));
  const photos = list(plan.send_item_photos).map(x => (String(x).match(CODE) || [])[0]).filter(Boolean);
  const photosOk = [...new Set(photos.filter(c => photoCodes.has(c)))].slice(0, 3);
  const photosMissing = photos.filter(c => !photoCodes.has(c));
  const handoff = plan.handoff && typeof plan.handoff === 'object' ? plan.handoff : {};
  planText = [
    'PLAN (from the head host — the thinking is theirs, the words are yours)',
    `What is going on: ${clip(plan.read, 400)}`,
    `Stage: ${clip(plan.stage, 60)}`,
    `This reply must: ${clip(plan.objective, 260)}`,
    `The move: ${clip(plan.move, 800)}`,
    'Actions with your tools (in this order):',
    actions.length ? actions.join('\n') : '- none',
    `Show the full order summary: ${bool(plan.show_summary) ? 'YES' : 'no'}`,
    `Place the order now: ${bool(plan.place_order) ? 'YES — call manage_cart place_order' : 'no'}`,
    `Send the menu pictures: ${sendMenu ? 'YES (set send_menu_images true)' : 'no'}${menuNote}`,
    `Send dish photos: ${photosOk.length ? 'YES — ' + photosOk.join(', ') + ' (put them in send_item_photos)' : 'no'}${photosMissing.length ? ` (no photo on file for ${photosMissing.join(', ')} — describe it instead)` : ''}`,
    `Handoff to the team: ${bool(handoff.needed) ? 'YES — ' + clip(handoff.reason, 200) : 'no'}`,
    `End with: ${clip(plan.end_with, 240) || '(nothing in particular)'}`,
    `They already know / already answered (never say or ask again): ${list(plan.already_known).join(' · ') || '(nothing yet)'}`,
    `Avoid: ${list(plan.avoid).join(' · ') || '-'}`,
    `Reply language: ${clip(plan.language, 10) || 'their language'}`,
    `The customer is: ${/^(f|w|woman|female|she)/i.test(str(plan.customer)) ? 'a woman — address her as a woman' : 'a man — address him as a man (معاك، تحب، حضرتك — never معاكي، تحبي)'}`,
    `Next: ${clip(plan.next, 300)}`
  ].join('\n');
  brain = {
    used: true, stage: clip(plan.stage, 60), objective: clip(plan.objective, 260),
    read: clip(plan.read, 400), other_readings: clip(plan.other_readings, 400), move: clip(plan.move, 800), end_with: clip(plan.end_with, 240),
    planned: actions, already_known: list(plan.already_known), avoid: list(plan.avoid), language: clip(plan.language, 10), customer: clip(plan.customer, 20),
    actions: actions.length, show_summary: bool(plan.show_summary), place_order: bool(plan.place_order),
    send_menu_images: sendMenu, send_item_photos: photosOk, handoff: bool(handoff.needed)
  };
}

const safe = (s) => String(s == null ? '' : s).replace(/\{/g, '(').replace(/\}/g, ')');
planText = safe(planText);
const agentPrompt = [
  b.facts_text, '', b.business_text, '',
  '================ MENU ================', b.menu_text, '',
  ...(planText ? ['================ ' + planText.split('\n')[0] + ' ================', planText.split('\n').slice(1).join('\n'), ''] : []),
  '================ THE CHAT SO FAR (oldest first) ================', b.history_text || '(this is the first message)', '',
  '================ THE CUSTOMER\'S LATEST MESSAGE ================', b.latest_text
].join('\n');

return [{
  json: {
    ...b,
    agent_started_at: new Date().toISOString(),
    brain,
    plan_text: planText,
    agent_prompt: agentPrompt,
    agent_prompt_chars: agentPrompt.length
  }
}];
