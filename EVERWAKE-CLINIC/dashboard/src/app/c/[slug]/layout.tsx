import { notFound } from 'next/navigation';
import type { ReactNode } from 'react';
import { Shell } from '@/components/shell/Shell';
import { TenantProvider } from '@/components/tenant';
import { serverClient } from '@/lib/supabase/server';
import type { Brand, TenantSummary } from '@/lib/types';

export const dynamic = 'force-dynamic';

export default async function ClinicLayout({ children, params }: { children: ReactNode; params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const db = await serverClient();
  // the clinics and this one's logo and colour together, so the frame is right on the first paint
  const [{ data }, { data: row }] = await Promise.all([
    db.rpc('my_tenants'),
    db.from('tenants').select('profile').eq('slug', slug).maybeSingle()
  ]);
  const tenants = (data || []) as TenantSummary[];
  const tenant = tenants.find(t => t.slug === slug);
  if (!tenant) notFound();
  const brand = ((row as { profile?: { brand?: Brand } } | null)?.profile?.brand) || {};
  return (
    <TenantProvider tenant={tenant} tenants={tenants} initialBrand={brand}>
      <Shell>{children}</Shell>
    </TenantProvider>
  );
}
