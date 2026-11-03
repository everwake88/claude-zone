import { NextResponse, type NextRequest } from 'next/server';
import { hasKey } from '@/lib/ai';
import { serverClient } from '@/lib/supabase/server';

export const dynamic = 'force-dynamic';

// Listening starts only with the patient's consent, and only for the clinical team (the database
// checks both). Without an OpenAI key nothing is recorded: the doctor types the note instead.
export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({})) as { appointment_id?: number; consent?: boolean; consent_text?: string };
  if (!hasKey()) return NextResponse.json({ ok: false, error: 'NEEDS_OPENAI_KEY' }, { status: 503 });
  const db = await serverClient();
  const { data: { user } } = await db.auth.getUser();
  if (!user) return NextResponse.json({ ok: false, error: 'Sign in again' }, { status: 401 });
  const { data, error } = await db.rpc('recording_start', { p_appt: Number(body.appointment_id), p: { consent: body.consent === true, consent_text: body.consent_text || null } });
  if (error) return NextResponse.json({ ok: false, error: error.message }, { status: 403 });
  return NextResponse.json(data);
}
