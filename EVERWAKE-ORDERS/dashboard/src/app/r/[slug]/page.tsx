'use client';
import { ArrowDownRight, ArrowUpRight, Banknote, CheckCircle2, ChefHat, Clock, MessageCircle, Receipt, Rocket, ShoppingBag, Sparkles, TrendingUp, Users } from 'lucide-react';
import Link from 'next/link';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { AreaChart, Columns, RankList, Ring, Sparkline, SplitBar } from '@/components/charts';
import { Badge, Button, Card, CountUp, Spinner, Tabs, useAction } from '@/components/ui';
import { useTenant } from '@/components/tenant';
import { cx, money, timeAgo, displayName } from '@/lib/format';
import { useLang } from '@/lib/i18n';
import { sb } from '@/lib/supabase/client';
import type { Checklist, Conversation, Order } from '@/lib/types';

// the checklist comes from the database in English; its details carry counts
const DETAILS: [RegExp, string][] = [
  [/^(\d+) of (\d+) branches complete$/, '{a} of {b} branches complete'],
  [/^(\d+) of (\d+) delivering branches have a zone or a map pin$/, '{a} of {b} delivering branches have a zone or a map pin'],
  [/^(\d+) of (\d+) dishes have a price$/, '{a} of {b} dishes have a price'],
  [/^(\d+) of (\d+) dishes have a photo$/, '{a} of {b} dishes have a photo'],
  [/^(\d+) of (\d+) numbers connected$/, '{a} of {b} numbers connected'],
  [/^(\d+) pages$/, '{a} pages'],
  [/^(\d+) answers$/, '{a} answers'],
  [/^(\d+) orders so far$/, '{a} orders so far']
];
function detailText(t: (k: string, v?: Record<string, string>) => string, key: string, d: string): string {
  if (key === 'payment') return d.split(',').map(x => t(x.trim())).join('، ');
  for (const [re, tpl] of DETAILS) { const m = re.exec(d); if (m) return t(tpl, { a: m[1], b: m[2] }); }
  return t(d);
}

// what each step gives the restaurant, so the checklist says why and not only what
const WHY: Record<string, string> = {
  profile: 'The agent introduces itself by this name and tells customers only these facts about you.',
  branches: 'Every order goes to a branch; its hours decide when the agent takes orders.',
  zones: 'A customer’s location decides which branch delivers, the fee and the minimum.',
  menu: 'The agent offers only the dishes here, at these prices.',
  photos: 'Customers who ask what a dish looks like get its photo.',
  menu_pages: 'Customers who ask for the menu get these pictures.',
  payment: 'The agent promises only the ways of paying you tick.',
  knowledge: 'Questions that are not about food (parking, parties…) get your own answer.',
  whatsapp: 'The number customers message — nothing reaches the agent without it.',
  test_order: 'Order from your own phone first, so you see what customers will see.'
};

interface Day { day: string; orders: number; revenue: number }
interface Report {
  orders: number; revenue: number; average_order: number; conversations: number; conversion_percent: number; cancelled: number;
  new_customers: number; returning_orders: number; commission_saved: number; commission_percent: number;
  by_day: Day[]; by_hour: { hour: number; orders: number }[]; top_items: { name: string; quantity: number; revenue: number }[];
  by_source?: { source: string; orders: number; revenue: number }[]; by_method?: { method: string; orders: number }[];
}
interface Live { waiting: number; cooking: number; ready: number; last: { order_no: string; placed_at: string; total: number } | null }

// midnight in the restaurant's own time zone, `daysAgo` days back, as an instant
function zonedMidnight(tz: string, daysAgo = 0) {
  const now = new Date();
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }).formatToParts(now).map(x => [x.type, x.value]));
  const offset = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second) - now.getTime();
  return new Date(Date.UTC(+p.year, +p.month - 1, +p.day - daysAgo) - offset);
}
const dayKey = (d: Date, tz: string) => new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);

// The overview: what is happening in the restaurant right now, how today compares, and the last two
// weeks drawn — revenue, where orders come from, the busy hours, the dishes that sell. Owners and
// managers see the numbers; the team sees the live service and what is waiting for them.
export default function Overview() {
  const { tenant, base, can, brand } = useTenant();
  const { t, lang } = useLang();
  const tz = tenant.timezone || 'Africa/Cairo';
  const sym = tenant.currency_symbol;
  const [list, setList] = useState<Checklist | null>(null);
  const [today, setToday] = useState<Report | null>(null);
  const [span, setSpan] = useState<Report | null>(null);
  const [live, setLive] = useState<Live | null>(null);
  const [waiting, setWaiting] = useState<Order[]>([]);
  const [attention, setAttention] = useState<Conversation[]>([]);
  const [metric, setMetric] = useState<'revenue' | 'orders'>('revenue');
  const [now, setNow] = useState(() => Date.now());
  const { busy, run } = useAction();
  const locale = lang === 'ar' ? 'ar-EG-u-nu-latn' : 'en-GB';
  const m = (v: number) => money(v, sym);

  const loadLive = useCallback(async () => {
    const db = sb();
    const [o, a, k, last] = await Promise.all([
      db.from('orders').select('*').eq('tenant_id', tenant.id).eq('status', 'placed').order('placed_at').limit(6),
      db.from('conversations').select('*, customers(display_name, full_name, phone, phone_hidden, orders_count, is_blocked)')
        .eq('tenant_id', tenant.id).eq('needs_attention', true).order('attention_at', { ascending: false }).limit(5),
      db.from('orders').select('status').eq('tenant_id', tenant.id).in('status', ['placed', 'accepted', 'preparing', 'ready'])
        .gte('placed_at', zonedMidnight(tz, 1).toISOString()),
      db.from('orders').select('order_no, placed_at, total').eq('tenant_id', tenant.id).neq('status', 'draft').not('placed_at', 'is', null)
        .order('placed_at', { ascending: false }).limit(1)
    ]);
    const st = ((k.data || []) as { status: string }[]).map(x => x.status);
    setWaiting((o.data || []) as Order[]);
    setAttention((a.data || []) as Conversation[]);
    setLive({ waiting: st.filter(x => x === 'placed').length, cooking: st.filter(x => x === 'accepted' || x === 'preparing').length,
              ready: st.filter(x => x === 'ready').length, last: (last.data?.[0] as Live['last']) || null });
  }, [tenant.id, tz]);

  const loadReports = useCallback(async () => {
    if (!can.edit) return;
    const to = new Date(Date.now() + 60000).toISOString();
    const [d, w] = await Promise.all([
      sb().rpc('analytics', { p_tenant: tenant.id, p_from: zonedMidnight(tz).toISOString(), p_to: to }),
      sb().rpc('analytics', { p_tenant: tenant.id, p_from: zonedMidnight(tz, 13).toISOString(), p_to: to })
    ]);
    setToday(d.data as Report); setSpan(w.data as Report);
  }, [tenant.id, tz, can.edit]);

  useEffect(() => {
    sb().rpc('onboarding_checklist', { p_tenant: tenant.id }).then(({ data }) => setList(data as Checklist));
    loadLive(); loadReports();
    // the service moves on its own: new orders, the kitchen, a chat that needs someone
    const ch = sb().channel('overview-' + tenant.id)
      .on('postgres_changes', { event: '*', schema: 'everwake', table: 'orders', filter: `tenant_id=eq.${tenant.id}` }, () => { loadLive(); })
      .on('postgres_changes', { event: '*', schema: 'everwake', table: 'conversations', filter: `tenant_id=eq.${tenant.id}` }, () => { loadLive(); })
      .subscribe();
    const tick = setInterval(() => { setNow(Date.now()); loadReports(); }, 120000);
    return () => { sb().removeChannel(ch); clearInterval(tick); };
  }, [tenant.id, loadLive, loadReports]);

  // the last fourteen days, every day present (a day with no orders is a zero, not a gap)
  const days = useMemo(() => {
    if (!span) return [];
    const by = new Map(span.by_day.map(d => [d.day, d]));
    return Array.from({ length: 14 }, (_, i) => {
      const date = new Date(zonedMidnight(tz, 13 - i).getTime() + 12 * 3600e3), key = dayKey(date, tz), d = by.get(key);
      return { key, date, orders: Number(d?.orders || 0), revenue: Number(d?.revenue || 0) };
    });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [span, tz, now]);

  const goLive = () => run(async () => {
    const { data, error } = await sb().rpc('go_live', { p_tenant: tenant.id });
    if (error) throw new Error(error.message);
    if (!(data as { live: boolean }).live) throw new Error(t('Finish the required steps first.'));
    window.location.reload();
  }, t('You are live! Every customer who writes now reaches the agent.'));

  if (!list) return <Spinner />;
  const required = list.items.filter(i => i.required);
  const done = required.filter(i => i.done).length;
  const next = required.find(i => !i.done) || list.items.find(i => !i.done);
  const later = list.items.filter(i => !i.required && !i.done);

  const hour = Number(new Intl.DateTimeFormat('en-US', { timeZone: tz, hour: 'numeric', hourCycle: 'h23' }).format(now));
  const greeting = hour >= 5 && hour < 12 ? t('Good morning') : hour >= 12 && hour < 17 ? t('Good afternoon') : t('Good evening');
  const name = (lang === 'ar' ? tenant.name_ar : tenant.name_en) || tenant.name_ar;
  const fmtDay = (d: Date, long = false) => new Intl.DateTimeFormat(locale, long ? { weekday: 'long', day: 'numeric', month: 'long', timeZone: tz }
                                                                                : { day: 'numeric', month: 'short', timeZone: tz }).format(d);
  const fmtHour = (h: number) => new Intl.DateTimeFormat(locale, { hour: 'numeric', hour12: true, timeZone: 'UTC' }).format(new Date(Date.UTC(2020, 0, 1, h)));

  // today against the same day last week
  const lastWeek = days[6];
  const lastWeekday = lastWeek ? new Intl.DateTimeFormat(locale, { weekday: 'long', timeZone: tz }).format(lastWeek.date) : '';
  const delta = (cur: number, prev: number) => (prev > 0 ? Math.round(((cur - prev) / prev) * 100) : null);
  const avg = (d: { orders: number; revenue: number }) => (d.orders ? d.revenue / d.orders : 0);
  const kpis = today && span && lastWeek ? [
    { key: 'orders', label: t('Orders today'), value: today.orders, fmt: (v: number) => String(v), icon: ShoppingBag,
      d: delta(today.orders, lastWeek.orders), spark: days.map(x => x.orders) },
    { key: 'revenue', label: t('Revenue today'), value: Number(today.revenue), fmt: m, icon: Banknote,
      d: delta(Number(today.revenue), lastWeek.revenue), spark: days.map(x => x.revenue) },
    { key: 'avg', label: t('Average order'), value: Number(today.average_order), fmt: m, icon: Receipt,
      d: delta(Number(today.average_order), avg(lastWeek)), spark: days.map(avg) },
    { key: 'conv', label: t('Chats that ordered'), value: Number(today.conversion_percent), fmt: (v: number) => `${v}%`, icon: MessageCircle,
      d: today.conversations && Number(today.conversion_percent) <= 100 && Number(span.conversion_percent) <= 100
        ? Math.round(Number(today.conversion_percent) - Number(span.conversion_percent)) : null, pts: true,
      sub: t('{n} chats today', { n: today.conversations }) }
  ] : [];

  // hours: today's orders against a usual day of the last two weeks
  const hours = (() => {
    if (!today || !span) return [];
    const td = new Map(today.by_hour.map(h => [h.hour, Number(h.orders)])), us = new Map(span.by_hour.map(h => [h.hour, Number(h.orders) / 14]));
    const active = [...td.keys(), ...us.keys()];
    if (!active.length) return [];
    const from = Math.min(...active, hour), to = Math.max(...active, hour);
    return Array.from({ length: to - from + 1 }, (_, i) => from + i).map(h => ({ h, label: fmtHour(h), long: fmtHour(h), value: td.get(h) || 0, usual: us.get(h) || 0 }));
  })();
  const sources = span?.by_source || [];
  const SRC: Record<string, { label: string; color: string }> = {
    whatsapp: { label: t('WhatsApp agent'), color: 'var(--color-gold-ink)' }, qr: { label: t('QR in the branch'), color: 'var(--color-navy-soft)' },
    team: { label: t('Added by the team'), color: 'var(--ui-tint-ink-4, #6b7c86)' } };
  const METHOD: Record<string, { label: string; color: string }> = {
    delivery: { label: t('Delivery'), color: 'var(--color-gold-ink)' }, pickup: { label: t('Pickup'), color: 'var(--color-navy-soft)' },
    dine_in: { label: t('Dine-in'), color: 'var(--ui-tint-ink-2, #6b7c86)' } };
  const spanOrders = span ? Number(span.orders) : 0;

  const services = live ? [
    { key: 'waiting', n: live.waiting, label: t('waiting'), icon: Clock, tone: live.waiting ? 'bg-critical text-white' : 'bg-white text-ink', href: '/orders' },
    { key: 'cooking', n: live.cooking, label: t('in the kitchen'), icon: ChefHat, tone: 'bg-white text-ink', href: '/kitchen' },
    { key: 'ready', n: live.ready, label: t('ready'), icon: CheckCircle2, tone: 'bg-white text-ink', href: '/kitchen' }
  ] : [];
  const story = !live ? '' : live.waiting || attention.length
    ? [live.waiting ? t('{n} orders are waiting for you', { n: live.waiting }) : '', attention.length ? t('{n} chats need a person', { n: attention.length }) : '']
        .filter(Boolean).join(lang === 'ar' ? '، و' : ', and ') + '.'
    : live.cooking ? t('The kitchen has {n} orders on the go and nothing is waiting for you.', { n: live.cooking })
    : t('Everything is handled: the agent is answering and nothing is waiting for you.');

  return (
    <div className="space-y-5 pb-4">
      {/* the restaurant right now */}
      <section className="ew-card ew-tint-1 relative overflow-hidden p-6 lg:p-8">
        <div className="flex flex-wrap items-center gap-6">
          <div className="min-w-0 flex-1 basis-80">
            <h1 className="text-[28px] font-bold leading-tight tracking-[-0.02em] text-ink sm:text-[32px]">{greeting}{lang === 'ar' ? '، ' : ', '}{name}</h1>
            <p className="mt-2 max-w-xl text-[15px] leading-relaxed text-ink/75">
              {tenant.status === 'live' ? story : t('You are getting ready to go live. Finish the steps below and the agent starts taking orders.')}
            </p>
            <div className="mt-5 flex flex-wrap gap-2">
              <Link href={`${base}/orders`}><Button variant="gold"><ShoppingBag className="size-4" /> {t('Open the board')}</Button></Link>
              <Link href={`${base}/inbox${attention.length ? '?filter=attention' : ''}`}><Button variant="outline"><MessageCircle className="size-4" /> {t('Open the inbox')}</Button></Link>
            </div>
          </div>
          {live && (
            <div className="flex flex-col items-stretch gap-2.5 sm:min-w-64">
              <div className="grid grid-cols-3 gap-2">
                {services.map((x, i) => (
                  <Link key={x.key} href={base + x.href} style={{ animationDelay: `${i * 60}ms` }}
                    className={cx('ew-rise ew-lift flex flex-col items-center gap-0.5 rounded-[var(--ui-radius-inner)] px-3 py-3 shadow-[0_8px_20px_-14px_rgba(0,0,0,0.4)]', x.tone)}>
                    <x.icon className="size-4 opacity-70" aria-hidden />
                    <span key={x.n} className="ew-pop text-2xl font-bold tabular-nums">{x.n}</span>
                    <span className="text-xs opacity-80">{x.label}</span>
                  </Link>
                ))}
              </div>
              {live.last && (
                <p key={live.last.order_no} className="ew-pop flex items-center gap-2 rounded-full bg-white/80 px-3 py-1.5 text-xs text-ink shadow-[0_6px_16px_-12px_rgba(0,0,0,0.4)]">
                  <span className="ew-live size-2 shrink-0 rounded-full bg-positive" aria-hidden />
                  <span className="truncate">{t('Last order')} <b><bdi>{live.last.order_no}</bdi></b> {timeAgo(live.last.placed_at)}</span>
                  <b className="ms-auto shrink-0 tabular-nums">{m(live.last.total)}</b>
                </p>
              )}
            </div>
          )}
          {brand.logo_url && (
            <img src={brand.logo_url} alt="" crossOrigin="anonymous" aria-hidden
              className="pointer-events-none absolute -bottom-10 -end-10 hidden size-44 rounded-full bg-white/50 object-contain p-4 opacity-25 2xl:block" />
          )}
        </div>
      </section>

      {tenant.status !== 'live' && (
        <Card title={<span className="flex items-center gap-2"><Rocket className="size-4 text-gold-ink" /> {t('Go-live checklist — {done} of {total} required steps done', { done, total: required.length })}</span>}
          action={can.owner && <Button variant="gold" size="sm" disabled={!list.ready} busy={busy} onClick={goLive}>{t('Go live')}</Button>}>
          <p className="mb-4 text-sm text-muted">{t('Until you go live, only the test numbers in Settings → Ordering rules reach the agent — your staff keep answering everyone else from the phone as usual.')}</p>
          <ol className="divide-y divide-hairline">
            {list.items.map((i, n) => {
              const isNext = next?.key === i.key;
              return (
                <li key={i.key} className={cx('flex items-start gap-3 py-3', isNext && '-mx-3 rounded-[var(--ui-radius-inner)] bg-gold-wash px-3')}>
                  {i.done ? <CheckCircle2 className="mt-0.5 size-5 shrink-0 text-positive" aria-label={t('Done')} />
                    : <span className="mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-full border border-hairline text-xs text-muted" aria-hidden>{n + 1}</span>}
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-medium">{t(i.label)} {!i.required && <span className="font-normal text-muted">{t('(recommended)')}</span>}
                      {isNext && <Badge tone="gold" className="ms-2">{t('Start here')}</Badge>}</p>
                    {WHY[i.key] && <p className="text-sm text-muted">{t(WHY[i.key])}</p>}
                    {i.detail && i.key !== 'profile' && <p className="text-xs text-muted">{detailText(t, i.key, i.detail)}</p>}
                  </div>
                  {isNext
                    ? <Link href={`${base}/${i.href}`}><Button size="sm" variant="gold">{t('Set up')}</Button></Link>
                    : <Link href={`${base}/${i.href}`} className="shrink-0 text-sm font-medium text-gold-ink hover:underline">{i.done ? t('Edit') : t('Set up')}</Link>}
                </li>
              );
            })}
          </ol>
        </Card>
      )}

      {/* today, against the same day last week */}
      {kpis.length > 0 && (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
          {kpis.map((k, i) => (
            <div key={k.key} className={cx('ew-card ew-lift ew-rise p-5', `ew-tint-${i + 1}`)} style={{ animationDelay: `${i * 60}ms` }}>
              <div className="flex items-start justify-between gap-3">
                <span className="flex size-10 items-center justify-center rounded-[14px] text-white shadow-[0_8px_16px_-10px_rgba(0,0,0,0.5)]"
                  style={{ background: `var(--ui-tint-ink-${i + 1}, var(--color-gold-ink))` }}><k.icon className="size-5" aria-hidden /></span>
                {k.spark && <Sparkline values={k.spark} color={`var(--ui-tint-ink-${i + 1}, var(--color-gold-ink))`} />}
              </div>
              <p className="mt-4 text-sm text-ink/70">{k.label}</p>
              <p className="mt-0.5 text-[28px] font-bold leading-tight tracking-[-0.02em] text-ink"><CountUp value={k.value} format={k.fmt} /></p>
              <p className="mt-1 flex items-center gap-1 text-xs text-ink/70">
                {k.d === null ? (k.sub || t('No orders last {day} to compare', { day: lastWeekday }))
                  : <>
                      <span className={cx('flex items-center gap-0.5 font-semibold', k.d >= 0 ? 'text-positive' : 'text-critical')}>
                        {k.d >= 0 ? <ArrowUpRight className="size-3.5" aria-hidden /> : <ArrowDownRight className="size-3.5" aria-hidden />}
                        {k.d >= 0 ? '+' : ''}{k.d}{k.pts ? ' ' + t('pts') : '%'}
                      </span>
                      {k.pts ? t('against your two-week average') : t('against last {day}', { day: lastWeekday })}
                    </>}
              </p>
            </div>
          ))}
        </div>
      )}

      {span && days.length > 0 && (
        <div className="grid gap-4 xl:grid-cols-3">
          <Card className="xl:col-span-2" title={metric === 'revenue' ? t('Revenue, last 14 days') : t('Orders, last 14 days')}
            action={<Tabs size="sm" value={metric} onChange={setMetric} tabs={[{ value: 'revenue', label: t('Revenue') }, { value: 'orders', label: t('Orders') }]} />}>
            <p className="-mt-1 mb-3 text-sm text-muted">
              {metric === 'revenue' ? t('{v} in two weeks', { v: m(Number(span.revenue)) }) : t('{n} orders in two weeks', { n: spanOrders })}
            </p>
            <AreaChart key={metric} format={metric === 'revenue' ? (v => m(v)) : (v => String(v))}
              points={days.map(d => ({ label: fmtDay(d.date), long: fmtDay(d.date, true), value: metric === 'revenue' ? d.revenue : d.orders }))} />
          </Card>
          <Card title={t('Where orders come from')}>
            {spanOrders === 0 ? <p className="text-sm text-muted">{t('No orders in the last two weeks yet.')}</p> : (
              <div className="space-y-6">
                <Ring parts={sources.map(x => ({ label: SRC[x.source]?.label || x.source, value: Number(x.orders), color: SRC[x.source]?.color || 'var(--color-muted)' }))}
                  center={<><span className="text-2xl font-bold tabular-nums text-ink">{spanOrders}</span><span className="text-xs text-muted">{t('orders')}</span></>} />
                <div>
                  <p className="mb-2 text-sm font-medium text-ink">{t('How they were served')}</p>
                  <SplitBar parts={(span.by_method || []).map(x => ({ label: METHOD[x.method]?.label || x.method, value: Number(x.orders), color: METHOD[x.method]?.color || 'var(--color-muted)' }))} />
                </div>
              </div>
            )}
          </Card>
        </div>
      )}

      {span && today && (
        <div className="grid gap-4 xl:grid-cols-3">
          <Card className="xl:col-span-2" title={t('Busy hours today')}
            action={<span className="flex items-center gap-3 text-xs text-muted">
              <span className="flex items-center gap-1.5"><span className="size-2.5 rounded-sm bg-gold-ink" aria-hidden />{t('Today')}</span>
              <span className="flex items-center gap-1.5"><span className="size-2.5 rounded-sm bg-ink/10" aria-hidden />{t('A usual day')}</span>
            </span>}>
            {hours.length === 0 ? <p className="text-sm text-muted">{t('The hours fill in as orders come.')}</p>
              : <Columns bars={hours} format={v => String(v)} now={hours.findIndex(x => x.h === hour)} />}
          </Card>
          <Card title={t('Dishes that sell')} action={<Link href={`${base}/analytics`} className="text-sm text-gold-ink hover:underline">{t('All reports')}</Link>}>
            {span.top_items.length === 0 ? <p className="text-sm text-muted">{t('No dishes sold in the last two weeks yet.')}</p>
              : <RankList format={m} rows={span.top_items.slice(0, 5).map(x => ({ label: x.name, value: Number(x.revenue), sub: `×${Number(x.quantity)}` }))} />}
          </Card>
        </div>
      )}

      <div className={cx('grid gap-4', span ? 'xl:grid-cols-3' : 'lg:grid-cols-2')}>
        <Card title={t('Orders waiting to be accepted')} action={<Link href={`${base}/orders`} className="text-sm text-gold-ink hover:underline">{t('Open the board')}</Link>}>
          {waiting.length === 0 ? <p className="text-sm text-muted">{t('Nothing waiting. New orders ring here and on every page.')}</p> : (
            <ul className="space-y-1.5">
              {waiting.map(o => (
                <li key={o.id}>
                  <Link href={`${base}/orders?o=${o.id}`} className="flex items-center gap-3 rounded-[var(--ui-radius-inner)] px-2 py-2 text-sm transition-colors hover:bg-paper">
                    <span className="flex size-9 shrink-0 items-center justify-center rounded-full bg-gold-wash text-gold-ink"><ShoppingBag className="size-4" aria-hidden /></span>
                    <span className="min-w-0 flex-1"><b className="block"><bdi>{o.order_no}</bdi></b><span className="block truncate text-xs text-muted"><bdi>{displayName(o.customer as never)}</bdi> · {timeAgo(o.placed_at)}</span></span>
                    <span className="font-semibold tabular-nums">{m(o.total)}</span>
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </Card>
        <Card title={t('Conversations that need a person')} action={<Link href={`${base}/inbox?filter=attention`} className="text-sm text-gold-ink hover:underline">{t('Open the inbox')}</Link>}>
          {attention.length === 0 ? <p className="text-sm text-muted">{t('The agent has everything under control.')}</p> : (
            <ul className="space-y-1.5">
              {attention.map(c => (
                <li key={c.id}>
                  <Link href={`${base}/inbox?c=${c.id}`} className="flex items-center gap-3 rounded-[var(--ui-radius-inner)] px-2 py-2 text-sm transition-colors hover:bg-paper">
                    <span className="flex size-9 shrink-0 items-center justify-center rounded-full bg-critical-wash font-semibold text-critical">{displayName(c.customers).slice(0, 1)}</span>
                    <span className="min-w-0 flex-1"><b className="block truncate"><bdi>{displayName(c.customers)}</bdi></b><span className="block truncate text-xs text-muted" dir="auto">{c.attention_reason || c.last_message_preview}</span></span>
                    <Badge tone="critical">{t('needs you')}</Badge>
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </Card>
        {span && (
          <Card title={t('Last 14 days')}>
            <dl className="grid grid-cols-2 gap-3">
              {([
                [Users, t('New customers'), String(span.new_customers)],
                [TrendingUp, t('Orders from returning customers'), spanOrders ? `${Math.round((Number(span.returning_orders) / spanOrders) * 100)}%` : '—'],
                [Receipt, t('Cancelled or rejected'), String(span.cancelled)],
                [Sparkles, t('Kept from delivery apps ({p}%)', { p: span.commission_percent }), m(Number(span.commission_saved))]
              ] as [typeof Users, string, string][]).map(([Icon, label, v]) => (
                <div key={label} className="rounded-[var(--ui-radius-inner)] bg-paper/70 p-3">
                  <dt className="flex items-start gap-1.5 text-xs leading-snug text-muted"><Icon className="mt-px size-3.5 shrink-0" aria-hidden /><span>{label}</span></dt>
                  <dd className="mt-1 text-lg font-bold tabular-nums text-ink">{v}</dd>
                </div>
              ))}
            </dl>
          </Card>
        )}
      </div>

      {tenant.status === 'live' && can.edit && later.length > 0 && (
        <Card title={t('Worth doing next')}>
          <ul className="grid gap-2 md:grid-cols-2">
            {later.map(i => (
              <li key={i.key}>
                <Link href={`${base}/${i.href}`} className="ew-lift flex items-start gap-3 rounded-[var(--ui-radius-inner)] bg-paper/70 p-3">
                  <span className="min-w-0 flex-1">
                    <span className="block text-sm font-medium text-ink">{t(i.label)}</span>
                    {WHY[i.key] && <span className="block text-sm text-muted">{t(WHY[i.key])}</span>}
                  </span>
                  <span className="shrink-0 text-sm font-medium text-gold-ink">{t('Set up')}</span>
                </Link>
              </li>
            ))}
          </ul>
        </Card>
      )}
    </div>
  );
}
