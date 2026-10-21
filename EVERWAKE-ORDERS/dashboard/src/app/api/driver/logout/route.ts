import { cookies } from 'next/headers';
import { NextResponse } from 'next/server';
import { DRIVER_COOKIE } from '@/lib/driver-server';
import { adminClient } from '@/lib/supabase/server';

export async function POST() {
  const store = await cookies();
  const token = store.get(DRIVER_COOKIE)?.value;
  if (token) await adminClient().rpc('driver_logout', { p_token: token });
  store.delete(DRIVER_COOKIE);
  return NextResponse.json({ ok: true });
}
