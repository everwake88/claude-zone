'use client';
import { CalendarDays, CheckCircle2, ChefHat, Clock, CreditCard, MapPin, Pause, Pencil, Phone, Play, Truck, UtensilsCrossed } from 'lucide-react';
import Link from 'next/link';
import type { ReactNode } from 'react';
import { Sparkline } from '@/components/charts';
import { Button, CountUp, Switch } from '@/components/ui';
import { clock, cx, money, timeAgo } from '@/lib/format';
import { today as todayOf } from '@/lib/hours';
import { useLang } from '@/lib/i18n';
import type { Branch } from '@/lib/types';

// one branch right now, from the database (branch_board); fields are missing until the update runs
export interface BoardRow {
  id: string; state: string; busy_until?: string | null;
  today?: { orders: number; revenue: number | null; avg: number | null };
  live?: { waiting: number; cooking: number; ready: number; out: number };
  cook_min?: number | null; last_order_at?: string | null; days14?: number[];
}

export const STATE: Record<string, { label: string; dot: string; pill: string }> = {
  open: { label: 'Open now', dot: 'bg-positive', pill: 'bg-positive-wash text-positive' },
  busy: { label: 'Paused (busy)', dot: 'bg-caution', pill: 'bg-caution-wash text-caution' },
  closed: { label: 'Closed now', dot: 'bg-muted/60', pill: 'bg-paper-sunk text-muted' },
  not_accepting: { label: 'Not taking orders', dot: 'bg-critical', pill: 'bg-critical-wash text-critical' },
  unknown: { label: 'No hours set', dot: 'bg-muted/60', pill: 'bg-paper-sunk text-muted' }
};

// "closes in 3 h 10 min" / "opens at 12 pm", from the opening hours and the clock
export function useHoursLine() {
  const { t, lang } = useLang();
  const locale = lang === 'ar' ? 'ar-EG-u-nu-latn' : 'en-GB';
  const at = (m: number) => new Intl.DateTimeFormat(locale, { hour: 'numeric', minute: m % 60 ? '2-digit' : undefined, hour12: true, timeZone: 'UTC' })
    .format(new Date(Date.UTC(2020, 0, 1, Math.floor(m / 60), m % 60)));
  const span = (m: number) => m >= 60 ? (m % 60 ? t('{h} h {m} min', { h: Math.floor(m / 60), m: m % 60 }) : t('{h} h', { h: m / 60 })) : t('{n} min', { n: m });
  return (b: Branch, row: BoardRow | undefined, tz: string, now: number) => {
    const h = todayOf(b.hours, tz, new Date(now));
    const state = row?.state || 'unknown';
    if (state === 'busy' && b.busy_until) return t('Paused until {time}', { time: clock(b.busy_until, tz) });
    if (state === 'not_accepting') return t('Switched off — the agent offers another branch');
    if (!h.known) return t('Add opening hours so the agent knows when to take orders');
    if (!h.change) return h.open ? t('Open all day') : t('Closed today');
    return h.change.kind === 'closes'
      ? (h.change.in <= 60 ? t('Closes in {d}', { d: span(h.change.in) }) : t('Open until {time}', { time: at(h.change.at) }))
      : (h.change.in <= 120 ? t('Opens in {d}', { d: span(h.change.in) }) : t('Opens at {time}', { time: at(h.change.at) }));
  };
}

// today on a 24-hour strip: the open hours filled, a marker where the clock is
export function DayStrip({ b, tz, now, className }: { b: Branch; tz: string; now: number; className?: string }) {
  const { lang } = useLang();
  const h = todayOf(b.hours, tz, new Date(now));
  const hr = (x: number) => new Intl.DateTimeFormat(lang === 'ar' ? 'ar-EG-u-nu-latn' : 'en-GB', { hour: 'numeric', hour12: true, timeZone: 'UTC' })
    .format(new Date(Date.UTC(2020, 0, 1, x % 24)));
  if (!h.known) return null;
  return (
    <div className={cx('relative', className)} dir="ltr" aria-hidden>
      <div className="relative h-2 overflow-hidden rounded-full bg-paper-sunk">
        {h.spans.map(([a, z]) => (
          <span key={a} className="absolute inset-y-0 rounded-full bg-[color-mix(in_oklab,var(--color-positive)_55%,var(--color-paper))]"
            style={{ left: `${(a / 1440) * 100}%`, width: `${((z - a) / 1440) * 100}%` }} />
        ))}
      </div>
      <span className="absolute -top-1 h-4 w-[2px] -translate-x-1/2 rounded-full bg-ink" style={{ left: `${(h.now / 1440) * 100}%` }} />
      <div className="mt-1 flex justify-between text-[10px] text-muted">{[0, 6, 12, 18, 24].map(x => <span key={x}>{hr(x)}</span>)}</div>
    </div>
  );
}

export function BranchCard({ b, row, tz, sym, now, base, canEdit, canMoney, busy, onAccepting, onPause, onResume, onEdit, payName, restPay }: {
  b: Branch; row?: BoardRow; tz: string; sym: string; now: number; base: string; canEdit: boolean; canMoney: boolean; busy: boolean;
  onAccepting: (v: boolean) => void; onPause: () => void; onResume: () => void; onEdit: () => void; payName: (m: string) => string; restPay: string[];
}) {
  const { t, lang } = useLang();
  const hoursLine = useHoursLine();
  const state = row?.state || 'unknown', st = STATE[state] || STATE.unknown;
  const name = lang === 'ar' ? b.name_ar : b.name_en || b.name_ar, other = lang === 'ar' ? b.name_en : b.name_ar;
  const live = row?.live, today = row?.today;
  const queue = live ? [
    { key: 'waiting', n: live.waiting, label: t('waiting'), icon: Clock, href: `${base}/orders?branch=${b.id}`, hot: live.waiting > 0 },
    { key: 'cooking', n: live.cooking, label: t('in the kitchen'), icon: ChefHat, href: `${base}/kitchen` },
    { key: 'ready', n: live.ready, label: t('ready'), icon: CheckCircle2, href: `${base}/kitchen` },
    ...(b.delivery_enabled ? [{ key: 'out', n: live.out, label: t('on the way'), icon: Truck, href: `${base}/orders?branch=${b.id}` }] : [])
  ] : [];
  const facts: { icon: typeof Clock; text: string }[] = [
    { icon: Truck, text: b.delivery_enabled ? t('Delivery {fee}', { fee: b.delivery_fee != null ? money(b.delivery_fee, sym) : t('(fee by zone)') }) : t('No delivery') },
    ...(b.pickup_enabled ? [{ icon: CheckCircle2, text: t('Pickup') }] : []),
    ...(b.dine_in != null ? [{ icon: UtensilsCrossed, text: b.dine_in ? t('Seating') : t('No seating') }] : []),
    ...(b.reservations !== 'off' ? [{ icon: CalendarDays, text: b.reservations === 'whatsapp' ? t('Bookings on WhatsApp') : t('Bookings by phone') }] : []),
    { icon: CreditCard, text: (b.payment_methods || restPay).map(payName).join('، ') },
    ...(b.phone ? [{ icon: Phone, text: b.phone }] : [])
  ];
  return (
    <article className={cx('ew-card ew-lift flex flex-col p-5', !b.is_active && 'opacity-60')}>
      <header className="flex items-start gap-3">
        <div className="min-w-0 flex-1">
          <h2 className="truncate text-lg font-semibold text-ink"><bdi>{name}</bdi></h2>
          <p className="truncate text-xs text-muted">{other && other !== name && <><bdi>{other}</bdi> · </>}<span dir="ltr">{b.code}</span></p>
        </div>
        <span className={cx('inline-flex shrink-0 items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-semibold', st.pill)}>
          <span className={cx('size-2 rounded-full', st.dot, state === 'open' && 'ew-live')} aria-hidden />{t(st.label)}
        </span>
      </header>
      <p className="mt-1.5 text-sm text-ink/75">{hoursLine(b, row, tz, now)}</p>
      <DayStrip b={b} tz={tz} now={now} className="mt-3" />

      {today && (
        <div className="mt-4 grid grid-cols-3 gap-2">
          <Figure label={t('Orders today')}><CountUp value={Number(today.orders)} /></Figure>
          {canMoney && today.revenue != null
            ? <Figure label={t('Revenue today')}><CountUp value={Number(today.revenue)} format={v => money(v, sym)} /></Figure>
            : <Figure label={t('Average order')}>—</Figure>}
          <Figure label={t('Cooks in')}>{row?.cook_min != null ? t('{n} min', { n: Math.round(Number(row.cook_min)) }) : '—'}</Figure>
        </div>
      )}

      {queue.length > 0 && (
        <div className="mt-3 flex flex-wrap gap-1.5">
          {queue.map(q => (
            <Link key={q.key} href={q.href}
              className={cx('inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium transition-[background-color,transform] duration-150 active:scale-[.97]',
                q.hot ? 'bg-critical text-white' : q.n ? 'bg-gold-wash text-gold-ink hover:bg-gold-line/50' : 'bg-paper-sunk text-muted hover:text-ink')}>
              <q.icon className="size-3.5" aria-hidden /><b className="tabular-nums">{q.n}</b> {q.label}
            </Link>
          ))}
        </div>
      )}

      {row?.days14 && (
        <div className="mt-4 flex items-end justify-between gap-3">
          <div className="min-w-0 text-xs text-muted">
            <p>{t('Orders, last 14 days: {n}', { n: row.days14.reduce((s, v) => s + Number(v), 0) })}</p>
            <p>{row.last_order_at ? t('Last order {ago}', { ago: timeAgo(row.last_order_at) }) : t('No orders yet')}</p>
          </div>
          {row.days14.some(v => Number(v) > 0) && <Sparkline values={row.days14.map(Number)} className="shrink-0" />}
        </div>
      )}

      <ul className="mt-4 flex flex-wrap gap-x-3 gap-y-1.5 text-xs text-muted">
        {facts.map(f => <li key={f.text} className="flex min-w-0 items-center gap-1"><f.icon className="size-3.5 shrink-0" aria-hidden /><span className="truncate">{f.text}</span></li>)}
        {b.address_ar && <li className="flex min-w-0 basis-full items-start gap-1"><MapPin className="mt-px size-3.5 shrink-0" aria-hidden /><bdi className="line-clamp-1">{b.address_ar}</bdi></li>}
      </ul>

      <footer className="mt-auto flex flex-wrap items-center gap-2 border-t border-hairline/70 pt-3.5 [margin-top:max(1rem,auto)]">
        <label className="flex items-center gap-2 text-sm text-ink">{t('Taking orders')} <Switch checked={b.accepting_orders} onChange={onAccepting} disabled={busy} /></label>
        <span className="flex-1" />
        {state === 'busy'
          ? <Button size="sm" variant="outline" onClick={onResume}><Play className="size-3.5" /> {t('Resume now')}</Button>
          : <Button size="sm" variant="outline" onClick={onPause} disabled={!b.accepting_orders}><Pause className="size-3.5" /> {t('Too busy')}</Button>}
        <Link href={`${base}/menu?branch=${b.id}`}><Button size="sm" variant="ghost">{t('Menu')}</Button></Link>
        {canEdit && <Button size="sm" variant="ghost" onClick={onEdit} aria-label={t('Edit {name}', { name })}><Pencil className="size-4" /></Button>}
      </footer>
    </article>
  );
}

function Figure({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="min-w-0 rounded-[var(--ui-radius-inner)] bg-paper/70 px-3 py-2.5">
      <p className="truncate text-[11px] text-muted">{label}</p>
      <p className="mt-0.5 truncate text-base font-bold tabular-nums text-ink sm:text-lg">{children}</p>
    </div>
  );
}
