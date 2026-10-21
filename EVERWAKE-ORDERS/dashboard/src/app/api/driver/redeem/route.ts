import { NextResponse } from 'next/server';
import { DRIVER_COOKIE, DRIVER_COOKIE_DAYS, publicBase } from '@/lib/driver-server';
import { adminClient } from '@/lib/supabase/server';

// The driver pressed "sign in" on their link: the code works once, and this
// phone gets a session cookie for six months.
export async function POST(req: Request) {
  const base = publicBase(req);
  const code = String((await req.formData().catch(() => null))?.get('code') || '');
  const m = /^([0-9a-f-]{36})\.([0-9a-f]{64})$/.exec(code);
  if (!m) return NextResponse.redirect(`${base}/driver/login?link=bad`, 303);
  const { data, error } = await adminClient().rpc('driver_redeem', {
    p_driver: m[1], p_code: m[2], p_user_agent: req.headers.get('user-agent') || null
  });
  const r = data as { ok: boolean; token?: string } | null;
  if (error || !r?.ok || !r.token) return NextResponse.redirect(`${base}/driver/login?link=used`, 303);
  const res = NextResponse.redirect(`${base}/driver`, 303);
  res.cookies.set(DRIVER_COOKIE, r.token, {
    httpOnly: true, secure: base.startsWith('https'), sameSite: 'lax', path: '/', maxAge: DRIVER_COOKIE_DAYS * 86400
  });
  return res;
}
