import { NextResponse, type NextRequest } from 'next/server';
import { adminClient } from '@/lib/supabase/server';

export const dynamic = 'force-dynamic';
export const maxDuration = 120;

// Every hour n8n calls this (header x-everwake-secret = N8N_OUTBOX_SECRET): the audio of visits past
// the clinic's days is deleted from storage, then marked. The transcript and the signed note stay.
export async function POST(req: NextRequest) {
  const secret = process.env.N8N_OUTBOX_SECRET;
  if (!secret || req.headers.get('x-everwake-secret') !== secret) return NextResponse.json({ ok: false }, { status: 401 });
  const db = adminClient();
  const { data, error } = await db.rpc('recordings_to_purge', { p_limit: 200 });
  if (error) return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
  const due = (data || []) as { id: number; paths: string[] | null }[];
  const done: number[] = [];
  for (const r of due) {
    const paths = (r.paths || []).filter(Boolean);
    if (paths.length) {
      const { error: e } = await db.storage.from('clinic-recordings').remove(paths);
      if (e) continue;                          // tried again next hour
    }
    done.push(r.id);
  }
  if (done.length) await db.rpc('recordings_purged', { p_ids: done });
  return NextResponse.json({ ok: true, deleted: done.length, left: due.length - done.length });
}
