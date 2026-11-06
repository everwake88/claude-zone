// ---- OpenAI answers, read the same way by every node ----------------------------
// n8n calls OpenAI itself (HTTP Request nodes, the OpenAI credential), so each
// answer carries its exact usage: input tokens (the cached part included),
// output tokens (the thinking included) — or a voice note's seconds. Each call
// becomes one record for everwake.record_ai_usage, priced in the database.

// an HTTP Request node's output: its full response ({ statusCode, body }), the body
// alone, or n8n's { error } when the call failed after its retries
function openaiAnswer(res) {
  const r = obj(res);
  let body = r.body !== undefined && (r.statusCode !== undefined || r.headers !== undefined) ? r.body : r;
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch (e) { body = { error: { message: body.slice(0, 300) } }; }
  }
  body = obj(body);
  const nodeErr = r.error && !r.usage ? r.error : null;           // n8n's own error item
  const apiErr = body.error || null;
  const errOf = (e) => (e == null ? '' : typeof e === 'string' ? e : str(obj(e).message || obj(e).description || JSON.stringify(e)));
  const error = (errOf(apiErr) || errOf(nodeErr)).slice(0, 300) || null;
  const status = Number(r.statusCode || obj(nodeErr).httpCode || obj(nodeErr).status || (error ? 0 : 200)) || 0;
  return { body, status, error: error || (status >= 400 ? `HTTP ${status}` : null) };
}

// the tokens of one answer: the Responses API, Chat Completions, or a transcription
function usageOf(body) {
  const u = obj(obj(body).usage);
  const n = (v) => (typeof v === 'number' && isFinite(v) ? Math.max(0, Math.round(v)) : 0);
  if (u.type === 'duration') return { input: 0, cached: 0, output: 0, thinking: 0, seconds: Number(u.seconds) || 0 };
  return {
    input: n(u.input_tokens ?? u.prompt_tokens),
    cached: n(obj(u.input_tokens_details ?? u.prompt_tokens_details).cached_tokens),
    output: n(u.output_tokens ?? u.completion_tokens),
    thinking: n(obj(u.output_tokens_details ?? u.completion_tokens_details).reasoning_tokens),
    seconds: null
  };
}

// one record: which step, which model (as OpenAI reports it), the tokens, the status, how long
function aiCall(step, endpoint, model, answer, startedAt) {
  const u = usageOf(answer.body);
  const started = startedAt ? new Date(startedAt).getTime() : NaN;
  return {
    step, endpoint, model: str(answer.body.model || model) || null,
    input: u.input, cached: u.cached, output: u.output, thinking: u.thinking,
    ...(u.seconds != null ? { seconds: u.seconds } : {}),
    status: answer.status, ms: isFinite(started) ? Math.max(0, Date.now() - started) : null,
    ...(answer.error ? { error: answer.error } : {})
  };
}

// the words of a Responses API answer (its message items' output_text parts)
function outputText(body) {
  if (typeof obj(body).output_text === 'string') return body.output_text;
  return arr(obj(body).output).filter(o => obj(o).type === 'message')
    .flatMap(o => arr(obj(o).content)).filter(c => obj(c).type === 'output_text')
    .map(c => str(c.text)).join('');
}
