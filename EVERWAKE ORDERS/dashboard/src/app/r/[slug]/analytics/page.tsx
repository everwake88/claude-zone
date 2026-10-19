'use client';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { BarList, ChartCard, ColumnChart, Stat, type Point } from '@/components/charts/Charts';
import { Input, PageHeader, Spinner, Tabs } from '@/components/ui';
import { useTenant } from '@/components/tenant';
import { money } from '@/lib/format';
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
    for (let t = new Date(span.from); t <= span.to && o.length < 400; t.setDate(t.getDate() + 1)) {
      const k = day(new Date(t.getTime() - t.getTimezoneOffset() * 60000));
      const v = map.get(k);
      const label = k.slice(5).replace('-', '/');
      o.push({ label, value: v?.orders || 0, display: `${v?.orders || 0} orders` });
      r.push({ label, value: Number(v?.revenue || 0), display: money(v?.revenue || 0, sym) });
    }
    return { orders: o, revenue: r };
  }, [data, span, sym]);
  const hours: Point[] = useMemo(() => Array.from({ length: 24 }, (_, h) => {
    const n = data?.by_hour.find(x => x.hour === h)?.orders || 0;
    return { label: String(h).padStart(2, '0'), value: n, display: `${n} orders at ${String(h).padStart(2, '0')}:00` };
  }), [data]);

  if (!can.edit) return <p className="text-sm text-muted">Reports are for owners and managers.</p>;

  return (
    <div className={loading && data ? 'opacity-60 transition-opacity' : ''}>
      <PageHeader title="Analytics" subtitle="What WhatsApp ordering brings in — and what it saves you compared with the delivery apps." />
      <div className="mb-5 flex flex-wrap items-center gap-3">
        <Tabs value={range} onChange={setRange} tabs={[{ value: 'today', label: 'Today' }, { value: '7', label: '7 days' }, { value: '30', label: '30 days' }, { value: '90', label: '90 days' }, { value: 'custom', label: 'Custom' }]} />
        {range === 'custom' && <><Input type="date" className="w-40" value={from} onChange={e => setFrom(e.target.value)} /><Input type="date" className="w-40" value={to} onChange={e => setTo(e.target.value)} /></>}
      </div>

      {!data ? <Spinner /> : (
        <div className="space-y-4">
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-5">
            <Stat label="Orders" value={data.orders.toLocaleString()} hint={data.cancelled ? `${data.cancelled} rejected or cancelled` : undefined} />
            <Stat label="Revenue" value={money(data.revenue, sym)} hint={data.discounts ? `after ${money(data.discounts, sym)} in offers` : undefined} />
            <Stat label="Average order" value={money(data.average_order, sym)} />
            <Stat label="Chats that ordered" value={`${data.conversion_percent}%`} hint={`${data.conversations} people wrote`} />
            <Stat label="Commission saved" value={money(data.commission_saved, sym)} hint={`vs ${data.commission_percent}% on a delivery app`} />
          </div>

          <div className="grid gap-4 lg:grid-cols-2">
            <ChartCard title="Orders per day" rows={days.orders} valueHeader="Orders"><ColumnChart data={days.orders} ariaLabel="Orders per day" /></ChartCard>
            <ChartCard title="Revenue per day" rows={days.revenue} valueHeader="Revenue"><ColumnChart data={days.revenue} ariaLabel="Revenue per day" /></ChartCard>
            <ChartCard title="When people order" subtitle="Orders by hour of the day" rows={hours} valueHeader="Orders"><ColumnChart data={hours} ariaLabel="Orders by hour" /></ChartCard>
            <ChartCard title="Top dishes" subtitle="By revenue" rows={data.top_items.map(t => ({ label: t.name, value: Number(t.revenue), display: money(t.revenue, sym) }))} valueHeader="Revenue">
              <BarList data={data.top_items.map(t => ({ label: t.name, value: Number(t.revenue), display: money(t.revenue, sym), note: `· ${+Number(t.quantity).toFixed(2)} sold` }))} />
            </ChartCard>
            {data.by_branch.length > 1 && (
              <ChartCard title="Revenue by branch" rows={data.by_branch.map(b => ({ label: b.branch, value: Number(b.revenue), display: money(b.revenue, sym) }))} valueHeader="Revenue">
                <BarList data={data.by_branch.map(b => ({ label: b.branch, value: Number(b.revenue), display: money(b.revenue, sym), note: `· ${b.orders} orders` }))} />
              </ChartCard>
            )}
          </div>

          <div className="grid grid-cols-2 gap-3 lg:grid-cols-5">
            <Stat label="New customers" value={String(data.new_customers)} />
            <Stat label="Repeat orders" value={String(data.returning_orders)} hint="from customers who ordered before" />
            <Stat label="Delivery share" value={`${data.delivery_share}%`} />
            <Stat label="Agent replies" value={data.agent.turns.toLocaleString()} hint={`about ${data.agent.avg_reply_seconds}s each`} />
            <Stat label="Handed to a person" value={String(data.handoffs)} hint={`${data.agent.repairs} replies corrected by the safety check`} />
          </div>
        </div>
      )}
    </div>
  );
}
