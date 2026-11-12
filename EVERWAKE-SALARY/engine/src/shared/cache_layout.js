// ---- the request laid out for OpenAI's prompt cache (GPT-5.6 and later, GPT-6 included) ---------------------------
// These models find a cached prompt again only at a saved breakpoint; anything after the last one is
// written to the cache again (1.25× the input price) instead of read from it (0.1×). So the message is
// sent in blocks, and the parts that read the same next time are breakpoints:
//   · the steady part: the company and its rules (the same for every employee)
//   · the last two complete blocks of the chat (the same next turn, see Agent Request)
// The instructions go first, as a developer message (OpenAI keeps that start cached by itself).
// With the implicit breakpoint at the end, that is four: the most a request may write.
function cachedInput(instructions, steady, chat, rest) {
  const bp = { mode: 'explicit' };
  const blocks = [{ type: 'input_text', text: String(steady || ''), prompt_cache_breakpoint: bp }];
  const c = arr(chat).map(String);
  c.forEach((t, i) => {
    const complete = i < c.length - 1;
    blocks.push({ type: 'input_text', text: t, ...(complete && i >= c.length - 3 ? { prompt_cache_breakpoint: bp } : {}) });
  });
  blocks.push({ type: 'input_text', text: String(rest || '') });
  return [
    { role: 'developer', content: [{ type: 'input_text', text: String(instructions || '') }] },
    { role: 'user', content: blocks }
  ];
}
const CACHE_OPTIONS = { mode: 'implicit', ttl: '30m' };
