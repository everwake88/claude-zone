import { NextResponse } from 'next/server';
import { serverClient } from '@/lib/supabase/server';

// Tells n8n to send what the dashboard just queued (a reply, a status
// message, "we're back") right now instead of on its next minute. The
// message is already safe in the outbox; this only makes it faster.
export async function POST() {
  const db = await serverClient();
  const { data: { user } } = await db.auth.getUser();
  if (!user) return NextResponse.json({ ok: false }, { status: 401 });
  const base = process.env.N8N_BASE_URL;
  if (!base) return NextResponse.json({ ok: false, reason: 'N8N_BASE_URL is not set — the outbox sends within a minute' });
  try {
    const res = await fetch(`${base.replace(/\/+$/, '')}/webhook/everwake-outbox`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-everwake-secret': process.env.N8N_OUTBOX_SECRET || '' },
      body: JSON.stringify({ at: new Date().toISOString() }),
      signal: AbortSignal.timeout(4000)
    });
    return NextResponse.json({ ok: res.ok });
  } catch {
    return NextResponse.json({ ok: false, reason: 'n8n did not answer — the outbox sends within a minute' });
  }
}
