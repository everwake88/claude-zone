import { NextResponse } from 'next/server';
import { pingOutbox } from '@/lib/outbox';
import { factsFromPost, postReader, signatureOk } from '@/lib/paymob';
import { adminClient } from '@/lib/supabase/server';

export const dynamic = 'force-dynamic';

// Paymob's notice for every payment (the notification_url of each link):
// checked against the restaurant's HMAC secret, then recorded. A paid order
// is told to the customer and the branch from the database.
export async function POST(req: Request, { params }: { params: Promise<{ tenant: string }> }) {
  const { tenant } = await params;
  if (!/^[0-9a-f-]{36}$/i.test(tenant)) return NextResponse.json({ ok: false }, { status: 404 });
  const body = await req.json().catch(() => null) as { type?: string; obj?: Record<string, unknown> } | null;
  // card tokens and other notices: nothing to do
  if (!body?.obj || body.type !== 'TRANSACTION') return NextResponse.json({ ok: true, ignored: true });

  const admin = adminClient();
  const { data: secret } = await admin.rpc('payment_hmac_secret', { p_tenant: tenant });
  if (!signatureOk(postReader(body.obj), new URL(req.url).searchParams.get('hmac'), (secret as string | null) ?? null)) {
    return NextResponse.json({ ok: false, error: 'bad signature' }, { status: 401 });
  }
  const { data, error } = await admin.rpc('payment_callback', { p_tenant: tenant, p: factsFromPost(body.obj) });
  if (error) return NextResponse.json({ ok: false }, { status: 500 });      // Paymob tries again
  if ((data as { queued?: boolean } | null)?.queued) await pingOutbox();
  return NextResponse.json({ ok: true });
}
