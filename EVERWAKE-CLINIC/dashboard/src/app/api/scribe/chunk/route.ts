import { NextResponse, type NextRequest } from 'next/server';
import { MODELS, hasKey, transcribe } from '@/lib/ai';
import { serverClient } from '@/lib/supabase/server';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

// One 20-second piece of the visit: kept in the clinic's private storage (the member's own client,
// so only the clinical team can), heard, and saved with its words. A piece that could not be heard
// is still kept; Finish hears it again. The browser sends a piece again until this says ok.
export async function POST(req: NextRequest) {
  const form = await req.formData().catch(() => null);
  if (!form) return NextResponse.json({ ok: false, error: 'Send the audio as a form' }, { status: 400 });
  const rec = Number(form.get('recording_id'));
  const seq = Number(form.get('seq'));
  const ms = Math.max(0, Math.round(Number(form.get('ms')) || 0));
  const file = form.get('file') as File | null;
  const hint = String(form.get('hint') || '');
  if (!rec || !Number.isInteger(seq) || seq < 0 || !file) return NextResponse.json({ ok: false, error: 'Missing the recording, the piece or the audio' }, { status: 400 });

  const db = await serverClient();
  const { data: r } = await db.from('recordings').select('id, tenant_id, status').eq('id', rec).maybeSingle();
  const row = r as { id: number; tenant_id: string; status: string } | null;
  if (!row) return NextResponse.json({ ok: false, error: 'Recording not found' }, { status: 404 });
  if (!['recording', 'processing'].includes(row.status)) return NextResponse.json({ ok: false, error: 'RECORDING_CLOSED' }, { status: 409 });

  const ext = (file.type || '').includes('mp4') ? 'm4a' : (file.type || '').includes('ogg') ? 'ogg' : 'webm';
  const path = `${row.tenant_id}/${row.id}/${String(seq).padStart(4, '0')}.${ext}`;
  const up = await db.storage.from('clinic-recordings').upload(path, file, { upsert: true, contentType: file.type || 'audio/webm' });
  if (up.error) return NextResponse.json({ ok: false, error: up.error.message }, { status: 502 });

  let text = '';
  let heard = false;
  if (hasKey() && ms > 600) {
    try { text = (await transcribe(file, { model: MODELS.scribeTranscribe, prompt: hint, filename: `piece.${ext}` })).text.trim(); heard = true; }
    catch { /* kept; heard again at Finish */ }
  }
  const { error } = await db.rpc('recording_chunk', { p_rec: row.id, p: { seq, path, ms, text } });
  if (error) return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true, seq, text, heard });
}
