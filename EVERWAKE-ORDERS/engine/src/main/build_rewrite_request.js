// =====================================================================
// EVERWAKE — Main · NODE: Build Rewrite Request
// Only runs when Check Reply found a broken rail. The rewrite model has
// NO tools: the cart and details are already saved, so nothing can be
// done twice. It keeps the host's intent and voice and fixes only what
// is listed.
// =====================================================================
const d = $input.first().json;
const msg = [
  d.facts_text,
  '',
  '================ MENU (prices are only these) ================',
  d.menu_text,
  '',
  '================ THE CHAT SO FAR ================',
  d.history_text || '(first message)',
  '',
  '================ CUSTOMER\'S LATEST MESSAGE ================',
  d.latest_text,
  '',
  '================ THE DRAFT REPLY ================',
  (d.decision.reply_messages || []).join('\n[[NEXT]]\n'),
  '',
  '================ WHAT IS WRONG WITH IT ================',
  (d.violations || []).map(v => '- ' + v).join('\n'),
  '',
  'Rewrite the draft so every problem above is fixed. Keep its intent, its language, its warmth and everything in it that was right. Change nothing else.'
].join('\n').replace(/\{/g, '(').replace(/\}/g, ')');   // prompt templates read { } as variables
return [{ json: { ...d, rewrite_prompt: msg, rewrite_started_at: new Date().toISOString() } }];
