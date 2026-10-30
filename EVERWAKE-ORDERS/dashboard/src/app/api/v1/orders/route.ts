import type { NextRequest } from 'next/server';
import { apiError, apiReply, apiTenant } from '@/lib/api-key';
import { adminClient } from '@/lib/supabase/server';

export const dynamic = 'force-dynamic';

// GET /api/v1/orders?since=<the "until" of the last answer>&limit=100
// For a system that cannot receive webhooks: every order that changed since
// then, oldest first. Ask again with the "until" it returns.
export async function GET(req: NextRequest) {
  const auth = await apiTenant(req);
  if ('error' in auth) return auth.error;
  const since = req.nextUrl.searchParams.get('since');
  if (since && Number.isNaN(Date.parse(since))) return apiError(400, 'BAD_SINCE', 'since must be a date and time, e.g. 2026-10-30T12:00:00Z');
  const { data, error } = await adminClient().rpc('api_orders', {
    p_tenant: auth.tenant, p_since: since || null, p_limit: Number(req.nextUrl.searchParams.get('limit')) || 100 });
  if (error) return apiError(500, 'FAILED', error.message);
  return apiReply({ ok: true, ...(data as object) });
}
