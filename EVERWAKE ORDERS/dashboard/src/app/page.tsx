import Link from 'next/link';
import { redirect } from 'next/navigation';
import { configured } from '@/lib/env';
import { serverClient } from '@/lib/supabase/server';
import type { TenantSummary } from '@/lib/types';

export const dynamic = 'force-dynamic';

// Signed in → join any restaurants this e-mail was invited to, then go to
// the restaurant (or let the user pick, or sign one up).
export default async function Home() {
  if (!configured) {
    return (
      <main className="mx-auto max-w-xl p-10">
        <h1 className="text-2xl font-semibold">Everwake Orders is not configured yet</h1>
        <p className="mt-3 text-muted">Copy <code>.env.example</code> to <code>.env.local</code> and fill in the Supabase values.
          The setup guide is in <code>EVERWAKE ORDERS/docs/SETUP.md</code>.</p>
      </main>
    );
  }
  const db = await serverClient();
  await db.rpc('accept_invites');
  const { data } = await db.rpc('my_tenants');
  const tenants = (data || []) as TenantSummary[];
  if (tenants.length === 0) redirect('/new');
  if (tenants.length === 1) redirect(`/r/${tenants[0].slug}`);
  return (
    <main className="mx-auto max-w-2xl p-6 sm:p-10">
      <h1 className="text-2xl font-semibold">Your restaurants</h1>
      <div className="mt-6 grid gap-3">
        {tenants.map(t => (
          <Link key={t.id} href={`/r/${t.slug}`} className="flex items-center justify-between rounded-xl border border-hairline bg-white px-5 py-4 hover:border-gold">
            <span>
              <span className="block font-medium">{t.name_en || t.name_ar}</span>
              <span className="block text-sm text-muted ar" dir="rtl">{t.name_ar}</span>
            </span>
            <span className="text-sm text-muted">{t.role} · {t.status}</span>
          </Link>
        ))}
        <Link href="/new" className="rounded-xl border border-dashed border-hairline px-5 py-4 text-center text-sm text-gold-ink hover:border-gold">
          + Sign up another restaurant
        </Link>
      </div>
    </main>
  );
}
