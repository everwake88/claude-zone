import { notFound } from 'next/navigation';
import type { ReactNode } from 'react';
import { Shell } from '@/components/shell/Shell';
import { TenantProvider } from '@/components/tenant';
import { serverClient } from '@/lib/supabase/server';
import type { TenantSummary } from '@/lib/types';

export const dynamic = 'force-dynamic';

export default async function RestaurantLayout({ children, params }: { children: ReactNode; params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const db = await serverClient();
  const { data } = await db.rpc('my_tenants');
  const tenants = (data || []) as TenantSummary[];
  const tenant = tenants.find(t => t.slug === slug);
  if (!tenant) notFound();
  return (
    <TenantProvider tenant={tenant} tenants={tenants}>
      <Shell>{children}</Shell>
    </TenantProvider>
  );
}
