import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { QrMenu, type QrMenuData } from '@/components/qr/QrMenu';
import { adminClient } from '@/lib/supabase/server';

export const dynamic = 'force-dynamic';

async function load(code: string) {
  if (!/^[0-9a-f]{6,20}$/.test(code)) return null;
  const { data } = await adminClient().rpc('qr_menu', { p_code: code });
  const m = data as QrMenuData | null;
  return m?.ok ? m : null;
}

export async function generateMetadata({ params }: { params: Promise<{ code: string }> }): Promise<Metadata> {
  const m = await load((await params).code);
  return { title: m ? `${m.restaurant.name_ar} · ${m.branch.name_ar}` : 'Menu', robots: { index: false } };
}

// A QR code in the branch: its menu, to order and pay from the table or the counter
export default async function QrPage({ params }: { params: Promise<{ code: string }> }) {
  const { code } = await params;
  const m = await load(code);
  if (!m) notFound();
  return <QrMenu data={m} code={code} />;
}
