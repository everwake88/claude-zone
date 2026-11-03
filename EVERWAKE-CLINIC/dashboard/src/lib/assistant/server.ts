import 'server-only';
import { MODELS } from '@/lib/ai';
import type { DB } from '@/lib/supabase/client';
import type { TenantSummary } from '@/lib/types';
import type { Model, ModelEvent } from './loop';
import type { Page, Who } from './tools';

// The OpenAI Responses API, streamed: words as they come, each tool call once it is complete, and
// the turn's items (reasoning kept, encrypted, so nothing is stored at OpenAI) to send back.
export const openaiModel: Model = async function* ({ instructions, input, tools }) {
  const key = process.env.OPENAI_API_KEY;
  if (!key) throw new Error('NEEDS_OPENAI_KEY');
  const res = await fetch('https://api.openai.com/v1/responses', {
    method: 'POST', headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
    body: JSON.stringify({ model: MODELS.assistant, instructions, input, tools, stream: true, store: false,
                           include: ['reasoning.encrypted_content'], parallel_tool_calls: true, reasoning: { effort: 'low' } }),
    signal: AbortSignal.timeout(120_000)
  });
  if (!res.ok || !res.body) throw new Error(`The assistant did not answer (${res.status}): ${(await res.text()).slice(0, 240)}`);
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let i: number;
    while ((i = buf.indexOf('\n\n')) >= 0) {
      const raw = buf.slice(0, i); buf = buf.slice(i + 2);
      const data = raw.split('\n').filter(l => l.startsWith('data: ')).map(l => l.slice(6)).join('');
      if (!data || data === '[DONE]') continue;
      const ev = JSON.parse(data);
      if (ev.type === 'response.output_text.delta') yield { type: 'text', delta: ev.delta } as ModelEvent;
      else if (ev.type === 'response.output_item.done' && ev.item?.type === 'function_call')
        yield { type: 'call', call_id: ev.item.call_id, name: ev.item.name, arguments: ev.item.arguments || '{}' } as ModelEvent;
      else if (ev.type === 'response.completed') yield { type: 'done', items: ev.response?.output || [] } as ModelEvent;
      else if (ev.type === 'response.failed' || ev.type === 'error') throw new Error(ev.response?.error?.message || ev.message || 'The assistant failed');
    }
  }
};

// who is asking, from their own session: role, clinical, their doctor, the clinic's clock
export async function whoIs(db: DB, tenantId: string, lang: 'ar' | 'en', page?: Page): Promise<Who | null> {
  const [{ data: list }, { data: name }] = await Promise.all([db.rpc('my_tenants'), db.rpc('my_name', { p_tenant: tenantId })]);
  const t = ((list || []) as TenantSummary[]).find(x => x.id === tenantId);
  if (!t) return null;
  return { tenant: t.id, role: t.role, clinical: t.clinical, doctor_id: t.doctor_id, name: String(name || ''), lang, timezone: t.timezone,
           clinic: lang === 'en' ? t.name_en || t.name_ar : t.name_ar, page };
}

export const todayIn = (tz: string) => {
  const d = new Date();
  const day = new Intl.DateTimeFormat('en-CA', { timeZone: tz }).format(d);
  const time = new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: '2-digit', minute: '2-digit', hour12: false }).format(d);
  const wd = new Intl.DateTimeFormat('en', { timeZone: tz, weekday: 'long' }).format(d);
  return `${wd} ${day}, ${time}`;
};
