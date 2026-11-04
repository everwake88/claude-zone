// The AI meter: the engine's calls to OpenAI pass through here on their way, so every call's
// real usage is recorded — input, cached input, output, thinking — for the developer's cost pages.
//
//   <dashboard>/api/ai/t/<tenant>/<message id>/<run id>/<step>/<kind>/v1/<chat/completions | responses | audio/transcriptions>
//
// The request goes on to OpenAI as it came (the caller's own key), with the restaurant's AI settings
// applied (model, how hard the step thinks) and a cache key so its steady prompt is found again.
// The answer goes straight back; the usage is written after it, so the meter never slows a reply
// and a problem recording it never breaks one.
import { createHash } from 'node:crypto';
import { after, type NextRequest } from 'next/server';
import { adminClient } from '@/lib/supabase/server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 300;

const UPSTREAM = 'https://api.openai.com/v1/';
const ALLOWED = /^(chat\/completions|responses|audio\/transcriptions|models)$/;
const STEPS = new Set(['brain', 'agent', 'transcribe', 'vision', 'other']);
const KINDS = new Set(['text', 'voice', 'image', 'test']);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const EFFORTS = new Set(['minimal', 'low', 'medium', 'high']);

interface Meta { tenant: string; message: number | null; run: string | null; step: string; kind: string }
interface Settings { brain_model?: string | null; brain_effort?: string | null; agent_model?: string | null; agent_effort?: string | null }
type Json = Record<string, unknown>;

// a restaurant's AI settings, kept for a minute
const kept = new Map<string, { at: number; v: Settings | null }>();
async function settingsFor(tenant: string): Promise<Settings | null> {
  const k = kept.get(tenant);
  if (k && Date.now() - k.at < 60000) return k.v;
  let v: Settings | null = null;
  try { v = ((await adminClient().rpc('ai_settings', { p_tenant: tenant })).data as Settings) || null; } catch { v = null; }
  kept.set(tenant, { at: Date.now(), v });
  return v;
}

function metaOf(path: string[]): { meta: Meta | null; rest: string[] } {
  if (path[0] === 't' && path.length >= 8 && path[6] === 'v1') {
    const [, tenant, message, run, step, kind] = path;
    if (!UUID.test(tenant)) return { meta: null, rest: path.slice(7) };
    return { meta: { tenant, message: /^\d+$/.test(message) ? Number(message) : null, run: run && run !== 'x' ? decodeURIComponent(run).slice(0, 120) : null,
                     step: STEPS.has(step) ? step : 'other', kind: KINDS.has(kind) ? kind : 'text' }, rest: path.slice(7) };
  }
  return { meta: null, rest: path[0] === 'v1' ? path.slice(1) : path };
}

// the restaurant's model and effort for this step, and a cache key per restaurant and step
function adjust(body: Json, meta: Meta, s: Settings | null, endpoint: string) {
  if (endpoint === 'audio/transcriptions' || endpoint === 'models') return;
  const model = meta.step === 'brain' ? s?.brain_model : meta.step === 'agent' ? s?.agent_model : null;
  const effort = meta.step === 'brain' ? s?.brain_effort : meta.step === 'agent' ? s?.agent_effort : null;
  if (model) body.model = model;
  if (effort && EFFORTS.has(effort)) {
    if (endpoint === 'responses') body.reasoning = { ...(body.reasoning as Json || {}), effort };
    else if ('reasoning_effort' in body || meta.step === 'brain' || meta.step === 'agent') body.reasoning_effort = effort;
  }
  if (!body.prompt_cache_key && (meta.step === 'brain' || meta.step === 'agent')) body.prompt_cache_key = `ew-${meta.tenant}-${meta.step}`;
}

function usageOf(r: Json | null) {
  const u = (r?.usage || (r?.response as Json | undefined)?.usage) as Json | undefined;
  if (!u) return null;
  const n = (v: unknown) => (typeof v === 'number' && isFinite(v) ? Math.round(v) : 0);
  const d = (o: unknown, k: string) => n((o as Json | undefined)?.[k]);
  if (u.type === 'duration') return { input: 0, cached: 0, output: 0, thinking: 0, seconds: Number(u.seconds) || null };
  return {
    input: n(u.prompt_tokens ?? u.input_tokens),
    cached: d(u.prompt_tokens_details ?? u.input_tokens_details, 'cached_tokens'),
    output: n(u.completion_tokens ?? u.output_tokens),
    thinking: d(u.completion_tokens_details ?? u.output_tokens_details, 'reasoning_tokens'),
    seconds: null as number | null
  };
}

// a streamed answer: its usage comes in the last events
async function usageOfStream(stream: ReadableStream<Uint8Array>) {
  const reader = stream.getReader(), dec = new TextDecoder();
  let buf = '', found: Json | null = null, model: string | null = null;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
      if (!line.startsWith('data:')) continue;
      const data = line.slice(5).trim();
      if (data === '[DONE]') continue;
      try {
        const j = JSON.parse(data) as Json;
        if (j.usage || (j.response as Json | undefined)?.usage) found = j;
        model = (j.model as string) || ((j.response as Json | undefined)?.model as string) || model;
      } catch { /* a partial event */ }
    }
  }
  return { usage: usageOf(found), model };
}

async function record(meta: Meta, endpoint: string, model: string | null, usage: ReturnType<typeof usageOf>, status: number, ms: number) {
  if (endpoint === 'models') return;
  try {
    await adminClient().from('ai_usage').insert({
      tenant_id: meta.tenant, run_id: meta.run, message_id: meta.message, step: meta.step, kind: meta.kind,
      model, endpoint, input_tokens: usage?.input || 0, cached_tokens: usage?.cached || 0, output_tokens: usage?.output || 0,
      reasoning_tokens: usage?.thinking || 0, audio_seconds: usage?.seconds ?? null, http_status: status, duration_ms: ms
    });
  } catch { /* the reply already went back; a lost record is not worth a failed turn */ }
}

async function handle(req: NextRequest, { params }: { params: Promise<{ path: string[] }> }) {
  const { path } = await params;
  const { meta, rest } = metaOf(path || []);
  const endpoint = rest.join('/');
  if (!ALLOWED.test(endpoint)) return Response.json({ error: { message: 'not an endpoint the meter passes on' } }, { status: 404 });

  const auth = req.headers.get('authorization') || '';
  // optionally only Everwake's own key(s): EW_AI_KEY_SHA256 = sha256 of each allowed key, comma separated
  const allowed = process.env.EW_AI_KEY_SHA256;
  if (allowed) {
    const h = createHash('sha256').update(auth.replace(/^Bearer\s+/i, '')).digest('hex');
    if (!allowed.split(',').map(s => s.trim()).includes(h)) return Response.json({ error: { message: 'key not allowed' } }, { status: 403 });
  }

  const type = req.headers.get('content-type') || '';
  let body: BodyInit | undefined, model: string | null = null;
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    if (type.includes('application/json')) {
      const text = await req.text();
      let json: Json | null = null;
      try { json = JSON.parse(text); } catch { json = null; }
      if (json && meta) { try { adjust(json, meta, await settingsFor(meta.tenant), endpoint); } catch { /* sent as it came */ } }
      model = (json?.model as string) || null;
      body = json ? JSON.stringify(json) : text;
    } else {
      const buf = Buffer.from(await req.arrayBuffer());
      // a voice note's form: its model is one of the fields
      const m = /name="model"\r?\n\r?\n([^\r\n]+)/.exec(buf.toString('latin1'));
      model = m ? m[1].trim() : null;
      body = buf;
    }
  }

  const headers = new Headers();
  for (const h of ['authorization', 'content-type', 'accept', 'openai-organization', 'openai-project', 'openai-beta']) {
    const v = req.headers.get(h); if (v) headers.set(h, v);
  }
  const t0 = Date.now();
  let res: Response;
  try {
    res = await fetch(UPSTREAM + endpoint + (req.nextUrl.search || ''), { method: req.method, headers, body });
  } catch (e) {
    return Response.json({ error: { message: 'could not reach OpenAI: ' + (e as Error).message } }, { status: 502 });
  }
  const out = new Headers();
  for (const h of ['content-type', 'x-request-id', 'openai-processing-ms', 'retry-after']) { const v = res.headers.get(h); if (v) out.set(h, v); }

  if (res.body && (res.headers.get('content-type') || '').includes('text/event-stream')) {
    const [toCaller, toMeter] = res.body.tee();
    if (meta) after(async () => { const s = await usageOfStream(toMeter); await record(meta, endpoint, s.model || model, s.usage, res.status, Date.now() - t0); });
    return new Response(toCaller, { status: res.status, headers: out });
  }
  const text = await res.text();
  if (meta) {
    after(async () => {
      let j: Json | null = null;
      try { j = JSON.parse(text); } catch { j = null; }
      await record(meta, endpoint, (j?.model as string) || model, usageOf(j), res.status, Date.now() - t0);
    });
  }
  return new Response(text, { status: res.status, headers: out });
}

export const POST = handle;
export const GET = handle;
