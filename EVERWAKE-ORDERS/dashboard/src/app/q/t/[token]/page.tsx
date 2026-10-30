import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { QrWaiting, type QrStatus } from '@/components/qr/QrWaiting';
import { adminClient } from '@/lib/supabase/server';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = { title: 'طلبك', robots: { index: false } };

// The customer's waiting page (Paymob comes back here after a card payment)
export default async function QrWaitingPage({ params, searchParams }:
  { params: Promise<{ token: string }>; searchParams: Promise<Record<string, string | undefined>> }) {
  const { token } = await params;
  const q = await searchParams;
  if (!/^[0-9a-f]{64}$/.test(token)) notFound();
  const { data } = await adminClient().rpc('qr_status', { p_token: token });
  const s = data as QrStatus | null;
  if (!s?.ok) notFound();
  // Paymob says on the way back whether the card went through
  const payFailed = q.pay === 'failed' || q.success === 'false';
  return <QrWaiting token={token} initial={s} payFailed={payFailed} />;
}
