import { NextResponse } from 'next/server';
import { publicBase } from '@/lib/driver-server';
import { pingOutbox } from '@/lib/outbox';
import { adminClient } from '@/lib/supabase/server';

// "Send me my link": the restaurant(s) this number drives for send a sign-in
// link to it on WhatsApp. The answer is the same whether the number is known.
export async function POST(req: Request) {
  const { phone } = await req.json().catch(() => ({ phone: '' }));
  if (typeof phone !== 'string' || phone.replace(/\D/g, '').length < 8) {
    return NextResponse.json({ error: 'Type your WhatsApp number' }, { status: 400 });
  }
  const { data, error } = await adminClient().rpc('driver_request_login', { p_phone: phone, p_base: publicBase(req) });
  if (error) return NextResponse.json({ error: error.message }, { status: 400 });
  if ((data as number) > 0) await pingOutbox();
  return NextResponse.json({ ok: true });
}
