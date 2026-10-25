// =====================================================================
// EVERWAKE — Main · NODE: Build Writer Request
//
// The Brain has read the turn, thought it through and done what had to be
// done with the tools. This node hands its decision to the Writer, who
// only writes: the brief (what the reply must carry and how it ends), the
// FACTS as they are now (after the Brain's actions), what the tools gave
// back (exact numbers), the chat and the customer's latest message.
// The Writer gets no MENU and no tools — it can't wander, and it can't do
// anything twice.
// If the Brain failed, the Writer still answers from the chat and FACTS,
// and changes nothing.
// =====================================================================
// @include shared/basics.js

const before = $('Build Brief').first().json;
const after = $('Refresh Facts').first().json;
const raw = $('Brain').first().json || {};

const clip = (v, n) => { const s = String(v ?? '').replace(/\s+/g, ' ').trim(); return s.length > n ? s.slice(0, n - 1) + '…' : s; };
const list = (v) => (Array.isArray(v) ? v : (v ? [v] : [])).map(x => typeof x === 'string' ? clip(x, 300) : clip(JSON.stringify(x), 300)).filter(Boolean);
const bool = (v) => v === true || String(v).toLowerCase() === 'true';
const safe = (s) => String(s == null ? '' : s).replace(/\{/g, '(').replace(/\}/g, ')');

// ---- the Brain's decision: its last message is one JSON object ------------------------
function parsePlan(t) {
  if (!t) return null;
  if (typeof t === 'object') return t;
  const s = String(t).replace(/^\s*```(?:json)?\s*/i, '').replace(/```\s*$/, '');
  const a = s.indexOf('{'), z = s.lastIndexOf('}');
  if (a === -1 || z <= a) return null;
  const body = s.slice(a, z + 1);
  for (const x of [body, body.replace(/,\s*([}\]])/g, '$1'),
                   body.replace(/"(?:[^"\\]|\\.)*"/g, m => m.replace(/\r?\n/g, '\\n')).replace(/,\s*([}\]])/g, '$1')]) {
    try { return JSON.parse(x); } catch (e) { /* next */ }
  }
  return null;
}
let out = raw.output ?? raw.text ?? raw.response ?? null;
if (out && typeof out === 'object' && out.output) out = out.output;
const plan = obj(parsePlan(out));
const brainError = raw.error ? clip(obj(raw.error).message || raw.error, 300) : null;
const hasPlan = Object.keys(plan).length > 0;

// ---- what the tools gave back: the exact numbers, in plain lines — without the notes meant for
// the Brain and without internal codes (nothing the Writer could leak) ---------------------------
const SKIP = new Set(['fact', 'expected', 'hint', 'id', 'line_id', 'menu_id', 'pending_id', 'price_known', 'cart_saved',
                      'currency_symbol', 'tenant_id', 'wa_id', 'zone_id', 'branch_id', 'customer_id', 'order_id']);
const plain = (v, depth = 0) => {
  if (v == null || v === '' || v === false) return '';
  if (Array.isArray(v)) { const xs = v.map(x => plain(x, depth + 1)).filter(Boolean); return xs.length ? '[' + xs.join(' ; ') + ']' : ''; }
  if (typeof v === 'object') {
    return Object.entries(v).filter(([k]) => !SKIP.has(k))
      .map(([k, x]) => { const t = plain(x, depth + 1); return t ? `${k.replace(/_/g, ' ')}: ${t}` : ''; })
      .filter(Boolean).join(depth ? ', ' : ' · ');
  }
  return String(v);
};
const steps = arr(raw.intermediateSteps ?? raw.intermediate_steps);
const toolLines = steps.map(st => {
  const tool = str(obj(obj(st).action).tool);
  let o = obj(st).observation;
  try { o = typeof o === 'string' ? JSON.parse(o) : o; } catch (e) { /* text */ }
  if (Array.isArray(o)) o = o[0];
  if (o && typeof o === 'object' && typeof o.response === 'string') { try { o = JSON.parse(o.response); } catch (e) { /* text */ } }
  const failed = !o || typeof o !== 'object' || (o.error != null && !o.status);
  return tool ? `- ${tool}: ${failed ? 'FAILED — nothing changed' : clip(plain(o), 1800)}` : '';
}).filter(Boolean);

// ---- the brief ------------------------------------------------------------------------------
const say = list(plan.say);
const handoff = obj(plan.handoff);
const photos = [...new Set(list(plan.send_item_photos).map(x => (x.match(/\bM\d{3,5}\b/) || [])[0]).filter(Boolean))]
  .filter(c => arr(before.photo_codes).includes(c)).slice(0, 3);
const sendMenu = bool(plan.send_menu_images) && !!(after.menu_pages_available || after.menu_pages_by_branch || before.menu_pages_by_branch);
const briefText = !hasPlan
  ? 'NO BRIEF THIS TURN (the head host could not be reached). Answer what they said in a few natural words from the chat, FACTS and what the tools did; if they asked for something the tools did not do, say you are on it in a few words or ask the one thing needed. Never say anything was added, saved or placed that the tools do not show.'
  : [
      `What is going on: ${clip(plan.read, 500)}`,
      `This reply must: ${clip(plan.objective, 300)}`,
      `The move: ${clip(plan.move, 900)}`,
      'The substance (notes for you, not sentences — every fact the reply states comes from here, FACTS or the tools):',
      say.length ? say.map(s => '- ' + s).join('\n') : '- (nothing beyond the move)',
      `The moment: ${clip(plan.moment, 300) || '-'}`,
      `End with: ${clip(plan.ask ?? plan.end_with, 300) || '(no question needed)'}`,
      `The full order summary goes in this reply: ${bool(plan.show_summary) ? 'YES' : 'no'}`,
      `The menu pictures go with this reply: ${sendMenu ? 'YES — a few words with them, never an offer to send them' : 'no'}`,
      `Dish photos go with this reply: ${photos.length ? 'YES' : 'no'}`,
      `They already know (never say or ask again): ${list(plan.already_known).join(' · ') || '-'}`,
      `Avoid: ${list(plan.avoid).join(' · ') || '-'}`,
      `Write in: ${clip(plan.language, 10) || 'their language'} · the customer is ${/^(f|w|woman|female|she)/i.test(str(plan.customer)) ? 'a woman' : 'a man (until their words or name show a woman)'}`
    ].join('\n');

const writerPrompt = [
  safe(after.facts_text || before.facts_text), '',
  '================ WHAT THE TOOLS DID THIS TURN (exact numbers — use them as they are) ================',
  toolLines.length ? safe(toolLines.join('\n')) : '- nothing: no tool ran this turn, so nothing was added, changed or saved',
  '',
  '================ THE CHAT SO FAR (oldest first) ================', before.history_text || '(this is the first message)', '',
  '================ THE CUSTOMER\'S LATEST MESSAGE ================', before.latest_text, '',
  '================ YOUR BRIEF FROM THE HEAD HOST ================', safe(briefText)
].join('\n');

const brain = !hasPlan ? { used: false, error: brainError || (out ? 'unreadable plan' : 'empty plan'), raw: clip(out, 400) } : {
  used: true, stage: clip(plan.stage, 60), objective: clip(plan.objective, 300),
  read: clip(plan.read, 500), other_readings: clip(plan.other_readings, 400), move: clip(plan.move, 900),
  say, moment: clip(plan.moment, 300), end_with: clip(plan.ask ?? plan.end_with, 300), already_known: list(plan.already_known), avoid: list(plan.avoid),
  language: clip(plan.language, 10), customer: clip(plan.customer, 20),
  show_summary: bool(plan.show_summary), send_menu_images: sendMenu, send_item_photos: photos, handoff: bool(handoff.needed),
  actions: steps.length
};

return [{
  json: {
    ...before,
    facts_text_after: after.facts_text,
    missing_details: after.missing_details ?? before.missing_details,
    plan: hasPlan ? {
      show_summary: bool(plan.show_summary), send_menu_images: sendMenu, send_item_photos: photos,
      handoff: { needed: bool(handoff.needed), reason: str(handoff.reason) },
      language: str(plan.language) || null, memory_note: str(plan.memory_note)
    } : { show_summary: false, send_menu_images: false, send_item_photos: [], handoff: { needed: false, reason: '' }, language: null, memory_note: '' },
    brain,
    writer_started_at: new Date().toISOString(),
    writer_prompt: writerPrompt,
    writer_prompt_chars: writerPrompt.length
  }
}];
