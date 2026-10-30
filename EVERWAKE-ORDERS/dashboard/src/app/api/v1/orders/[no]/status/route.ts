import type { NextRequest } from 'next/server';
import { apiError, apiReply, apiTenant } from '@/lib/api-key';
import { adminClient } from '@/lib/supabase/server';

export const dynamic = 'force-dynamic';

const STATUSES = ['accepted', 'preparing', 'ready', 'out_for_delivery', 'delivered', 'picked_up', 'rejected', 'cancelled'];

// POST /api/v1/orders/SG-1042/status  {"status": "ready", "note": "…"}
// The POS moves the order: the board updates, and the customer gets the same
// WhatsApp message (or their QR page rings) as when the team moves it here.
export async function POST(req: NextRequest, { params }: { params: Promise<{ no: string }> }) {
  const auth = await apiTenant(req);
  if ('error' in auth) return auth.error;
  const { no } = await params;
  const body = await req.json().catch(() => null) as { status?: string; note?: string } | null;
  if (!body?.status || !STATUSES.includes(body.status)) return apiError(400, 'BAD_STATUS', `status is one of: ${STATUSES.join(', ')}`);
  const { data, error } = await adminClient().rpc('api_set_order_status', {
    p_tenant: auth.tenant, p_order_no: decodeURIComponent(no), p_status: body.status, p_note: body.note ? String(body.note).slice(0, 300) : null });
  if (error) return apiError(422, 'NOT_ALLOWED', error.message);
  return apiReply(data);
}
