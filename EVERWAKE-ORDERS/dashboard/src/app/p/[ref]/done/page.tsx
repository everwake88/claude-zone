import { notFound } from 'next/navigation';
import { PayResult, type PayState, type PublicPayment } from '@/components/pay/PayResult';
import { pingOutbox } from '@/lib/outbox';
import { factsFromGet, getReader, signatureOk } from '@/lib/paymob';
import { adminClient } from '@/lib/supabase/server';

export const dynamic = 'force-dynamic';

// Where Paymob sends the customer after paying (the redirection_url). The
// result in the address is signed; a genuine one is recorded straight away
// (the notice to the server records it too — whichever arrives first).
export default async function PayDone({ params, searchParams }:
  { params: Promise<{ ref: string }>; searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const { ref } = await params;
  if (!/^[0-9a-f]{12}$/.test(ref)) notFound();
  const sp = await searchParams;
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(sp)) if (typeof v === 'string') q.set(k, v);

  const admin = adminClient();
  let { data } = await admin.rpc('payment_public', { p_ref: ref });
  let p = data as PublicPayment | null;
  if (!p) notFound();

  let state: PayState = 'checking';
  if (q.has('hmac')) {
    const { data: secret } = await admin.rpc('payment_hmac_secret', { p_tenant: p.tenant_id });
    if (signatureOk(getReader(q), q.get('hmac'), (secret as string | null) ?? null)) {
      const facts = factsFromGet(q);
      // the signed result must be this link's own (by our reference, or Paymob's order number)
      if (facts.merchant_order_id === ref || facts.merchant_order_id === null) {
        const { data: r } = await admin.rpc('payment_callback', { p_tenant: p.tenant_id, p: facts });
        if ((r as { queued?: boolean } | null)?.queued) await pingOutbox();
        ({ data } = await admin.rpc('payment_public', { p_ref: ref }));
        p = (data as PublicPayment | null) || p;
        state = facts.success && !facts.pending ? 'paid' : facts.pending ? 'checking' : 'failed';
      }
    }
  }
  if (p.order_paid) state = 'paid';
  return <PayResult p={p} state={state} />;
}
