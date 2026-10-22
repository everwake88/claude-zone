import { NextResponse } from 'next/server';
import { pingOutbox } from '@/lib/outbox';
import { createIntention, type Prepared } from '@/lib/paymob';
import { adminClient, serverClient } from '@/lib/supabase/server';

export const dynamic = 'force-dynamic';

// A payment link for one order. Called by n8n right after the agent places an
// order the customer pays online (header x-everwake-secret — the agent puts
// the link in its reply), or from the order board by a team member, who may
// set the amount; then the link goes to the customer on WhatsApp from here.
// { test: true } from Settings → Payments makes a small link with no order.
export async function POST(req: Request) {
  const body = await req.json().catch(() => ({})) as { tenant_id?: string; order_no?: string; order_id?: number; amount?: number | string; test?: boolean };
  const admin = adminClient();
  let tenantId: string, orderNo: string | null, amount: number | null = null, by: string | null = null, send = false;

  const secret = process.env.N8N_OUTBOX_SECRET;
  if (secret && req.headers.get('x-everwake-secret') === secret) {
    if (!body.tenant_id || !body.order_no) return NextResponse.json({ ok: false, status: 'BAD_REQUEST' }, { status: 400 });
    tenantId = body.tenant_id; orderNo = body.order_no;
  } else {
    const db = await serverClient();
    const { data: { user } } = await db.auth.getUser();
    if (!user) return NextResponse.json({ ok: false, status: 'SIGNED_OUT' }, { status: 401 });
    const { data, error } = await db.rpc('payment_authorize', body.test ? { p_tenant: body.tenant_id } : { p_order: body.order_id });
    if (error || !data) return NextResponse.json({ ok: false, status: 'NOT_ALLOWED', error: error?.message }, { status: 403 });
    const who = data as { tenant_id: string; order_no?: string };
    tenantId = who.tenant_id; orderNo = body.test ? null : who.order_no || null; by = user.id; send = !body.test;
    const a = Number(body.amount);
    amount = body.amount != null && body.amount !== '' && Number.isFinite(a) ? a : body.test ? 10 : null;
  }

  const { data: prepared, error } = await admin.rpc('payment_prepare', { p_tenant: tenantId, p_order_no: orderNo, p_amount: amount, p_by: by });
  if (error) return NextResponse.json({ ok: false, status: 'ERROR', error: error.message }, { status: 500 });
  const p = prepared as Prepared;
  if (!p.ok) return NextResponse.json({ ok: false, status: p.error, reason: p.reason, fact: p.fact });

  try {
    const link = await createIntention(p);
    if (p.test) return NextResponse.json({ ok: true, status: 'TEST_LINK', link: link.url });
    const { data: saved, error: e2 } = await admin.rpc('payment_link_saved', {
      p_payment: p.payment_id, p_link: link.url, p_intention: link.id, p_provider_order: link.orderId, p_send: send });
    if (e2) throw new Error(e2.message);
    if (send) await pingOutbox();
    return NextResponse.json(saved);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (!p.test && p.payment_id) await admin.rpc('payment_link_failed', { p_payment: p.payment_id, p_error: msg });
    return NextResponse.json({ ok: false, status: 'LINK_FAILED', error: msg,
      fact: 'Paymob could not make the payment link right now. The order is placed; the team was told and can send the link from the order board, or the customer can pay cash.' });
  }
}
