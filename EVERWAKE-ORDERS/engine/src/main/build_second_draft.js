// =====================================================================
// EVERWAKE — Main · NODE: Build Second Draft Request
// Only runs when Check Reply found a hard truth broken (a number that is
// not real, a placement that didn't happen, a leaked code…). The same
// Writer, with the same brief, writes the reply once more knowing exactly
// what was wrong. No tools: nothing can be done twice.
// =====================================================================
const d = $input.first().json;
const msg = [
  d.writer_prompt,
  '',
  '================ YOUR FIRST DRAFT ================',
  ((d.decision && d.decision.reply_messages) || []).join('\n[[NEXT]]\n') || '(empty)',
  '',
  '================ WHAT IS WRONG WITH IT (hard facts, not style) ================',
  (d.violations || []).map(v => '- ' + v).join('\n'),
  '',
  'Write the reply again with every problem above fixed. Keep everything that was right in it — its intent, its warmth, its language.'
].join('\n').replace(/\{/g, '(').replace(/\}/g, ')');   // prompt templates read { } as variables
return [{ json: { ...d, second_prompt: msg, second_started_at: new Date().toISOString() } }];
