'use client';
import { MessageCircle } from 'lucide-react';
import dynamic from 'next/dynamic';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import { BarList, ChartCard, ColumnChart, Stat, type Point } from '@/components/charts/Charts';
import { Card, Spinner } from '@/components/ui';
import { useTenant } from '@/components/tenant';
import { money, timeAgo } from '@/lib/format';
import { useT } from '@/lib/i18n';
import { sb } from '@/lib/supabase/client';
import type { Branch } from '@/lib/types';

const DemandMap = dynamic(() => import('./DemandMap'), { ssr: false, loading: () => <div className="h-80 animate-pulse rounded-xl bg-paper" /> });

interface Lost {
  abandoned: { count: number; value: number; carts: { conversation_id: number | null; wa_id: string; name: string | null; at: string; total: number; items: string | null }[];
               top_items: { name: string; carts: number }[] };
  out_of_area: { count: number; areas: { area: string; count: number }[]; points: { lat: number; lng: number; area: string }[] };
  while_closed: { count: number; by_hour: { hour: number; count: number }[] };
  refused: { count: number; value: number; reasons: { reason: string; count: number }[] };
  no_order_chats: number; agent_off: number; handoffs: number;
}

// The sales the restaurant is missing — the part a delivery app never shows.
export function MissedSales({ from, to }: { from: Date; to: Date }) {
  const { tenant, base } = useTenant();
  const t = useT();
  const [l, setL] = useState<Lost | null>(null);
  const [branches, setBranches] = useState<Branch[]>([]);
  useEffect(() => {
    setL(null);
    sb().rpc('lost_sales', { p_tenant: tenant.id, p_from: from.toISOString(), p_to: to.toISOString() }).then(({ data }) => setL(data as Lost));
  }, [tenant.id, from, to]);
  useEffect(() => {
    sb().from('branches').select('*').eq('tenant_id', tenant.id).eq('is_active', true).then(({ data }) => setBranches((data || []) as Branch[]));
  }, [tenant.id]);
  if (!l) return <Spinner />;
  const sym = tenant.currency_symbol;
  const hours: Point[] = Array.from({ length: 24 }, (_, h) => {
    const n = l.while_closed.by_hour.find(x => x.hour === h)?.count || 0;
    return { label: String(h).padStart(2, '0'), value: n, display: t('{n} people', { n }) };
  });
  const topArea = l.out_of_area.areas.find(a => a.area !== '—');

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-5">
        <Stat label={t('Carts never finished')} value={String(l.abandoned.count)} hint={l.abandoned.value ? t('worth {v}', { v: money(l.abandoned.value, sym) }) : undefined} />
        <Stat label={t('Outside your delivery zones')} value={String(l.out_of_area.count)} hint={topArea ? t('most from {area}', { area: topArea.area }) : undefined} />
        <Stat label={t('Wrote while you were closed')} value={String(l.while_closed.count)} hint={t('and did not order later')} />
        <Stat label={t('Rejected or cancelled')} value={String(l.refused.count)} hint={l.refused.value ? t('worth {v}', { v: money(l.refused.value, sym) }) : undefined} />
        <Stat label={t('Chatted, no order')} value={String(l.no_order_chats)} hint={l.handoffs ? t('{n} needed a person', { n: l.handoffs }) : undefined} />
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card title={t('Carts never finished — follow up')}>
          {l.abandoned.carts.length === 0 ? <p className="text-sm text-muted">{t('None in this period.')}</p> : (
            <ul className="divide-y divide-hairline">
              {l.abandoned.carts.map(c => (
                <li key={c.wa_id + c.at} className="flex items-start justify-between gap-3 py-2 text-sm">
                  <div className="min-w-0">
                    <p className="font-medium">{c.name || c.wa_id} <span className="text-xs font-normal text-muted">· {timeAgo(c.at)}</span></p>
                    <p className="truncate text-muted" dir="auto">{c.items}</p>
                  </div>
                  <div className="flex shrink-0 items-center gap-2">
                    <span className="font-semibold">{money(c.total, sym)}</span>
                    {c.conversation_id && <Link href={`${base}/inbox?c=${c.conversation_id}`} className="rounded-lg p-1.5 text-gold-ink hover:bg-paper" aria-label={t('Open the chat')}><MessageCircle className="size-4" /></Link>}
                  </div>
                </li>
              ))}
            </ul>
          )}
          {l.abandoned.top_items.length > 0 && (
            <p className="mt-3 text-xs text-muted">{t('Most left in carts: {items}', { items: l.abandoned.top_items.slice(0, 4).map(i => `${i.name} (${i.carts})`).join('، ') })}</p>
          )}
        </Card>

        <Card title={t('Where the customers you cannot deliver to are')}>
          {l.out_of_area.count === 0 ? <p className="text-sm text-muted">{t('Nobody outside your zones in this period.')}</p> : (
            <>
              <DemandMap points={l.out_of_area.points} branches={branches.filter(b => b.lat != null && b.lng != null).map(b => ({ lat: b.lat!, lng: b.lng!, area: b.name_ar }))} />
              <div className="mt-3"><BarList data={l.out_of_area.areas.map(a => ({ label: a.area === '—' ? t('Unknown area') : a.area, value: a.count, display: String(a.count) }))} /></div>
              {topArea && <p className="mt-2 text-xs text-muted">{t('{n} people from {area} could not order delivery — a wider zone or a branch there may pay off.', { n: topArea.count, area: topArea.area })}</p>}
            </>
          )}
        </Card>

        <ChartCard title={t('People who wrote while you were closed')} subtitle={t('By hour — maybe open earlier or later')} rows={hours} valueHeader={t('People')}>
          <ColumnChart data={hours} ariaLabel={t('People who wrote while you were closed')} />
        </ChartCard>

        <Card title={t('Why orders were rejected or cancelled')}>
          {l.refused.reasons.length === 0 ? <p className="text-sm text-muted">{t('None in this period.')}</p>
            : <BarList data={l.refused.reasons.map(r => ({ label: r.reason === '—' ? t('No reason given') : r.reason, value: r.count, display: String(r.count) }))} />}
          {l.agent_off > 0 && <p className="mt-3 text-xs text-muted">{t('{n} people wrote while the agent was switched off.', { n: l.agent_off })}</p>}
        </Card>
      </div>
    </div>
  );
}
