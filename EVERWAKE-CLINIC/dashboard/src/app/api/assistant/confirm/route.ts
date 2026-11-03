import { NextResponse, type NextRequest } from 'next/server';
import { pingOutbox } from '@/lib/outbox';
import { whoIs } from '@/lib/assistant/server';
import { applyProposal } from '@/lib/assistant/tools';
import { serverClient } from '@/lib/supabase/server';

export const dynamic = 'force-dynamic';

// The card's Confirm (or Not now). The change runs with the member's own session, through the same
// functions as the dashboard's buttons; the card keeps what happened.
export async function POST(req: NextRequest) {
  const { action_id, decision, lang } = await req.json().catch(() => ({})) as { action_id?: number; decision?: 'confirm' | 'dismiss'; lang?: 'ar' | 'en' };
  const db = await serverClient();
  const { data } = await db.from('assistant_actions').select('id, tenant_id, tool, params, status').eq('id', Number(action_id)).maybeSingle();
  const a = data as { id: number; tenant_id: string; tool: string; params: Record<string, unknown>; status: string } | null;
  if (!a) return NextResponse.json({ ok: false, error: 'NOT_FOUND' }, { status: 404 });
  if (a.status !== 'proposed') return NextResponse.json({ ok: false, error: 'ALREADY_DECIDED', status: a.status }, { status: 409 });
  if (decision === 'dismiss') {
    await db.from('assistant_actions').update({ status: 'dismissed', decided_at: new Date().toISOString() }).eq('id', a.id);
    return NextResponse.json({ ok: true, status: 'dismissed' });
  }
  const who = await whoIs(db, a.tenant_id, lang === 'en' ? 'en' : 'ar');
  if (!who) return NextResponse.json({ ok: false, error: 'NOT_A_MEMBER' }, { status: 403 });
  let r: { ok: boolean; result: unknown; summary: string };
  try { r = await applyProposal(a.tool, a.params, db, who); }
  catch (e) { r = { ok: false, result: { error: e instanceof Error ? e.message : String(e) }, summary: e instanceof Error ? e.message : String(e) }; }
  await db.from('assistant_actions').update({ status: r.ok ? 'done' : 'failed', result: r.result, decided_at: new Date().toISOString() }).eq('id', a.id);
  if (r.ok && ['announce_delay', 'book', 'reschedule', 'cancel', 'message_patient'].includes(a.tool)) await pingOutbox();
  return NextResponse.json({ ok: r.ok, status: r.ok ? 'done' : 'failed', summary: r.summary });
}
