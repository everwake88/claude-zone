import 'server-only';
import { NextResponse, type NextRequest } from 'next/server';
import { adminClient } from './supabase/server';

// The restaurant's own system (POS, ERP, CRM) calls with the key made in
// Settings → Your POS and systems: "Authorization: Bearer ew_…". The key
// names the restaurant; nothing else in the call can.
export async function apiTenant(req: NextRequest): Promise<{ tenant: string } | { error: NextResponse }> {
  const key = (req.headers.get('authorization') || '').replace(/^Bearer\s+/i, '').trim();
  if (!/^ew_[0-9a-f]{64}$/.test(key)) return { error: apiError(401, 'MISSING_KEY', 'Send the key as "Authorization: Bearer ew_…".') };
  const { data } = await adminClient().rpc('api_key_tenant', { p_key: key });
  if (!data) return { error: apiError(401, 'BAD_KEY', 'This key is wrong or was revoked.') };
  return { tenant: data as string };
}

export const apiError = (status: number, error: string, message?: string) =>
  NextResponse.json({ ok: false, error, message }, { status, headers: { 'cache-control': 'no-store' } });

// a database answer {ok:false, error} becomes a 4xx with the same body
export function apiReply(data: unknown) {
  const r = (data || { ok: false, error: 'FAILED' }) as { ok?: boolean; error?: string };
  const status = r.ok === false ? (/NOT_FOUND$/.test(r.error || '') ? 404 : 422) : 200;
  return NextResponse.json(r, { status, headers: { 'cache-control': 'no-store' } });
}
