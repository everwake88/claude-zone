import { NextResponse, type NextRequest } from 'next/server';
import { createIntention, type Prepared } from '@/lib/paymob';
import { priceCart, type CartRequestLine, type PricingContext } from '@/lib/qr-pricing';
import { adminClient } from '@/lib/supabase/server';

export const dynamic = 'force-dynamic';

// A customer at the branch sends their cart from the QR menu. The server
// prices it from the branch's menu (never the browser's numbers), keeps it
// waiting for its money, and — paying by card — makes the Paymob checkout.
// Cash: the customer shows their ticket at the counter; the cashier's
// "paid" tap sends it to the kitchen. With "quote", it only prices the cart,
// so the cart shows the offers, VAT and total the customer will really pay.
export async function POST(req: NextRequest, { params }: { params: Promise<{ code: string }> }) {
  const { code } = await params;
  if (!/^[0-9a-f]{6,20}$/.test(code)) return NextResponse.json({ ok: false, error: 'NOT_FOUND' }, { status: 404 });
  const body = await req.json().catch(() => ({})) as {
    items?: CartRequestLine[]; method?: 'card' | 'cash'; name?: string; phone?: string; notes?: string; quote?: boolean };
  const admin = adminClient();
  const { data: ctxData, error } = await admin.rpc('qr_pricing_context', { p_code: code, p_phone: body.phone || null });
  const ctx = ctxData as PricingContext | null;
  if (error || !ctx?.ok) return NextResponse.json({ ok: false, error: ctx?.error || 'NOT_FOUND' }, { status: 404 });

  const priced = priceCart(ctx, (body.items || []).slice(0, 40));
  if (!priced.ok) return NextResponse.json({ ok: false, error: priced.error, detail: priced.detail }, { status: body.quote ? 200 : 400 });
  if (body.quote) return NextResponse.json({
    ok: true, subtotal: priced.subtotal, discount_total: priced.discount_total, vat: priced.vat, total: priced.total,
    offers: priced.applied_offers, gifts: priced.lines.filter(l => l.gift).map(l => ({ name: l.item_name, quantity: l.quantity, unit: l.unit })) });

  const { data: made, error: e2 } = await admin.rpc('qr_checkout_create', { p: {
    code, cart: { items: priced.lines }, payment_method: body.method === 'card' ? 'card' : 'cash',
    totals: { subtotal: priced.subtotal, discount_total: priced.discount_total, applied_offers: priced.applied_offers,
              vat: priced.vat, total: priced.total },
    customer: { full_name: (body.name || '').slice(0, 60), phone: (body.phone || '').slice(0, 20) },
    notes: (body.notes || '').slice(0, 300) } });
  const c = made as { ok: boolean; error?: string; token?: string; ticket?: number; total?: number; hours?: string } | null;
  if (e2 || !c?.ok) return NextResponse.json({ ok: false, error: c?.error || e2?.message, hours: c?.hours }, { status: 400 });
  if (body.method !== 'card') return NextResponse.json({ ok: true, token: c.token, ticket: c.ticket, total: c.total });

  // by card: Paymob's checkout, coming back to the waiting page
  const { data: prep } = await admin.rpc('qr_payment_prepare', { p_token: c.token });
  const p = prep as Prepared | null;
  if (!p?.ok) return NextResponse.json({ ok: true, token: c.token, pay_error: p?.error || 'NOT_CONNECTED' });
  try {
    const link = await createIntention(p);
    await admin.rpc('qr_payment_saved', { p_payment: p.payment_id, p_link: link.url, p_intention: link.id, p_provider_order: link.orderId });
    return NextResponse.json({ ok: true, token: c.token, pay_url: link.url });
  } catch (e) {
    await admin.rpc('payment_link_failed', { p_payment: p.payment_id, p_error: e instanceof Error ? e.message : String(e) });
    return NextResponse.json({ ok: true, token: c.token, pay_error: 'LINK_FAILED' });
  }
}
