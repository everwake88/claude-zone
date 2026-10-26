import { NextResponse, type NextRequest } from 'next/server';
import { adminClient, serverClient } from '@/lib/supabase/server';

export const dynamic = 'force-dynamic';

interface Answered { tenant_id: string; wa_id: string; conversation_id: number; mode: 'agent' | 'human' }

// The team answers a question the agent asked (Yes / No / typed), or
// closes it. The answer is saved with the member's own client (their role
// is checked there); then the agent is woken through the restaurant's own
// WhatsApp webhook so it tells the customer at once. The channel's token
// is read with the service role only after that check.
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { kind, answer, dismiss } = await req.json().catch(() => ({})) as { kind?: string; answer?: string; dismiss?: boolean };
  const db = await serverClient();
  const { data: { user } } = await db.auth.getUser();
  if (!user) return NextResponse.json({ error: 'Sign in again' }, { status: 401 });

  if (dismiss) {
    const { error } = await db.rpc('dismiss_team_question', { p_question: Number(id) });
    if (error) return NextResponse.json({ error: error.message }, { status: 400 });
    return NextResponse.json({ ok: true });
  }

  const { data, error } = await db.rpc('answer_team_question', { p_question: Number(id), p_kind: kind || '', p_answer: answer || null });
  if (error) return NextResponse.json({ error: error.message }, { status: 400 });
  const a = data as Answered;
  // a person has the chat: they tell the customer themselves
  if (a.mode !== 'agent') return NextResponse.json({ ok: true, woke: false, reason: 'taken_over' });
  return NextResponse.json({ ok: true, ...(await wakeAgent(a)) });
}

async function wakeAgent(a: Answered): Promise<{ woke: boolean; reason?: string }> {
  const n8n = (process.env.N8N_BASE_URL || '').replace(/\/+$/, '');
  if (!n8n) return { woke: false, reason: 'N8N_BASE_URL is not set — the agent passes the answer on with the customer\'s next message' };
  const admin = adminClient();
  const { data: conv } = await admin.from('conversations').select('state').eq('id', a.conversation_id).single();
  const channelId = (conv as { state?: { contact?: { channel_id?: string } } } | null)?.state?.contact?.channel_id;
  let q = admin.from('whatsapp_channels').select('instance_name, webhook_token').eq('tenant_id', a.tenant_id).eq('is_active', true);
  if (channelId) q = q.eq('id', channelId);
  const { data: ch } = await q.limit(1).maybeSingle();
  const channel = ch as { instance_name: string; webhook_token: string } | null;
  if (!channel?.instance_name) return { woke: false, reason: 'no WhatsApp number is connected' };
  try {
    const res = await fetch(`${n8n}/webhook/everwake-evo?token=${encodeURIComponent(channel.webhook_token)}`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ event: 'everwake.team_answer', instance: channel.instance_name, data: { wa_id: a.wa_id } }),
      signal: AbortSignal.timeout(8000)
    });
    return res.ok ? { woke: true } : { woke: false, reason: `n8n answered ${res.status}` };
  } catch {
    return { woke: false, reason: 'n8n did not answer — the agent passes the answer on with the customer\'s next message' };
  }
}
