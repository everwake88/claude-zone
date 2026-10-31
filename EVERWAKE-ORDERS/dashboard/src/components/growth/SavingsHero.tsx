'use client';
import { PiggyBank } from 'lucide-react';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import { useTenant } from '@/components/tenant';
import { day, money } from '@/lib/format';
import { useT } from '@/lib/i18n';
import { sb } from '@/lib/supabase/client';

interface Savings {
  commission_percent: number; today: number; month: number; all_time: number;
  orders_today: number; orders_month: number; orders_all: number; revenue_month: number; since: string | null;
}

// "WhatsApp saved you …": what the same orders would have paid a delivery
// app in commission. The number owners show other owners.
export function SavingsHero() {
  const { tenant, base, can } = useTenant();
  const t = useT();
  const [s, setS] = useState<Savings | null>(null);
  useEffect(() => {
    if (!can.edit) return;
    sb().rpc('savings', { p_tenant: tenant.id }).then(({ data }) => setS(data as Savings));
  }, [tenant.id, can.edit]);
  if (!s) return null;
  const sym = tenant.currency_symbol;
  return (
    <section className="overflow-hidden rounded-2xl bg-navy text-white shadow-sm">
      <div className="flex flex-wrap items-center gap-6 p-5">
        <div className="flex size-14 items-center justify-center rounded-2xl bg-gold text-on-gold"><PiggyBank className="size-7" /></div>
        <div className="min-w-0 flex-1">
          <p className="text-sm text-on-navy-muted">{t('WhatsApp saved you this month')}</p>
          <p className="text-4xl font-bold tracking-tight">{money(s.month, sym)}</p>
          <p className="mt-1 text-xs text-on-navy-muted">
            {t('{n} orders · {p}% commission a delivery app would have taken', { n: s.orders_month, p: s.commission_percent })}{' '}
            <Link href={`${base}/settings/ordering`} className="underline">{t('change')}</Link>
          </p>
        </div>
        <div className="grid grid-cols-2 gap-6 text-sm">
          <div><p className="text-on-navy-muted">{t('Today')}</p><p className="text-xl font-semibold">{money(s.today, sym)}</p></div>
          <div>
            <p className="text-on-navy-muted">{s.since ? t('Since {date}', { date: day(s.since, tenant.timezone) }) : t('So far')}</p>
            <p className="text-xl font-semibold text-gold-bright">{money(s.all_time, sym)}</p>
          </div>
        </div>
      </div>
    </section>
  );
}
