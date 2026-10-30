import type { NextRequest } from 'next/server';
import { apiError, apiReply, apiTenant } from '@/lib/api-key';
import { adminClient } from '@/lib/supabase/server';

export const dynamic = 'force-dynamic';

// GET /api/v1/menu?branch=zamalek — the item codes, names, prices and stock,
// to map each one to the POS's own item once.
export async function GET(req: NextRequest) {
  const auth = await apiTenant(req);
  if ('error' in auth) return auth.error;
  const { data, error } = await adminClient().rpc('api_menu', { p_tenant: auth.tenant, p_branch_code: req.nextUrl.searchParams.get('branch') || null });
  if (error) return apiError(500, 'FAILED', error.message);
  return apiReply(data);
}
