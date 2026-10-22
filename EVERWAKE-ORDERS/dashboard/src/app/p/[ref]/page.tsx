import { notFound, redirect } from 'next/navigation';
import { PayResult, type PublicPayment } from '@/components/pay/PayResult';
import { adminClient } from '@/lib/supabase/server';

export const dynamic = 'force-dynamic';

// The short payment link the customer gets on WhatsApp. While it is open it
// goes straight to Paymob's checkout; after that it says what happened.
export default async function PayLink({ params }: { params: Promise<{ ref: string }> }) {
  const { ref } = await params;
  if (!/^[0-9a-f]{12}$/.test(ref)) notFound();
  const { data } = await adminClient().rpc('payment_public', { p_ref: ref });
  const p = data as PublicPayment | null;
  if (!p) notFound();
  if (p.order_paid) return <PayResult p={p} state="paid" />;
  if (p.status === 'pending' && !p.expired && p.link_url) redirect(p.link_url);
  return <PayResult p={p} state={p.status === 'expired' || p.expired ? 'expired' : 'closed'} />;
}
