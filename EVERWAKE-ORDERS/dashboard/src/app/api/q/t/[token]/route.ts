import { NextResponse, type NextRequest } from 'next/server';
import { adminClient } from '@/lib/supabase/server';

export const dynamic = 'force-dynamic';

// The waiting page asks every few seconds: paid yet? the order number, the
// time, the kitchen's notes, ready? (the token in the address is the key)
export async function GET(_req: NextRequest, { params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  if (!/^[0-9a-f]{64}$/.test(token)) return NextResponse.json({ ok: false, error: 'NOT_FOUND' }, { status: 404 });
  const { data } = await adminClient().rpc('qr_status', { p_token: token });
  return NextResponse.json(data || { ok: false }, { headers: { 'cache-control': 'no-store' } });
}
