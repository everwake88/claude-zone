'use client';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { BarList, ChartCard, ColumnChart, Stat, type Point } from '@/components/charts/Charts';
import { Input, PageHeader, Spinner, Tabs } from '@/components/ui';
import { useTenant } from '@/components/tenant';
import { money } from '@/lib/format';
import { useT } from '@/lib/i18n';
import { sb } from '@/lib/supabase/client';

interface Report {
  orders: number; revenue: number; average_order: number; cancelled: number; discounts: number; delivery_share: number;
  conversations: number; conversion_percent: number; new_customers: number; returning_orders: number;
  commission_percent: number; commission_saved: number;
  by_day: { day: string; orders: number; revenue: number }[];
  by_hour: { hour: number; orders: number }[];
  by_branch: { branch: string; orders: number; revenue: number }[];
  top_items: { name: string; quantity: number; revenue: number }[];
  agent: { turns: number; avg_reply_seconds: number; repairs: number; tokens: number };
  handoffs: number;
}
type Range = 'today' | '7' | '30' | '90' | 'custom';

const day = (d: Date) => d.toISOString().slice(0, 10);

export default function Analytics() {
  const { tenant, can } = useTenant();
  const [range, setRange] = useState<Range>('30');
  const [from, setFrom] = useState(day(new Date(Date.now() - 29 * 864e5)));
  const [to, setTo] = useState(day(new Date()));
  const [data, setData] = useState<Report | null>(null);
  const [loading, setLoading] = useState(false);
  const sym = tenant.currency_symbol;
  const t = useT();

  const span = useMemo(() => {
    const end = new Date(); end.setHours(23, 59, 59, 999);
    if (range === 'custom') return { from: new Date(from + 'T00:00:00'), to: new Date(to + 'T23:59:59') };
    const start = new Date(); start.setHours(0, 0, 0, 0);
    if (range !== 'today') start.setDate(start.getDate() - (Number(range) - 1));
    return { from: start, to: end };
  }, [range, from, to]);

  const load = useCallback(async () => {
    setLoading(true);
    const { data } = await sb().rpc('analytics', { p_tenant: tenant.id, p_from: span.from.toISOString(), p_to: span.to.toISOString() });
    setData(data as Report);
    setLoading(false);
  }, [tenant.id, span]);
  useEffect(() => { if (can.edit) load(); }, [load, can.edit]);

  // every day in the range, zero when nothing was ordered
  const days: { orders: Point[]; revenue: Point[] } = useMemo(() => {
    const map = new Map((data?.by_day || []).map(d => [d.day, d]));
    const o: Point[] = [], r: Point[] = [];
    for (let d = new Date(span.from); d <= span.to && o.length < 400; d.setDate(d.getDate() + 1)) {
      const k = day(new Date(d.getTime() - d.getTimezoneOffset() * 60000));
      const v = map.get(k);
      const label = k.slice(5).replace('-', '/');
      o.push({ label, value: v?.orders || 0, display: t('{n} orders', { n: v?.orders || 0 }) });
      r.push({ label, value: Number(v?.revenue || 0), display: money(v?.revenue || 0, sym) });
    }
    return { orders: o, revenue: r };
  }, [data, span, sym, t]);
  const hours: Point[] = useMemo(() => Array.from({ length: 24 }, (_, h) => {
    const n = data?.by_hour.find(x => x.hour === h)?.orders || 0;
    return { label: String(h).padStart(2, '0'), value: n, display: t('{n} orders', { n }) };
  }), [data, t]);

  if (!can.edit) return <p className="text-sm text-muted">{t('Reports are for owners and managers.')}</p>;

  return (
    <div className={loading && data ? 'opacity-60 transition-opacity' : ''}>
      <PageHeader title={t('Analytics')} subtitle={t('What WhatsApp ordering brings in — and what it saves you compared with the delivery apps.')} />
      <div className="mb-5 flex flex-wrap items-center gap-3">
        <Tabs value={range} onChange={setRange} tabs={[{ value: 'today', label: t('Today') }, { value: '7', label: t('{n} days', { n: 7 }) }, { value: '30', label: t('{n} days', { n: 30 }) }, { value: '90', label: t('{n} days', { n: 90 }) }, { value: 'custom', label: t('Custom') }]} />
        {range === 'custom' && <><Input type="date" className="w-40" value={from} onChange={e => setFrom(e.target.value)} /><Input type="date" className="w-40" value={to} onChange={e => setTo(e.target.value)} /></>}
      </div>

      {!data ? <Spinner /> : (
        <div className="space-y-4">
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-5">
            <Stat label={t('Orders')} value={data.orders.toLocaleString('en-US')} hint={data.cancelled ? t('{n} rejected or cancelled', { n: data.cancelled }) : undefined} />
            <Stat label={t('Revenue')} value={money(data.revenue, sym)} hint={data.discounts ? t('after {v} in offers', { v: money(data.discounts, sym) }) : undefined} />
            <Stat label={t('Average order')} value={money(data.average_order, sym)} />
            <Stat label={t('Chats that ordered')} value={`${data.conversion_percent}%`} hint={t('{n} people wrote', { n: data.conversations })} />
            <Stat label={t('Commission saved')} value={money(data.commission_saved, sym)} hint={t('vs {p}% on a delivery app', { p: data.commission_percent })} />
          </div>

          <div className="grid gap-4 lg:grid-cols-2">
            <ChartCard title={t('Orders per day')} rows={days.orders} valueHeader={t('Orders')}><ColumnChart data={days.orders} ariaLabel={t('Orders per day')} /></ChartCard>
            <ChartCard title={t('Revenue per day')} rows={days.revenue} valueHeader={t('Revenue')}><ColumnChart data={days.revenue} ariaLabel={t('Revenue per day')} /></ChartCard>
            <ChartCard title={t('When people order')} subtitle={t('Orders by hour of the day')} rows={hours} valueHeader={t('Orders')}><ColumnChart data={hours} ariaLabel={t('Orders by hour')} /></ChartCard>
            <ChartCard title={t('Top dishes')} subtitle={t('By revenue')} rows={data.top_items.map(x => ({ label: x.name, value: Number(x.revenue), display: money(x.revenue, sym) }))} valueHeader={t('Revenue')}>
              <BarList data={data.top_items.map(x => ({ label: x.name, value: Number(x.revenue), display: money(x.revenue, sym), note: '· ' + t('{n} sold', { n: +Number(x.quantity).toFixed(2) }) }))} />
            </ChartCard>
            {data.by_branch.length > 1 && (
              <ChartCard title={t('Revenue by branch')} rows={data.by_branch.map(b => ({ label: b.branch, value: Number(b.revenue), display: money(b.revenue, sym) }))} valueHeader={t('Revenue')}>
                <BarList data={data.by_branch.map(b => ({ label: b.branch, value: Number(b.revenue), display: money(b.revenue, sym), note: '· ' + t('{n} orders', { n: b.orders }) }))} />
              </ChartCard>
            )}
          </div>

          <div className="grid grid-cols-2 gap-3 lg:grid-cols-5">
            <Stat label={t('New customers')} value={String(data.new_customers)} />
            <Stat label={t('Repeat orders')} value={String(data.returning_orders)} hint={t('from customers who ordered before')} />
            <Stat label={t('Delivery share')} value={`${data.delivery_share}%`} />
            <Stat label={t('Agent replies')} value={data.agent.turns.toLocaleString('en-US')} hint={t('about {s}s each', { s: data.agent.avg_reply_seconds })} />
            <Stat label={t('Handed to a person')} value={String(data.handoffs)} hint={t('{n} replies corrected by the safety check', { n: data.agent.repairs })} />
          </div>
        </div>
      )}
    </div>
  );
}
