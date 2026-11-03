import { NextResponse, type NextRequest } from 'next/server';
import { MODELS, hasKey, transcribe } from '@/lib/ai';
import { serverClient } from '@/lib/supabase/server';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

// push-to-talk: the held mic's words, then the sheet sends them as a message
export async function POST(req: NextRequest) {
  if (!hasKey()) return NextResponse.json({ error: 'NEEDS_OPENAI_KEY' }, { status: 503 });
  const db = await serverClient();
  const { data: { user } } = await db.auth.getUser();
  if (!user) return NextResponse.json({ error: 'Sign in again' }, { status: 401 });
  const form = await req.formData().catch(() => null);
  const file = form?.get('file') as File | null;
  if (!file) return NextResponse.json({ error: 'No audio' }, { status: 400 });
  try {
    const r = await transcribe(file, { model: MODELS.assistantTranscribe, prompt: 'A doctor talking to the clinic’s assistant, in Egyptian Arabic or English, with medical terms.', filename: 'talk.webm' });
    return NextResponse.json({ text: r.text.trim() });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 502 });
  }
}
