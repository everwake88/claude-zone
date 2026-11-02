import Link from 'next/link';
import { redirect } from 'next/navigation';
import { configured } from '@/lib/env';
import { serverT } from '@/lib/i18n-server';
import { serverClient } from '@/lib/supabase/server';
import type { TenantSummary } from '@/lib/types';

export const dynamic = 'force-dynamic';

// Signed in → join any clinics this e-mail was invited to, then open the clinic (or let the
// member pick one, or sign a clinic up).
export default async function Home() {
  if (!configured) {
    return (
      <main className="mx-auto max-w-xl p-10">
        <h1 className="text-2xl font-semibold">Everwake Clinic is not configured yet</h1>
        <p className="mt-3 text-muted">Copy <code>.env.example</code> to <code>.env.local</code> and fill in the Supabase values.
          The setup guide is in <code>EVERWAKE-CLINIC/docs/SETUP.md</code>.</p>
      </main>
    );
  }
  const t = await serverT();
  const db = await serverClient();
  await db.rpc('accept_invites');
  const { data } = await db.rpc('my_tenants');
  const tenants = (data || []) as TenantSummary[];
  if (tenants.length === 0) redirect('/new');
  if (tenants.length === 1) redirect(`/c/${tenants[0].slug}`);
  return (
    <main className="mx-auto max-w-xl p-6 sm:p-10">
      <h1 className="text-[22px] font-semibold">{t('Your clinics')}</h1>
      <div className="sheet mt-5 divide-y divide-rule overflow-hidden">
        {tenants.map(c => (
          <Link key={c.id} href={`/c/${c.slug}`} className="flex items-center justify-between gap-4 px-5 py-4 hover:bg-raised">
            <span className="min-w-0">
              <span className="block truncate font-medium">{c.name_ar}</span>
              <span className="block truncate text-sm text-muted" dir="ltr">{c.name_en}</span>
            </span>
            <span className="shrink-0 text-sm text-muted">{t(c.role)}</span>
          </Link>
        ))}
        <Link href="/new" className="block px-5 py-3.5 text-sm font-medium text-gold-ink hover:bg-raised">+ {t('Sign up another clinic')}</Link>
      </div>
    </main>
  );
}
