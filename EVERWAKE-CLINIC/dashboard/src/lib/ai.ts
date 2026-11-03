import 'server-only';

// OpenAI from the dashboard's server: the key never reaches the browser. Every model is an
// environment variable with a default, so a clinic can change one without a new build.
export const MODELS = {
  scribeTranscribe: process.env.SCRIBE_TRANSCRIBE_MODEL || 'gpt-transcribe',
  scribeDiarize: process.env.SCRIBE_DIARIZE_MODEL || 'gpt-4o-transcribe-diarize',    // 'off' skips the who-said-what pass
  scribeExtract: process.env.SCRIBE_EXTRACT_MODEL || 'gpt-5.6-luna',
  scribeVerify: process.env.SCRIBE_VERIFY_MODEL || 'gpt-5-mini',
  assistant: process.env.ASSISTANT_MODEL || 'gpt-5.6-luna',
  assistantTranscribe: process.env.ASSISTANT_TRANSCRIBE_MODEL || 'gpt-transcribe',
  assistantTts: process.env.ASSISTANT_TTS_MODEL || 'gpt-4o-mini-tts'
};
export const hasKey = () => Boolean(process.env.OPENAI_API_KEY);
const key = () => {
  const k = process.env.OPENAI_API_KEY;
  if (!k) throw new Error('NEEDS_OPENAI_KEY');
  return k;
};

export interface Usage { input_tokens?: number; output_tokens?: number; total_tokens?: number }

// a strict JSON answer (structured outputs) from a system prompt and the user's material
export async function jsonCall<T>({ model, system, user, schema, name, timeout = 110_000, effort }:
  { model: string; system: string; user: string; schema: Record<string, unknown>; name: string; timeout?: number; effort?: 'minimal' | 'low' | 'medium' | 'high' }):
  Promise<{ data: T; usage: Usage | null }> {
  const res = await fetch('https://api.openai.com/v1/responses', {
    method: 'POST', headers: { authorization: `Bearer ${key()}`, 'content-type': 'application/json' },
    body: JSON.stringify({ model, instructions: system, input: [{ role: 'user', content: [{ type: 'input_text', text: user }] }],
      text: { format: { type: 'json_schema', name, strict: true, schema } }, store: false,
      ...(effort ? { reasoning: { effort } } : {}) }),
    signal: AbortSignal.timeout(timeout)
  });
  if (!res.ok) throw new Error(`The AI did not answer (${res.status}): ${(await res.text()).slice(0, 300)}`);
  const j = await res.json();
  const text: string = j.output_text ?? (j.output || []).flatMap((o: { content?: { type: string; text?: string }[] }) => o.content || [])
    .filter((c: { type: string }) => c.type === 'output_text').map((c: { text?: string }) => c.text || '').join('');
  return { data: JSON.parse(text || '{}') as T, usage: j.usage || null };
}

// speech to text; with a diarising model, who said what (speaker "A", "B" with times)
export async function transcribe(audio: Blob, { model, prompt, diarize = false, filename = 'audio.webm', timeout = 90_000 }:
  { model: string; prompt?: string; diarize?: boolean; filename?: string; timeout?: number }):
  Promise<{ text: string; segments?: { speaker?: string; start?: number; end?: number; text?: string }[] }> {
  const form = new FormData();
  form.append('file', audio, filename);
  form.append('model', model);
  if (diarize) { form.append('response_format', 'diarized_json'); form.append('chunking_strategy', 'auto'); }
  else { form.append('response_format', 'json'); if (prompt) form.append('prompt', prompt.slice(0, 900)); }
  const res = await fetch('https://api.openai.com/v1/audio/transcriptions', {
    method: 'POST', headers: { authorization: `Bearer ${key()}` }, body: form, signal: AbortSignal.timeout(timeout)
  });
  if (!res.ok) throw new Error(`Transcription failed (${res.status}): ${(await res.text()).slice(0, 200)}`);
  const j = await res.json();
  return { text: String(j.text || ''), segments: Array.isArray(j.segments) ? j.segments : undefined };
}

// a reply read aloud (the assistant's optional voice)
export async function speak(text: string, { model = MODELS.assistantTts, voice = 'sage' } = {}): Promise<ArrayBuffer> {
  const res = await fetch('https://api.openai.com/v1/audio/speech', {
    method: 'POST', headers: { authorization: `Bearer ${key()}`, 'content-type': 'application/json' },
    body: JSON.stringify({ model, voice, input: text.slice(0, 3000), response_format: 'mp3' }), signal: AbortSignal.timeout(60_000)
  });
  if (!res.ok) throw new Error(`The voice did not answer (${res.status})`);
  return res.arrayBuffer();
}

// Server-sent events: named stages while the work runs, then the result
export function sse(work: (send: (event: string, data: unknown) => void) => Promise<void>): Response {
  const enc = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      const send = (event: string, data: unknown) => controller.enqueue(enc.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
      const ping = setInterval(() => controller.enqueue(enc.encode(': ping\n\n')), 15_000);
      try { await work(send); }
      catch (e) { send('error', { message: e instanceof Error ? e.message : String(e) }); }
      finally { clearInterval(ping); controller.close(); }
    }
  });
  return new Response(stream, { headers: { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache, no-transform', 'x-accel-buffering': 'no' } });
}
