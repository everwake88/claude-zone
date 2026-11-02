// =====================================================================
// EVERWAKE CLINIC — Main · NODE: Check Staff Reply
// The staff assistant's reply: read, tidied, and never claiming a send or
// a change the tool didn't return.
// =====================================================================
// @include shared/basics.js

const b = $('Build Staff Brief').first().json;
const agent = $input.first().json || {};
let dec = agent.output ?? agent.text ?? '';
if (typeof dec === 'string') {
  const s = dec.replace(/^\s*```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim();
  const a = s.indexOf('{'), z = s.lastIndexOf('}');
  try { dec = a >= 0 && z > a ? JSON.parse(s.slice(a, z + 1)) : { reply_messages: [s] }; } catch (e) { dec = { reply_messages: [s] }; }
}
dec = obj(dec);
const steps = arr(agent.intermediateSteps);
const results = steps.map(st => { let o = obj(st).observation; try { o = typeof o === 'string' ? JSON.parse(o) : o; } catch (e) { o = {}; }
  if (o && typeof o.response === 'string') { try { o = JSON.parse(o.response); } catch (e) { /* keep */ } } return obj(o); });
const done = results.some(o => ['SENT', 'CANCELLED', 'BLOCKED', 'APPLIED', 'UNDONE'].includes(str(o.status)));
let messages = arr(dec.reply_messages).map(str).filter(Boolean).map(m => m.replace(/\*\*(.+?)\*\*/g, '*$1*'));
const violations = [];
if (!done && messages.some(m => /(اتبعت|بعتلهم|تم الإرسال|تم الارسال|اتغير السعر|اتعدل|اتضاف|اتشال|اتقفل|✅)/.test(m) && !/(أبعت|ابعت؟|هبعت|لو موافق|\?|؟)/.test(m))) {
  violations.push('claimed done without a confirm');
  messages = [/[؀-ۿ]/.test(messages.join('')) ? 'لسه متبعتش حاجة — قولي "تمام" وأنا أبعت.' : 'Nothing was sent yet — say "OK" and I will send it.'];
}
if (!messages.length) messages = ['تمام 👍'];
return [{ json: { ...b, decision: { reply_messages: messages.slice(0, 2), language: str(dec.language) || null }, violations,
                  tool_calls: results.map(o => ({ status: o.status || o.error || null })), agent_error: agent.error ? str(agent.error.message || agent.error) : null,
                  agent_tokens: obj(agent.tokenUsage) } }];
