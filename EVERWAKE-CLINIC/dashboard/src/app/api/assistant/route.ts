import { type NextRequest } from 'next/server';
import { sse } from '@/lib/ai';
import { runTurn, pageOf, type Turn } from '@/lib/assistant/loop';
import { openaiModel, todayIn, whoIs } from '@/lib/assistant/server';
import { instructions, toolsFor } from '@/lib/assistant/tools';
import { serverClient } from '@/lib/supabase/server';

export const dynamic = 'force-dynamic';
export const maxDuration = 180;

// A message to the assistant, answered as a stream: words, tool chips, confirm cards, and what goes
// into the open visit. The thread, the messages and the cards are the member's own rows.
export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({})) as { tenant_id?: string; thread_id?: number | null; text?: string; path?: string; lang?: 'ar' | 'en' };
  const text = String(body.text || '').trim().slice(0, 4000);
  const db = await serverClient();
  return sse(async (send) => {
    const { data: { user } } = await db.auth.getUser();
    if (!user) throw new Error('Sign in again');
    if (!text) throw new Error('EMPTY');
    const page = pageOf(body.path || '');
    const who = await whoIs(db, String(body.tenant_id || ''), body.lang === 'en' ? 'en' : 'ar', page);
    if (!who) throw new Error('NOT_A_MEMBER');
    // the visit's patient, so "this patient" works there too
    if (page.kind === 'visit' && page.appointment_id) {
      const { data } = await db.from('appointments').select('patient_id').eq('id', page.appointment_id).maybeSingle();
      if (data) page.patient_id = (data as { patient_id: number }).patient_id;
    }
    let thread = Number(body.thread_id) || null;
    if (!thread) {
      const { data, error } = await db.from('assistant_threads').insert({ tenant_id: who.tenant, user_id: user.id, title: text.slice(0, 80) }).select('id').single();
      if (error) throw new Error(error.message);
      thread = (data as { id: number }).id;
    }
    send('thread', { id: thread });
    await db.from('assistant_messages').insert({ tenant_id: who.tenant, thread_id: thread, user_id: user.id, role: 'user', content: text, context: page });
    const { data: past } = await db.from('assistant_messages').select('role, content').eq('thread_id', thread).order('id', { ascending: false }).limit(16);
    const history = ((past || []) as Turn[]).reverse().filter(m => m.content);
    const r = await runTurn({
      model: openaiModel, tools: toolsFor(who), who, db, history, instructions: instructions(who, todayIn(who.timezone)),
      emit: (e, d) => send(e, d),
      propose: async (p) => {
        const { data, error } = await db.from('assistant_actions').insert({ tenant_id: who.tenant, thread_id: thread, user_id: user.id,
          tool: p.tool, params: p.params, preview: p.preview, summary: p.summary }).select('id').single();
        if (error) throw new Error(error.message);
        return (data as { id: number }).id;
      }
    });
    const { data: m } = await db.from('assistant_messages').insert({ tenant_id: who.tenant, thread_id: thread, user_id: user.id, role: 'assistant',
      content: r.text, parts: r.parts, context: page }).select('id').single();
    await db.from('assistant_threads').update({ updated_at: new Date().toISOString() }).eq('id', thread);
    send('done', { thread_id: thread, message_id: (m as { id: number } | null)?.id ?? null });
  });
}
