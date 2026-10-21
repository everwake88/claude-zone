import 'server-only';
import { cookies } from 'next/headers';
import { NextResponse } from 'next/server';
import { pingOutbox } from './outbox';
import { adminClient } from './supabase/server';

// A driver's phone is signed in by an httpOnly cookie holding its session
// token. Drivers are not dashboard users: every call goes through the
// driver_* database functions with the service role, and those functions
// check the token and that the order is the driver's own.
export const DRIVER_COOKIE = 'ew_driver';
export const DRIVER_COOKIE_DAYS = 180;

export async function driverCall(fn: string, args: Record<string, unknown> = {}, opts: { ping?: (data: unknown) => boolean } = {}) {
  const token = (await cookies()).get(DRIVER_COOKIE)?.value;
  if (!token) return NextResponse.json({ error: 'signed_out' }, { status: 401 });
  const { data, error } = await adminClient().rpc(fn, { p_token: token, ...args });
  if (error) {
    if (error.code === '28000') return NextResponse.json({ error: 'signed_out' }, { status: 401 });
    return NextResponse.json({ error: error.message }, { status: 400 });
  }
  // a customer message was queued: send it now
  if (opts.ping?.(data)) await pingOutbox();
  return NextResponse.json(data ?? null);
}

export const publicBase = (req: Request) => process.env.NEXT_PUBLIC_SITE_URL || new URL(req.url).origin;
