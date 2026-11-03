import { NextResponse, type NextRequest } from 'next/server';
import { hasKey, speak } from '@/lib/ai';
import { serverClient } from '@/lib/supabase/server';

export const dynamic = 'force-dynamic';

// "read replies aloud": the reply as speech
export async function POST(req: NextRequest) {
  if (!hasKey()) return NextResponse.json({ error: 'NEEDS_OPENAI_KEY' }, { status: 503 });
  const db = await serverClient();
  const { data: { user } } = await db.auth.getUser();
  if (!user) return NextResponse.json({ error: 'Sign in again' }, { status: 401 });
  const { text } = await req.json().catch(() => ({})) as { text?: string };
  if (!text?.trim()) return NextResponse.json({ error: 'EMPTY' }, { status: 400 });
  try {
    const audio = await speak(text);
    return new Response(audio, { headers: { 'content-type': 'audio/mpeg', 'cache-control': 'no-store' } });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 502 });
  }
}
