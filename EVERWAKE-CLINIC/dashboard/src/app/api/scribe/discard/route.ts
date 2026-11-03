import { NextResponse, type NextRequest } from 'next/server';
import { serverClient } from '@/lib/supabase/server';

export const dynamic = 'force-dynamic';

// start over: the recording is set aside (never once it is signed)
export async function POST(req: NextRequest) {
  const { recording_id } = await req.json().catch(() => ({})) as { recording_id?: number };
  const db = await serverClient();
  const { data, error } = await db.rpc('recording_discard', { p_rec: Number(recording_id) });
  if (error) return NextResponse.json({ ok: false, error: error.message }, { status: 403 });
  return NextResponse.json(data);
}
