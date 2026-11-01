'use client';
import { ArrowDownRight, ArrowUpRight, Banknote, Bike, Bot, ChefHat, Clock, Hand, MessageCircle, Receipt, ShieldCheck, ShoppingBag, Sparkles, Users } from 'lucide-react';
import Link from 'next/link';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useEffect, useMemo, useState } from 'react';
import { AreaChart, ChartTable, Columns, Funnel, Heatmap, Legend, RankList, Ring, SplitBar, StackColumns } from '@/components/charts';
import { MissedSales } from '@/components/growth/MissedSales';
import { ChangeLine, changeOf, Kpi, type Change } from '@/components/insights/Kpi';
import { Card, Empty, Input, Spinner, Tabs } from '@/components/ui';
import { useTenant } from '@/components/tenant';
import { clock, cx, money } from '@/lib/format';
import { useLang } from '@/lib/i18n';
import { sb } from '@/lib/supabase/client';
import { useCached } from '@/lib/use-cached';
import { dayKey, zonedDate, zonedMidnight } from '@/lib/zoned';

interface Report {
  orders: number; revenue: number; average_order: number; cancelled: number; discounts: number; delivery_share: number;
  conversations: number; conversion_percent: number; new_customers: number; returning_orders: number;
  commission_percent: number; commission_saved: number;
  by_day: { day: string; orders: number; revenue: number }[];
  by_hour: { hour: number; orders: number }[];
  by_branch: { branch_id?: string; branch: string; branch_en?: string | null; orders: number; revenue: number; avg_order?: number }[];
  top_items: { name: string; quantity: number; revenue: number; prev_quantity?: number }[];
  agent: { turns: number; avg_reply_seconds: number; repairs: number; tokens: number };
  handoffs: number;
  // from the insights patch (017); absent on a database that has not run it yet
  by_source?: { source: string; orders: number; revenue: number }[];
  by_method?: { method: string; orders: number }[];
  by_payment?: { method: string; orders: number; revenue: number }[];
  by_zone?: { zone: string; zone_en: string | null; orders: number; revenue: number }[];
  by_weekday_hour?: { dow: number; hour: number; orders: number }[];
  speed?: { accept_min: number | null; cook_min: number | null; deliver_min: number | null; timed: number };
  speed_by_day?: { day: string; cook_min: number }[];
  funnel?: { wrote: number; cart: number; ordered: number; received: number };
  customers_by_day?: { day: string; new: number; returning: number }[];
  top_customers?: { customer_id: number; name: string | null; phone: string | null; orders: number; spent: number }[];
  falling?: { name: string; quantity: number; prev_quantity: number }[];
  cancel_reasons?: { reason: string; orders: number }[];
}
type Range = 'today' | 'yesterday' | '7' | '30' | '90' | 'custom';
const RANGES: Range[] = ['today', 'yesterday', '7', '30', '90', 'custom'];
const DAY = 864e5;

// the period on screen and the one before it, as long and at the same hours, in the restaurant's time zone
function periodOf(range: Range, from: string, to: string, tz: string) {
  const now = Date.now() + 60000;
  let a: number, b: number, days: number;
  if (range === 'today') { a = zonedMidnight(tz).getTime(); b = now; days = 1; }
  else if (range === 'yesterday') { a = zonedMidnight(tz, 1).getTime(); b = zonedMidnight(tz).getTime(); days = 1; }
  else if (range === 'custom') {
    a = zonedDate(tz, from).getTime(); b = Math.min(zonedDate(tz, to).getTime() + DAY, now);
    if (!(b > a)) b = a + DAY;
    days = Math.max(1, Math.round((zonedDate(tz, to).getTime() + DAY - a) / DAY));
  } else { days = Number(range); a = zonedMidnight(tz, days - 1).getTime(); b = now; }
  return { from: a, to: b, prevFrom: a - days * DAY, prevTo: b - days * DAY, days, hourly: days === 1, live: b >= zonedMidnight(tz).getTime() };
}

// a stable pale tint for a person, from their name
const hueOf = (s: string) => [...s].reduce((h, c) => (h * 31 + c.charCodeAt(0)) % 360, 7);

export default function Analytics() {
  const { tenant, base, can } = useTenant();
  const { t, lang } = useLang();
  const router = useRouter(), pathname = usePathname(), params = useSearchParams();
  const tz = tenant.timezone || 'Africa/Cairo';
  const sym = tenant.currency_symbol;
  const m = (v: number) => money(v, sym);
  const n = (v: number) => Math.round(v).toLocaleString('en-US');
  const locale = lang === 'ar' ? 'ar-EG-u-nu-latn' : 'en-GB';

  // the period lives in the address, so a link or the back button brings it back
  const today = dayKey(new Date(), tz);
  const range = (RANGES.includes(params.get('range') as Range) ? params.get('range') : '30') as Range;
  const view = params.get('view') === 'missed' ? 'missed' : 'sales';
  const [from, setFrom] = useState(params.get('from') || dayKey(new Date(Date.now() - 29 * DAY), tz));
  const [to, setTo] = useState(params.get('to') || today);
  const go = (next: Record<string, string | null>) => {
    const q = new URLSearchParams(params.toString());
    Object.entries(next).forEach(([k, v]) => (v === null ? q.delete(k) : q.set(k, v)));
    router.replace(`${pathname}?${q}`, { scroll: false });
  };
  useEffect(() => { if (range === 'custom') go({ from, to }); // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [from, to]);

  const key = can.edit && view === 'sales' ? `an:${tenant.id}:${range}:${range === 'custom' ? from + '_' + to : ''}` : null;
  const { data, loading, refresh } = useCached(key, async () => {
    const p = periodOf(range, from, to, tz);
    const call = (a: number, b: number) => sb().rpc('analytics', { p_tenant: tenant.id, p_from: new Date(a).toISOString(), p_to: new Date(b).toISOString() });
    const [cur, prev] = await Promise.all([call(p.from, p.to), call(p.prevFrom, p.prevTo)]);
    if (cur.error) throw new Error(cur.error.message);
    return { cur: cur.data as Report, prev: (prev.data || null) as Report | null, p, at: Date.now() };
  });

  // a period that includes today follows new orders as they come (a few seconds after, not on every change)
  const live = data?.p.live;
  useEffect(() => {
    if (!key || !live) return;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const ch = sb().channel('analytics-' + tenant.id)
      .on('postgres_changes', { event: '*', schema: 'everwake', table: 'orders', filter: `tenant_id=eq.${tenant.id}` }, () => {
        if (timer) clearTimeout(timer);
        timer = setTimeout(() => { refresh(); }, 5000);
      })
      .subscribe();
    const tick = setInterval(() => { refresh(); }, 300000);
    return () => { if (timer) clearTimeout(timer); clearInterval(tick); sb().removeChannel(ch); };
  }, [key, live, tenant.id, refresh]);

  const missedSpan = useMemo(() => { const p = periodOf(range, from, to, tz); return { from: new Date(p.from), to: new Date(p.to) }; },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [range, from, to, tz, today]);

  if (!can.edit) return <p className="text-sm text-muted">{t('Reports are for owners and managers.')}</p>;

  const fmtDay = (d: Date, long = false) => new Intl.DateTimeFormat(locale, long ? { weekday: 'long', day: 'numeric', month: 'long', timeZone: tz }
                                                                              : { day: 'numeric', month: 'short', timeZone: tz }).format(d);
  const fmtHour = (h: number) => new Intl.DateTimeFormat(locale, { hour: 'numeric', hour12: true, timeZone: 'UTC' }).format(new Date(Date.UTC(2020, 0, 1, h)));
  const dayNames = Array.from({ length: 7 }, (_, d) => new Intl.DateTimeFormat(locale, { weekday: 'short', timeZone: 'UTC' }).format(new Date(Date.UTC(2023, 0, 1 + d, 12))));
  const dayLong = Array.from({ length: 7 }, (_, d) => new Intl.DateTimeFormat(locale, { weekday: 'long', timeZone: 'UTC' }).format(new Date(Date.UTC(2023, 0, 1 + d, 12))));

  const header = (
    <div className="mb-5 flex flex-wrap items-center gap-3">
      <Tabs value={view} onChange={v => go({ view: v === 'missed' ? 'missed' : null })}
        tabs={[{ value: 'sales', label: t('Sales') }, { value: 'missed', label: t('Missed sales') }]} />
      <div className="rail -mx-1 max-w-full overflow-x-auto px-1">
        <Tabs value={range} onChange={v => go({ range: v, ...(v === 'custom' ? { from, to } : { from: null, to: null }) })}
          tabs={[{ value: 'today', label: t('Today') }, { value: 'yesterday', label: t('Yesterday') }, { value: '7', label: t('{n} days', { n: 7 }) },
                 { value: '30', label: t('{n} days', { n: 30 }) }, { value: '90', label: t('{n} days', { n: 90 }) }, { value: 'custom', label: t('Custom') }]} />
      </div>
      {range === 'custom' && (
        <div className="flex items-center gap-2">
          <Input type="date" className="w-40" value={from} max={to} onChange={e => e.target.value && setFrom(e.target.value)} aria-label={t('From')} />
          <span className="text-muted">–</span>
          <Input type="date" className="w-40" value={to} min={from} max={today} onChange={e => e.target.value && setTo(e.target.value)} aria-label={t('Until')} />
        </div>
      )}
      {data && view === 'sales' && (
        <span className="ms-auto flex items-center gap-1.5 text-xs text-muted">
          {live && <span className="ew-live size-2 rounded-full bg-positive" aria-hidden />}
          {loading ? t('Updating…') : t('Updated {time}', { time: clock(new Date(data.at).toISOString(), tz) })}
        </span>
      )}
    </div>
  );

  if (view === 'missed') {
    return (
      <div>
        <Title t={t} sentence={t('The sales you are missing — the part a delivery app never shows.')} />
        {header}
        <MissedSales from={missedSpan.from} to={missedSpan.to} />
      </div>
    );
  }
  if (!data) return <div><Title t={t} />{header}<Spinner /></div>;

  const { cur, prev, p } = data;
  // what "the period before" is, in words
  const before = range === 'today' ? t('yesterday at this time') : range === 'yesterday' ? t('the day before')
    : range === 'custom' ? t('the {n} days before', { n: p.days }) : t('the previous {n} days', { n: p.days });
  const vs = t('vs {span}', { span: before });
  const ch = (a: number, b: number | undefined, good: 'up' | 'down' = 'up'): Change =>
    ({ value: changeOf(a, Number(b || 0)), good, baseline: vs, fresh: !(Number(b || 0) > 0) && a > 0 });

  // every day (or every hour) of the period present, a quiet one as a zero; the period before slot for slot
  const slots = p.hourly
    ? Array.from({ length: 24 }, (_, h) => h)
    : Array.from({ length: p.days }, (_, i) => i);
  const dayOf = (start: number, i: number) => new Date(start + i * DAY + 12 * 3600e3);
  const byDay = (r: Report | null) => new Map((r?.by_day || []).map(d => [d.day, d]));
  const curDays = byDay(cur), prevDays = byDay(prev);
  const series = slots.map(i => {
    if (p.hourly) {
      const v = cur.by_hour.find(x => x.hour === i), w = prev?.by_hour.find(x => x.hour === i);
      return { label: fmtHour(i), long: fmtHour(i), orders: Number(v?.orders || 0), prevOrders: Number(w?.orders || 0), revenue: 0, prevRevenue: 0, i };
    }
    const d = dayOf(p.from, i), k = dayKey(d, tz), pk = dayKey(dayOf(p.prevFrom, i), tz);
    const v = curDays.get(k), w = prevDays.get(pk);
    return { label: fmtDay(d), long: fmtDay(d, true), orders: Number(v?.orders || 0), prevOrders: Number(w?.orders || 0),
             revenue: Number(v?.revenue || 0), prevRevenue: Number(w?.revenue || 0), i, key: k };
  });
  // hours: from the first busy hour to the last (and the hour it is now, today)
  const nowHour = Number(new Intl.DateTimeFormat('en-US', { timeZone: tz, hour: 'numeric', hourCycle: 'h23' }).format(new Date()));
  const hourly = (() => {
    if (!p.hourly) return [];
    const busy = series.filter(s => s.orders || s.prevOrders).map(s => s.i);
    if (range === 'today') busy.push(nowHour);
    if (!busy.length) return [];
    const lo = Math.min(...busy), hi = Math.max(...busy);
    return series.filter(s => s.i >= lo && s.i <= hi);
  })();

  const orders = Number(cur.orders), revenue = Number(cur.revenue);
  const empty = orders === 0 && Number(cur.cancelled) === 0;

  // the one finding, under the title: how the period went, against the one before, and when it was busiest
  const week = cur.by_weekday_hour || [];
  const peak = week.reduce<{ dow: number; hour: number; orders: number } | null>((b, c) => (!b || c.orders > b.orders ? c : b), null);
  const peakHour = cur.by_hour.reduce<{ hour: number; orders: number } | null>((b, c) => (!b || c.orders > b.orders ? c : b), null);
  const revChange = changeOf(revenue, Number(prev?.revenue || 0));
  const sep = lang === 'ar' ? '، ' : ', ';
  const finding = empty ? t('No orders in this period yet.') : [
    t('{n} orders and {v} in sales', { n: n(orders), v: m(revenue) })
      + (revChange === null ? '' : sep + (revChange > 0 ? t('{p}% more than {span}', { p: revChange, span: before })
        : revChange < 0 ? t('{p}% less than {span}', { p: -revChange, span: before }) : t('the same as {span}', { span: before }))) + '.',
    p.hourly ? (peakHour && peakHour.orders > 1 ? t('Busiest around {hour}.', { hour: fmtHour(peakHour.hour) }) : '')
      : (peak && peak.orders > 1 ? t('Busiest on {day} around {hour}.', { day: dayLong[peak.dow], hour: fmtHour(peak.hour) }) : '')
  ].filter(Boolean).join(' ');

  const avgOf = (s: { orders: number; revenue: number }) => (s.orders ? s.revenue / s.orders : 0);
  const sparkOrders = series.map(s => s.orders), sparkRevenue = series.map(s => s.revenue);
  const rate = (r: Report | null) => r?.funnel ? (r.funnel.wrote ? Math.round((Number(r.funnel.ordered) / Number(r.funnel.wrote)) * 1000) / 10 : 0)
    : Math.min(100, Number(r?.conversion_percent || 0));
  const conv = rate(cur), prevConv = rate(prev);
  const wrote = cur.funnel ? Number(cur.funnel.wrote) : Number(cur.conversations);
  const kpis = [
    { label: t('Orders'), value: orders, fmt: n, icon: ShoppingBag, spark: p.hourly ? undefined : sparkOrders, change: ch(orders, prev?.orders) },
    { label: t('Revenue'), value: revenue, fmt: m, icon: Banknote, spark: p.hourly ? undefined : sparkRevenue, change: ch(revenue, prev?.revenue) },
    { label: t('Average order'), value: Number(cur.average_order), fmt: m, icon: Receipt, spark: p.hourly ? undefined : series.map(avgOf),
      change: ch(Number(cur.average_order), prev?.average_order) },
    { label: t('Chats that ordered'), value: conv, fmt: (v: number) => `${v}%`, icon: MessageCircle,
      change: { value: wrote && prevConv ? Math.round(conv - prevConv) : null, unit: 'pts' as const, baseline: vs } as Change,
      fallback: t('{n} people wrote', { n: n(wrote) }) }
  ];

  return (
    <div className="space-y-5 pb-4">
      <Title t={t} sentence={finding} />
      {header}

      {empty ? (
        <Empty title={t('No orders in this period yet.')}>
          {range === 'today' ? t('Today’s numbers fill in as orders come. Look at the last 7 or 30 days meanwhile.') : t('Choose a longer period to see how ordering is going.')}
        </Empty>
      ) : (
        <>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
            {kpis.map((k, i) => (
              <Kpi key={k.label} label={k.label} value={k.value} format={k.fmt} icon={k.icon} tint={i + 1} spark={k.spark} delay={i * 60}
                change={k.change} fallback={k.fallback || t('Nothing to compare with yet')} />
            ))}
          </div>

          <div className="grid gap-4 xl:grid-cols-3">
            <SalesCard className="xl:col-span-2" t={t} hourly={p.hourly} series={series} hours={hourly} nowIndex={range === 'today' ? hourly.findIndex(h => h.i === nowHour) : undefined}
              m={m} n={n} before={before} revenue={revenue} orders={orders} />
            <SpeedCard t={t} cur={cur} prev={prev} vs={vs} hourly={p.hourly} fmtDay={fmtDay} />
          </div>

          <div className="grid gap-4 xl:grid-cols-3">
            {p.hourly || !week.length ? <Shares t={t} cur={cur} n={n} m={m} /> : (
              <Card className="xl:col-span-2" title={t('Busiest times')}>
                <ChartTable label={{ chart: t('Show the chart'), table: t('Show as a table') }} head={[t('Day'), t('Busiest hour'), t('Orders')]}
                  rows={[6, 0, 1, 2, 3, 4, 5].map(d => {
                    const cells = week.filter(c => c.dow === d), top = cells.reduce<typeof cells[number] | null>((b, c) => (!b || c.orders > b.orders ? c : b), null);
                    return [dayLong[d], top ? fmtHour(top.hour) : '—', n(cells.reduce((s, c) => s + Number(c.orders), 0))];
                  })} toolbar={<p className="text-sm text-muted">{t('Each square is one hour of one weekday, all the weeks in the period added up.')}</p>}>
                  <Heatmap cells={week.map(c => ({ dow: c.dow, hour: c.hour, value: Number(c.orders) }))} dayNames={dayNames} hourLabel={fmtHour}
                    format={v => t('{n} orders', { n: v })} less={t('Fewer')} more={t('More')} />
                </ChartTable>
              </Card>
            )}
            <FunnelCard t={t} cur={cur} n={n} />
          </div>

          <CustomersRow t={t} cur={cur} prev={prev} vs={vs} hourly={p.hourly} series={series} fmtDay={fmtDay} dayOfKey={(k: string) => new Date(k + 'T12:00:00Z')}
            n={n} m={m} base={base} />

          <div className="grid gap-4 xl:grid-cols-3">
            <Card className="xl:col-span-2" title={t('Dishes that sell')} action={<Link href={`${base}/menu`} className="text-sm text-gold-ink hover:underline">{t('Open the menu')}</Link>}>
              {cur.top_items.length === 0 ? <p className="text-sm text-muted">{t('No dishes sold in this period yet.')}</p> : (
                <>
                  <p className="-mt-1 mb-3 text-sm text-muted">{t('By sales; the arrow is the number sold {span}.', { span: vs })}</p>
                  <RankList format={m} rows={cur.top_items.map(x => {
                    const q = Number(x.quantity), pq = Number(x.prev_quantity ?? NaN);
                    return { label: x.name, value: Number(x.revenue), sub: `×${+q.toFixed(2)}`,
                             trend: Number.isNaN(pq) ? null : pq > 0 ? Math.round(((q - pq) / pq) * 100) : null,
                             badge: !Number.isNaN(pq) && pq === 0 ? t('New') : undefined };
                  })} />
                </>
              )}
            </Card>
            <MoversCard t={t} cur={cur} before={before} />
          </div>

          <WhereRow t={t} cur={cur} prev={prev} vs={vs} n={n} m={m} lang={lang} shares={!(p.hourly || !week.length)} />

          <AgentCard t={t} cur={cur} prev={prev} vs={vs} n={n} m={m} />
        </>
      )}
    </div>
  );
}

type T = (k: string, v?: Record<string, string | number>) => string;

function Title({ t, sentence }: { t: T; sentence?: string }) {
  return (
    <div className="mb-5">
      <h1 className="text-[28px] font-bold leading-tight tracking-[-0.02em] text-ink">{t('Analytics')}</h1>
      {sentence !== undefined && <p className="mt-1.5 max-w-3xl text-[15px] leading-relaxed text-ink/75">{sentence}</p>}
    </div>
  );
}

interface Slot { label: string; long: string; orders: number; prevOrders: number; revenue: number; prevRevenue: number; i: number; key?: string }

function SalesCard({ className, t, hourly, series, hours, nowIndex, m, n, before, revenue, orders }: {
  className?: string; t: T; hourly: boolean; series: Slot[]; hours: Slot[]; nowIndex?: number; m: (v: number) => string; n: (v: number) => string;
  before: string; revenue: number; orders: number;
}) {
  const [metric, setMetric] = useState<'revenue' | 'orders'>(hourly ? 'orders' : 'revenue');
  const rev = metric === 'revenue' && !hourly;
  return (
    <Card className={className} title={hourly ? t('Orders through the day') : rev ? t('Revenue over the period') : t('Orders over the period')}
      action={!hourly && <Tabs size="sm" value={metric} onChange={setMetric} tabs={[{ value: 'revenue', label: t('Revenue') }, { value: 'orders', label: t('Orders') }]} />}>
      <ChartTable label={{ chart: t('Show the chart'), table: t('Show as a table') }}
        toolbar={<div className="flex flex-wrap items-center gap-x-5 gap-y-1">
          <p className="text-sm text-muted">{rev ? t('{v} in the period', { v: m(revenue) }) : t('{n} orders in the period', { n: n(orders) })}</p>
          <Legend items={[{ label: t('This period'), kind: hourly ? 'box' : 'line', color: 'var(--color-gold-ink)' },
            { label: before, kind: hourly ? 'box' : 'dash', color: hourly ? 'color-mix(in oklab, var(--color-ink) 12%, transparent)' : 'var(--color-muted)' }]} />
        </div>}
        head={[hourly ? t('Hour') : t('Day'), t('This period'), before]}
        rows={(hourly ? hours : series).map(s => [s.long, rev ? m(s.revenue) : n(s.orders), rev ? m(s.prevRevenue) : n(s.prevOrders)])}>
        {hourly
          ? (hours.length ? <Columns bars={hours.map(h => ({ label: h.label, long: h.long, value: h.orders, usual: h.prevOrders }))} format={n} now={nowIndex} />
            : <p className="text-sm text-muted">{t('The hours fill in as orders come.')}</p>)
          : <AreaChart key={metric} format={rev ? m : n} compareLabel={before}
              points={series.map(s => ({ label: s.label, long: s.long, value: rev ? s.revenue : s.orders }))}
              compare={series.map(s => (rev ? s.prevRevenue : s.prevOrders))} />}
      </ChartTable>
    </Card>
  );
}

function SpeedCard({ t, cur, prev, vs, hourly, fmtDay }: { t: T; cur: Report; prev: Report | null; vs: string; hourly: boolean; fmtDay: (d: Date, long?: boolean) => string }) {
  const s = cur.speed, ps = prev?.speed;
  const rows = [
    { icon: Clock, label: t('To accept'), v: s?.accept_min, pv: ps?.accept_min },
    { icon: ChefHat, label: t('To cook'), v: s?.cook_min, pv: ps?.cook_min },
    { icon: Bike, label: t('On the road'), v: s?.deliver_min, pv: ps?.deliver_min }
  ];
  const trend = (cur.speed_by_day || []).filter(d => d.cook_min != null);
  return (
    <Card title={t('Kitchen speed')}>
      {!s ? <p className="text-sm text-muted">{t('Run the latest database update to see this.')}</p>
        : !s.timed && s.accept_min == null ? <p className="text-sm text-muted">{t('Times appear once orders are accepted and marked ready on the board or the kitchen screen.')}</p> : (
        <div className="space-y-4">
          <ul className="space-y-3">
            {rows.map(r => (
              <li key={r.label} className="flex items-center gap-3">
                <span className="flex size-9 shrink-0 items-center justify-center rounded-[12px] bg-paper-sunk text-ink/70"><r.icon className="size-[18px]" aria-hidden /></span>
                <span className="min-w-0 flex-1">
                  <span className="block text-sm text-ink/70">{r.label}</span>
                  {r.v != null && r.pv != null && Number(r.pv) > 0
                    ? <ChangeLine change={{ value: changeOf(Number(r.v), Number(r.pv)), good: 'down', baseline: vs }} />
                    : <span className="block text-xs text-muted">{r.v == null ? t('Not timed yet') : t('Nothing to compare with yet')}</span>}
                </span>
                <span className="shrink-0 text-xl font-bold tabular-nums text-ink">{r.v == null ? '—' : t('{n} min', { n: +Number(r.v).toFixed(1) })}</span>
              </li>
            ))}
          </ul>
          {!hourly && trend.length >= 3 && (
            <div>
              <p className="mb-1 text-xs text-muted">{t('Minutes to cook, day by day')}</p>
              <AreaChart height={120} format={v => String(Math.round(v))}
                points={trend.map(d => { const dt = new Date(d.day + 'T12:00:00Z'); return { label: fmtDay(dt), long: fmtDay(dt, true), value: Number(d.cook_min) }; })} />
            </div>
          )}
          <p className="text-xs text-muted">{t('Half of the orders were quicker than these times.')}</p>
        </div>
      )}
    </Card>
  );
}

function FunnelCard({ t, cur, n }: { t: T; cur: Report; n: (v: number) => string }) {
  const f = cur.funnel;
  return (
    <Card title={t('From a chat to an order')}>
      {!f ? <p className="text-sm text-muted">{t('Run the latest database update to see this.')}</p>
        : !f.wrote ? <p className="text-sm text-muted">{t('Nobody wrote on WhatsApp in this period.')}</p> : (
        <>
          <Funnel format={n} steps={[
            { label: t('Wrote on WhatsApp'), value: Number(f.wrote) },
            { label: t('Started a cart'), value: Number(f.cart) },
            { label: t('Ordered'), value: Number(f.ordered) },
            { label: t('Received their order'), value: Number(f.received) }
          ]} />
          <p className="mt-4 text-sm text-ink/75">{t('{p}% of the people who wrote ordered.', { p: Math.round((Number(f.ordered) / Number(f.wrote)) * 100) })}</p>
          <p className="mt-1 text-xs text-muted">{t('People, not messages. QR orders are left out: they never came from a chat.')}</p>
        </>
      )}
    </Card>
  );
}

function CustomersRow({ t, cur, prev, vs, hourly, series, fmtDay, dayOfKey, n, m, base }: {
  t: T; cur: Report; prev: Report | null; vs: string; hourly: boolean; series: Slot[]; fmtDay: (d: Date, long?: boolean) => string;
  dayOfKey: (k: string) => Date; n: (v: number) => string; m: (v: number) => string; base: string;
}) {
  const orders = Number(cur.orders), back = Number(cur.returning_orders);
  const share = orders ? Math.round((back / orders) * 100) : 0;
  const prevShare = prev && Number(prev.orders) ? Math.round((Number(prev.returning_orders) / Number(prev.orders)) * 100) : null;
  const byDay = new Map((cur.customers_by_day || []).map(d => [d.day, d]));
  const regulars = cur.top_customers || [];
  return (
    <div className="grid gap-4 xl:grid-cols-3">
      <Card className="xl:col-span-2" title={t('New and returning customers')}>
        <dl className="mb-4 grid grid-cols-2 gap-3 sm:grid-cols-3">
          <div className="rounded-[var(--ui-radius-inner)] bg-paper/70 p-3">
            <dt className="flex items-center gap-1.5 text-xs text-muted"><Users className="size-3.5" aria-hidden />{t('New customers')}</dt>
            <dd className="mt-1 text-xl font-bold tabular-nums text-ink">{n(Number(cur.new_customers))}</dd>
            <ChangeLine change={{ value: changeOf(Number(cur.new_customers), Number(prev?.new_customers || 0)), baseline: vs,
              fresh: !(Number(prev?.new_customers || 0) > 0) && Number(cur.new_customers) > 0 }} fallback={t('Nothing to compare with yet')} />
          </div>
          <div className="rounded-[var(--ui-radius-inner)] bg-paper/70 p-3">
            <dt className="flex items-center gap-1.5 text-xs text-muted"><Sparkles className="size-3.5" aria-hidden />{t('Orders from returning customers')}</dt>
            <dd className="mt-1 text-xl font-bold tabular-nums text-ink">{share}%</dd>
            <ChangeLine change={{ value: prevShare === null ? null : share - prevShare, unit: 'pts', baseline: vs }} fallback={t('{n} orders', { n: n(back) })} />
          </div>
          <div className="col-span-2 rounded-[var(--ui-radius-inner)] bg-paper/70 p-3 sm:col-span-1">
            <dt className="flex items-center gap-1.5 text-xs text-muted"><Receipt className="size-3.5" aria-hidden />{t('Offers given')}</dt>
            <dd className="mt-1 text-xl font-bold tabular-nums text-ink">{m(Number(cur.discounts))}</dd>
            <p className="text-xs text-ink/70">{t('taken off the bills in this period')}</p>
          </div>
        </dl>
        {hourly || !cur.customers_by_day ? null : (
          <>
            <div className="mb-2 flex justify-end">
              <Legend items={[{ label: t('Returning'), kind: 'box', color: 'var(--color-gold-ink)' },
                { label: t('First order'), kind: 'box', color: 'color-mix(in oklab, var(--color-gold-ink) 30%, var(--color-paper))' }]} />
            </div>
            <StackColumns format={n} names={[t('Returning'), t('First order')]}
              colors={['var(--color-gold-ink)', 'color-mix(in oklab, var(--color-gold-ink) 30%, var(--color-paper))']}
              bars={series.map(s => { const d = byDay.get(s.key || ''); const dt = s.key ? dayOfKey(s.key) : new Date();
                return { label: s.label, long: fmtDay(dt, true), parts: [Number(d?.returning || 0), Number(d?.new || 0)] }; })} />
          </>
        )}
      </Card>
      <Card title={t('Your regulars')} action={<Link href={`${base}/customers`} className="text-sm text-gold-ink hover:underline">{t('All customers')}</Link>}>
        {!cur.top_customers ? <p className="text-sm text-muted">{t('Run the latest database update to see this.')}</p>
          : regulars.length === 0 ? <p className="text-sm text-muted">{t('Customers who order show here, the ones who spend most first.')}</p> : (
          <ul className="space-y-1.5">
            {regulars.map(c => {
              const name = c.name || c.phone || t('A customer'), h = hueOf(name);
              return (
                <li key={c.customer_id}>
                  <Link href={`${base}/customers?q=${encodeURIComponent(c.phone || c.name || '')}`}
                    className="flex items-center gap-3 rounded-[var(--ui-radius-inner)] px-2 py-2 text-sm transition-colors duration-150 hover:bg-paper">
                    <span className="flex size-9 shrink-0 items-center justify-center rounded-full font-semibold"
                      style={{ background: `oklch(0.94 0.04 ${h})`, color: `oklch(0.42 0.1 ${h})` }}>{name.slice(0, 1)}</span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate font-medium text-ink"><bdi>{name}</bdi></span>
                      <span className="block text-xs text-muted">{t('{n} orders', { n: c.orders })}</span>
                    </span>
                    <span className="shrink-0 font-semibold tabular-nums text-ink">{m(Number(c.spent))}</span>
                  </Link>
                </li>
              );
            })}
          </ul>
        )}
      </Card>
    </div>
  );
}

function Shares({ t, cur, n, m }: { t: T; cur: Report; n: (v: number) => string; m: (v: number) => string }) {
  const SRC: Record<string, { label: string; color: string }> = {
    whatsapp: { label: t('WhatsApp agent'), color: 'var(--color-gold-ink)' }, qr: { label: t('QR in the branch'), color: 'var(--color-navy-soft)' },
    team: { label: t('Added by the team'), color: 'var(--ui-tint-ink-4, #6b7c86)' } };
  const METHOD: Record<string, { label: string; color: string }> = {
    delivery: { label: t('Delivery'), color: 'var(--color-gold-ink)' }, pickup: { label: t('Pickup'), color: 'var(--color-navy-soft)' },
    dine_in: { label: t('Dine-in'), color: 'var(--ui-tint-ink-2, #6b7c86)' } };
  const PAY: Record<string, string> = { cash: t('Cash'), card: t('Card on delivery'), wallet: t('Mobile wallet'), instapay: t('InstaPay'),
    online: t('Online (Paymob link)'), unknown: t('Not recorded') };
  const orders = Number(cur.orders);
  return (
    <>
      <Card title={t('Where orders come from')}>
        {cur.by_source ? (
          <Ring parts={cur.by_source.map(x => ({ label: SRC[x.source]?.label || x.source, value: Number(x.orders), color: SRC[x.source]?.color || 'var(--color-muted)', note: n(Number(x.orders)) }))}
            center={<><span className="text-2xl font-bold tabular-nums text-ink">{n(orders)}</span><span className="text-xs text-muted">{t('orders')}</span></>} />
        ) : <p className="text-sm text-muted">{t('Run the latest database update to see this.')}</p>}
      </Card>
      <Card title={t('How they were served and paid')}>
        <div className="space-y-5">
          {cur.by_method && <SplitBar parts={cur.by_method.map(x => ({ label: METHOD[x.method]?.label || x.method, value: Number(x.orders), color: METHOD[x.method]?.color || 'var(--color-muted)' }))} />}
          {cur.by_payment && cur.by_payment.length > 0 && (
            <RankList format={n} rows={cur.by_payment.map(x => ({ label: PAY[x.method] || x.method, value: Number(x.orders), sub: m(Number(x.revenue)) }))} />
          )}
        </div>
      </Card>
    </>
  );
}

function WhereRow({ t, cur, prev, vs, n, m, lang, shares }: {
  t: T; cur: Report; prev: Report | null; vs: string; n: (v: number) => string; m: (v: number) => string; lang: string; shares: boolean;
}) {
  const orders = Number(cur.orders);
  const branches = cur.by_branch.length > 1 ? cur.by_branch : [];
  const zones = cur.by_zone || [];
  const cancelled = Number(cur.cancelled);
  return (
    <div className="grid gap-4 lg:grid-cols-2">
      {shares && <Shares t={t} cur={cur} n={n} m={m} />}
      {(branches.length > 0 || zones.length > 0) && (
        <Card title={branches.length ? t('Branches') : t('Delivery areas')}>
          {branches.length > 0 ? (
            <RankList format={m} rows={branches.map(b => ({ label: (lang === 'ar' ? b.branch : b.branch_en || b.branch), value: Number(b.revenue),
              sub: t('{n} orders', { n: b.orders }) + (b.avg_order ? ' · ' + t('avg {v}', { v: m(Number(b.avg_order)) }) : '') }))} />
          ) : (
            <RankList format={n} rows={zones.map(z => ({ label: lang === 'ar' ? z.zone : z.zone_en || z.zone, value: Number(z.orders), sub: m(Number(z.revenue)) }))} />
          )}
          {branches.length > 0 && zones.length > 0 && (
            <div className="mt-5">
              <p className="mb-2 text-sm font-medium text-ink">{t('Delivery areas')}</p>
              <RankList format={n} rows={zones.slice(0, 5).map(z => ({ label: lang === 'ar' ? z.zone : z.zone_en || z.zone, value: Number(z.orders), sub: m(Number(z.revenue)) }))} />
            </div>
          )}
        </Card>
      )}
      <Card title={t('Cancelled and rejected')}>
        <div className="flex items-baseline gap-3">
          <span className="text-[28px] font-bold leading-none tabular-nums text-ink">{n(cancelled)}</span>
          <span className="text-sm text-muted">{orders + cancelled ? t('{p}% of the orders', { p: Math.round((cancelled / (orders + cancelled)) * 100) }) : ''}</span>
        </div>
        <ChangeLine className="mt-1.5" change={{ value: changeOf(cancelled, Number(prev?.cancelled || 0)), good: 'down', baseline: vs }}
          fallback={cancelled ? t('Nothing to compare with yet') : t('None — good.')} />
        {cur.cancel_reasons && cur.cancel_reasons.length > 0 && (
          <ul className="mt-4 space-y-1.5 text-sm">
            {cur.cancel_reasons.map(r => (
              <li key={r.reason} className="flex items-center gap-3 rounded-[var(--ui-radius-inner)] bg-paper/70 px-3 py-2">
                <span className="min-w-0 flex-1 truncate text-ink"><bdi>{r.reason || t('No reason given')}</bdi></span>
                <span className="shrink-0 font-semibold tabular-nums text-ink">{n(Number(r.orders))}</span>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}

function AgentCard({ t, cur, prev, vs, n, m }: { t: T; cur: Report; prev: Report | null; vs: string; n: (v: number) => string; m: (v: number) => string }) {
  const a = cur.agent;
  const items: { icon: typeof Bot; label: string; value: string; change?: Change; note?: string }[] = [
    { icon: Bot, label: t('Agent replies'), value: n(Number(a.turns)), change: { value: changeOf(Number(a.turns), Number(prev?.agent.turns || 0)), baseline: vs } },
    { icon: Clock, label: t('Average reply time'), value: Number(a.turns) ? t('{s} s', { s: Number(a.avg_reply_seconds) }) : '—',
      change: { value: changeOf(Number(a.avg_reply_seconds), Number(prev?.agent.avg_reply_seconds || 0)), good: 'down', baseline: vs } },
    { icon: Hand, label: t('Handed to a person'), value: n(Number(cur.handoffs)),
      change: { value: changeOf(Number(cur.handoffs), Number(prev?.handoffs || 0)), good: 'down', baseline: vs } },
    { icon: ShieldCheck, label: t('Replies corrected by the safety check'), value: n(Number(a.repairs)) },
    { icon: Banknote, label: t('Kept from delivery-app commission'), value: m(Number(cur.commission_saved)), note: t('at {p}% on the same orders', { p: cur.commission_percent }) }
  ];
  return (
    <Card title={t('The agent')}>
      <dl className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-5">
        {items.map(i => (
          <div key={i.label} className={cx('rounded-[var(--ui-radius-inner)] bg-paper/70 p-3')}>
            <dt className="flex items-start gap-1.5 text-xs leading-snug text-muted"><i.icon className="mt-px size-3.5 shrink-0" aria-hidden /><span>{i.label}</span></dt>
            <dd className="mt-1 text-lg font-bold tabular-nums text-ink">{i.value}</dd>
            {i.change ? <ChangeLine change={i.change} fallback="—" /> : i.note ? <p className="text-xs text-ink/70">{i.note}</p> : null}
          </div>
        ))}
      </dl>
    </Card>
  );
}

// the dishes moving most against the period before, up and down: the ones worth a look
function MoversCard({ t, cur, before }: { t: T; cur: Report; before: string }) {
  const q = (v: number) => +Number(v).toFixed(2);
  const rising = cur.top_items
    .filter(x => Number(x.prev_quantity) > 0 && Number(x.quantity) > Number(x.prev_quantity))
    .map(x => ({ name: x.name, q: Number(x.quantity), pq: Number(x.prev_quantity), d: (Number(x.quantity) - Number(x.prev_quantity)) / Number(x.prev_quantity) }))
    .sort((a, b) => b.d - a.d).slice(0, 3);
  const row = (name: string, a: number, b: number, up: boolean) => (
    <li key={name} className="flex items-center gap-3 rounded-[var(--ui-radius-inner)] bg-paper/70 px-3 py-2.5 text-sm">
      <span className={cx('flex size-6 shrink-0 items-center justify-center rounded-full', up ? 'bg-positive-wash text-positive' : 'bg-critical-wash text-critical')}>
        {up ? <ArrowUpRight className="size-3.5" aria-hidden /> : <ArrowDownRight className="size-3.5" aria-hidden />}
      </span>
      <span className="min-w-0 flex-1 truncate font-medium text-ink"><bdi>{name}</bdi></span>
      <span className="shrink-0 text-xs tabular-nums text-muted">{t('{a} sold, was {b}', { a: q(a), b: q(b) })}</span>
    </li>
  );
  return (
    <Card title={t('Selling more, selling less')}>
      {!cur.falling ? <p className="text-sm text-muted">{t('Run the latest database update to see this.')}</p> : (
        <div className="space-y-5">
          <div>
            <p className="mb-2 text-sm font-medium text-ink">{t('Selling more')}</p>
            {rising.length ? <ul className="space-y-1.5">{rising.map(r => row(r.name, r.q, r.pq, true))}</ul>
              : <p className="text-sm text-muted">{t('No dish is selling clearly more than {span}.', { span: before })}</p>}
          </div>
          <div>
            <p className="mb-2 text-sm font-medium text-ink">{t('Selling less')}</p>
            {cur.falling.length ? <ul className="space-y-1.5">{cur.falling.map(f => row(f.name, Number(f.quantity), Number(f.prev_quantity), false))}</ul>
              : <p className="text-sm text-muted">{t('No dish is selling clearly less than {span}.', { span: before })}</p>}
          </div>
          {cur.falling.length > 0 && <p className="text-xs text-muted">{t('Worth a look: is it out of stock often, missing a photo, or priced above the rest?')}</p>}
        </div>
      )}
    </Card>
  );
}
