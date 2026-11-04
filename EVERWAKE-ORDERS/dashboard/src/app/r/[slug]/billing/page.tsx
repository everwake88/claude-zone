'use client';
import { ChevronLeft, ChevronRight, Download, QrCode, Receipt, MessageCircle } from 'lucide-react';
import { useMemo, useState } from 'react';
import { Button, Card, Empty, Spinner } from '@/components/ui';
import { useTenant } from '@/components/tenant';
import { cx, money } from '@/lib/format';
import { useLang } from '@/lib/i18n';
import { sb } from '@/lib/supabase/client';
import { useCached } from '@/lib/use-cached';
import { dayKey, zonedDate } from '@/lib/zoned';

interface Row { order_no: string; placed_at: string; channel: 'whatsapp' | 'qr'; name: string | null; phone: string | null; address: string | null;
  items: string | null; branch: string | null; total: number; base: number; fee: number; net: number }
interface Statement {
  rule: { fee_percent: number; include_delivery_fee: boolean; include_vat: boolean; starts_on: string | null };
  totals: { orders: number; sales: number; base: number; fee: number; net: number; whatsapp_orders: number; qr_orders: number };
  rows: Row[];
}

// What the restaurant owes Everwake for a month: every order that came through Everwake (WhatsApp
// and QR), Everwake's percent on each, and the restaurant's share — and the same as an Excel sheet.
export default function BillingPage() {
  const { tenant, can } = useTenant();
  const { t, lang } = useLang();
  const tz = tenant.timezone || 'Africa/Cairo', sym = tenant.currency_symbol;
  const m = (v: number) => money(v, sym);
  const thisMonth = dayKey(new Date(), tz).slice(0, 7);
  const [month, setMonth] = useState(thisMonth);
  const span = useMemo(() => {
    const [y, mo] = month.split('-').map(Number);
    const next = mo === 12 ? `${y + 1}-01` : `${y}-${String(mo + 1).padStart(2, '0')}`;
    return { from: zonedDate(tz, `${month}-01`), to: zonedDate(tz, `${next}-01`) };
  }, [month, tz]);
  const shift = (n: number) => {
    const [y, mo] = month.split('-').map(Number);
    const d = new Date(Date.UTC(y, mo - 1 + n, 1));
    setMonth(`${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`);
  };
  const { data } = useCached(can.edit ? `bill:${tenant.id}:${month}` : null, async () => {
    const { data, error } = await sb().rpc('bill_statement', { p_tenant: tenant.id, p_from: span.from.toISOString(), p_to: span.to.toISOString() });
    if (error) throw new Error(error.message);
    return data as Statement;
  });

  if (!can.edit) return <p className="text-sm text-muted">{t('Bills are for owners and managers.')}</p>;
  const locale = lang === 'ar' ? 'ar-EG-u-nu-latn' : 'en-GB';
  const monthName = new Intl.DateTimeFormat(locale, { month: 'long', year: 'numeric', timeZone: 'UTC' }).format(new Date(`${month}-15T12:00:00Z`));
  const when = (iso: string) => new Intl.DateTimeFormat(locale, { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit', timeZone: tz }).format(new Date(iso));
  const r = data?.rule;
  const pct = r ? `${Number(r.fee_percent)}%` : '';
  const ruleText = r ? t('Everwake takes {p} of each WhatsApp order’s food after discounts{delivery}{vat}, and {p} of each QR order’s total.', {
    p: pct, delivery: r.include_delivery_fee ? t(', with the delivery fee') : t(', without the delivery fee'),
    vat: r.include_vat ? t(' and with VAT') : t(' and without VAT') }) : '';
  const href = `/api/billing/export?tenant=${tenant.id}&from=${encodeURIComponent(span.from.toISOString())}&to=${encodeURIComponent(span.to.toISOString())}&month=${month}&lang=${lang}`;

  return (
    <div className="space-y-5 pb-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="min-w-0">
          <h1 className="text-[28px] font-bold leading-tight tracking-[-0.02em] text-ink">{t('Bills')}</h1>
          <p className="mt-1.5 max-w-3xl text-[15px] leading-relaxed text-ink/75">{ruleText || t('What you owe Everwake for the orders that came through it.')}</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <div className="ew-card flex items-center gap-1 !rounded-full p-1">
            <button type="button" onClick={() => shift(-1)} className="rounded-full p-2 text-muted hover:bg-paper hover:text-ink" aria-label={t('Previous month')}>
              <ChevronLeft className="size-4 rtl:rotate-180" />
            </button>
            <span className="min-w-36 text-center text-sm font-semibold text-ink">{monthName}</span>
            <button type="button" onClick={() => shift(1)} disabled={month >= thisMonth} className="rounded-full p-2 text-muted hover:bg-paper hover:text-ink disabled:opacity-30" aria-label={t('Next month')}>
              <ChevronRight className="size-4 rtl:rotate-180" />
            </button>
          </div>
          <a href={href} download><Button variant="gold" disabled={!data || !data.rows.length}><Download className="size-4" /> {t('Download Excel')}</Button></a>
        </div>
      </div>

      {!data ? <Spinner /> : (
        <>
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            {[
              { label: t('Orders through Everwake'), value: String(data.totals.orders), note: t('{a} on WhatsApp · {b} by QR', { a: data.totals.whatsapp_orders, b: data.totals.qr_orders }), tint: 1 },
              { label: t('Order totals'), value: m(Number(data.totals.sales)), note: t('what customers paid'), tint: 2 },
              { label: t('Everwake’s fee'), value: m(Number(data.totals.fee)), note: t('{p} of {v}', { p: pct, v: m(Number(data.totals.base)) }), tint: 3 },
              { label: t('Your share'), value: m(Number(data.totals.net)), note: t('order totals minus the fee'), tint: 4 }
            ].map((k, i) => (
              <div key={k.label} className={cx('ew-card ew-rise p-5', `ew-tint-${k.tint}`)} style={{ animationDelay: `${i * 50}ms` }}>
                <p className="text-sm text-ink/70">{k.label}</p>
                <p className="mt-1 text-[26px] font-bold leading-tight tracking-[-0.02em] tabular-nums text-ink">{k.value}</p>
                <p className="mt-1 text-xs text-ink/70">{k.note}</p>
              </div>
            ))}
          </div>

          {data.rows.length === 0 ? (
            <Empty title={t('No orders through Everwake in {month}.', { month: monthName })}>{t('Orders placed on WhatsApp or by a QR code in the branch appear here.')}</Empty>
          ) : (
            <Card title={t('Every order, {month}', { month: monthName })} className="overflow-hidden">
              <div className="-m-5 overflow-x-auto">
                <table className="w-full min-w-[900px] text-sm">
                  <thead className="text-xs text-muted">
                    <tr className="border-b border-hairline/70">
                      {[t('Order'), t('Customer'), t('Items'), t('Order total'), t('Everwake’s fee'), t('Your share')].map((h, i) => (
                        <th key={h} className={cx('px-4 py-2.5 font-medium', i >= 3 ? 'text-end' : 'text-start')}>{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-hairline/60">
                    {data.rows.map(o => (
                      <tr key={o.order_no} className="align-top transition-colors hover:bg-paper/60">
                        <td className="whitespace-nowrap px-4 py-3">
                          <span className="flex items-center gap-1.5 font-semibold text-ink">
                            {o.channel === 'qr' ? <QrCode className="size-3.5 text-muted" aria-label="QR" /> : <MessageCircle className="size-3.5 text-muted" aria-label="WhatsApp" />}
                            <bdi>{o.order_no}</bdi>
                          </span>
                          <span className="block text-xs text-muted">{when(o.placed_at)}</span>
                        </td>
                        <td className="max-w-56 px-4 py-3">
                          <span className="block truncate text-ink"><bdi>{o.name || '—'}</bdi></span>
                          <span className="block text-xs text-muted" dir="ltr">{o.phone || ''}</span>
                          {o.address && <span className="block truncate text-xs text-muted"><bdi>{o.address}</bdi></span>}
                        </td>
                        <td className="max-w-72 px-4 py-3 text-ink/80"><span className="line-clamp-2"><bdi>{o.items || '—'}</bdi></span></td>
                        <td className="whitespace-nowrap px-4 py-3 text-end tabular-nums text-ink">{m(Number(o.total))}</td>
                        <td className="whitespace-nowrap px-4 py-3 text-end font-semibold tabular-nums text-gold-ink">{m(Number(o.fee))}</td>
                        <td className="whitespace-nowrap px-4 py-3 text-end tabular-nums text-ink">{m(Number(o.net))}</td>
                      </tr>
                    ))}
                  </tbody>
                  <tfoot>
                    <tr className="border-t border-hairline font-semibold text-ink">
                      <td className="px-4 py-3" colSpan={3}><span className="flex items-center gap-1.5"><Receipt className="size-4 text-muted" aria-hidden />{t('{n} orders', { n: data.totals.orders })}</span></td>
                      <td className="px-4 py-3 text-end tabular-nums">{m(Number(data.totals.sales))}</td>
                      <td className="px-4 py-3 text-end tabular-nums text-gold-ink">{m(Number(data.totals.fee))}</td>
                      <td className="px-4 py-3 text-end tabular-nums">{m(Number(data.totals.net))}</td>
                    </tr>
                  </tfoot>
                </table>
              </div>
            </Card>
          )}
        </>
      )}
    </div>
  );
}
