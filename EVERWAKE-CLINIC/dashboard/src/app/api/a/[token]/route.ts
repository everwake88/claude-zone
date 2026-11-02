import { NextResponse, type NextRequest } from 'next/server';
import { pingOutbox } from '@/lib/outbox';
import { adminClient } from '@/lib/supabase/server';

export const dynamic = 'force-dynamic';

// The patient's own page, no sign-in: the token in the link is the key, and the database functions
// (manage_view · manage_slots · manage_action) check it and the clinic's cancellation policy.
export async function GET(req: NextRequest, { params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  if (!/^[a-f0-9]{32,128}$/i.test(token)) return NextResponse.json({ error: 'NOT_FOUND' }, { status: 404 });
  const from = req.nextUrl.searchParams.get('from');
  const { data, error } = await adminClient().rpc('manage_slots', { p_token: token, p_from: from || null });
  if (error) return NextResponse.json({ error: error.message }, { status: 400 });
  return NextResponse.json(data);
}

export async function POST(req: NextRequest, { params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  if (!/^[a-f0-9]{32,128}$/i.test(token)) return NextResponse.json({ error: 'NOT_FOUND' }, { status: 404 });
  const body = await req.json().catch(() => ({})) as { action?: string; starts_at?: string; date?: string; kind?: string; location_id?: string; reason?: string };
  if (!['confirm', 'cancel', 'move'].includes(body.action || '')) return NextResponse.json({ error: 'UNKNOWN_ACTION' }, { status: 400 });
  const { data, error } = await adminClient().rpc('manage_action', { p_token: token, p_action: body.action, p: body });
  if (error) return NextResponse.json({ error: error.message }, { status: 400 });
  const r = data as { ok: boolean; error?: string };
  if (r.ok) pingOutbox().catch(() => null);
  return NextResponse.json(r, { status: r.ok ? 200 : 409 });
}
