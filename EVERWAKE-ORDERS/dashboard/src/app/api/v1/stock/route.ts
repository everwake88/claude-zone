import type { NextRequest } from 'next/server';
import { apiError, apiReply, apiTenant } from '@/lib/api-key';
import { adminClient } from '@/lib/supabase/server';

export const dynamic = 'force-dynamic';

interface Change { item_code?: string; available?: boolean; branch_code?: string; until?: string }

// POST /api/v1/stock  {"item_code": "KOFTA", "available": false, "branch_code": "zamalek", "until": "…"}
// or {"items": [ … ]} for several at once. The agent and the QR menu stop
// offering it at once; "until" brings it back by itself.
export async function POST(req: NextRequest) {
  const auth = await apiTenant(req);
  if ('error' in auth) return auth.error;
  const body = await req.json().catch(() => null) as (Change & { items?: Change[] }) | null;
  const list = Array.isArray(body?.items) ? body.items : body ? [body] : [];
  if (!list.length || list.length > 200 || list.some(c => !c.item_code || typeof c.available !== 'boolean'))
    return apiError(400, 'BAD_BODY', 'Each change needs item_code and available (true or false); at most 200 at once.');
  const db = adminClient();
  const results = [];
  for (const c of list) {
    const { data, error } = await db.rpc('api_set_stock', { p_tenant: auth.tenant, p: c });
    results.push(error ? { item_code: c.item_code, ok: false, error: error.message } : { item_code: c.item_code, ...(data as object) });
  }
  return list.length === 1 ? apiReply(results[0]) : apiReply({ ok: results.every(r => (r as { ok?: boolean }).ok), results });
}
