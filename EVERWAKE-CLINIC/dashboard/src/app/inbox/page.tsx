import { redirect } from 'next/navigation';
import { serverClient } from '@/lib/supabase/server';
import type { TenantSummary } from '@/lib/types';

export const dynamic = 'force-dynamic';

// the link in the doctor's WhatsApp alert (…/inbox?c=12) opens that chat in their clinic
export default async function InboxLink({ searchParams }: { searchParams: Promise<{ c?: string }> }) {
  const { c } = await searchParams;
  const db = await serverClient();
  const { data } = await db.rpc('my_tenants');
  const tenants = (data || []) as TenantSummary[];
  if (!tenants.length) redirect('/');
  let slug = tenants[0].slug;
  if (c && tenants.length > 1) {
    const { data: conv } = await db.from('conversations').select('tenant_id').eq('id', Number(c)).maybeSingle();
    slug = tenants.find(x => x.id === (conv as { tenant_id?: string } | null)?.tenant_id)?.slug || slug;
  }
  redirect(`/c/${slug}/inbox${c ? `?c=${encodeURIComponent(c)}` : ''}`);
}
