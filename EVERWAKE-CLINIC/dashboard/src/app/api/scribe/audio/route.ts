import { NextResponse, type NextRequest } from 'next/server';
import { serverClient } from '@/lib/supabase/server';

export const dynamic = 'force-dynamic';

// "Play that moment": a short-lived link to one piece of the visit's audio, for the clinical team
export async function GET(req: NextRequest) {
  const rec = Number(req.nextUrl.searchParams.get('recording_id'));
  const seq = Number(req.nextUrl.searchParams.get('seq'));
  const db = await serverClient();
  const { data } = await db.from('recordings').select('chunks, audio_deleted_at').eq('id', rec).maybeSingle();
  const r = data as { chunks: { seq: number; path?: string }[]; audio_deleted_at: string | null } | null;
  if (!r) return NextResponse.json({ error: 'Recording not found' }, { status: 404 });
  if (r.audio_deleted_at) return NextResponse.json({ error: 'AUDIO_DELETED' }, { status: 410 });
  const path = r.chunks.find(c => c.seq === seq)?.path;
  if (!path) return NextResponse.json({ error: 'That piece has no audio' }, { status: 404 });
  const { data: s, error } = await db.storage.from('clinic-recordings').createSignedUrl(path, 900);
  if (error || !s) return NextResponse.json({ error: error?.message || 'No link' }, { status: 502 });
  return NextResponse.json({ url: s.signedUrl });
}
