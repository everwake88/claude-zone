import { NextResponse } from 'next/server';
import { pingOutbox } from '@/lib/outbox';
import { serverClient } from '@/lib/supabase/server';

// The dashboard queued a reply, a status message or "we're back": send it now.
export async function POST() {
  const db = await serverClient();
  const { data: { user } } = await db.auth.getUser();
  if (!user) return NextResponse.json({ ok: false }, { status: 401 });
  return NextResponse.json(await pingOutbox());
}
