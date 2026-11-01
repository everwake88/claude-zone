'use client';
import { ArrowDownRight, ArrowUpRight, Camera, Flame, Layers, Star } from 'lucide-react';
import { Sparkline } from '@/components/charts';
import { StockButton } from '@/components/menu/StockButton';
import { Switch } from '@/components/ui';
import { cx, money } from '@/lib/format';
import { useLang } from '@/lib/i18n';
import type { Branch, Item } from '@/lib/types';

// a dish's sales from the database (menu_insights), when the owner can see them
export interface Sales { sold: number; prev_sold: number; revenue: number; orders: number; last_at: string | null; weeks: number[] }

// One dish as the customer meets it: its photo first, its name and price, and how it is selling.
// The photo and the name open the dish; the stock button and the branch switch act in place.
export function DishCard({ i, photo, sales, best, stock, outLabel, choices, sym, branch, branchPrice, served, here, canEdit, busy, onOpen, onServed, onStock, delay = 0 }: {
  i: Item; photo?: string; sales?: Sales | null; best: boolean; stock: { available: boolean; soldOutUntil: string | null }; outLabel?: string; choices: number; sym: string;
  branch: Branch | null; branchPrice: number | null; served: boolean; here: boolean; canEdit: boolean; busy: boolean;
  onOpen: () => void; onServed: (v: boolean) => void; onStock: () => void; delay?: number;
}) {
  const { t, lang } = useLang();
  const out = !stock.available || (!!stock.soldOutUntil && new Date(stock.soldOutUntil) > new Date());
  const name = lang === 'en' && i.name_en ? i.name_en : i.name_ar, other = lang === 'en' && i.name_en ? i.name_ar : i.name_en;
  const price = branchPrice ?? i.price;
  const sold = sales ? Number(sales.sold) : null, prevSold = sales ? Number(sales.prev_sold) : 0;
  const trend = sold !== null && prevSold > 0 ? Math.round(((sold - prevSold) / prevSold) * 100) : null;
  return (
    <article className={cx('ew-card ew-lift ew-rise group flex flex-col overflow-hidden', !here && 'opacity-60')} style={{ animationDelay: `${Math.min(delay, 12) * 30}ms` }}>
      <button type="button" onClick={onOpen} disabled={!canEdit} className="block text-start focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-gold/60">
        <div className="relative aspect-[4/3] overflow-hidden bg-paper-sunk">
          {photo ? (
            <img src={photo} alt="" loading="lazy" decoding="async"
              className={cx('size-full object-cover transition-transform duration-500 ease-out group-hover:scale-[1.04]', out && 'grayscale')} />
          ) : (
            <span className="flex size-full flex-col items-center justify-center gap-1.5 border-b-2 border-dashed border-hairline text-muted">
              <Camera className="size-6" aria-hidden /><span className="text-xs font-medium">{t('Add a photo')}</span>
            </span>
          )}
          <span className="absolute start-2.5 top-2.5 flex flex-wrap gap-1.5">
            {best && <span className="inline-flex items-center gap-1 rounded-full bg-navy/90 px-2 py-0.5 text-[11px] font-semibold text-white backdrop-blur-sm"><Flame className="size-3" aria-hidden />{t('Best seller')}</span>}
            {i.is_signature && <span className="inline-flex items-center gap-1 rounded-full bg-gold px-2 py-0.5 text-[11px] font-semibold text-on-gold"><Star className="size-3 fill-current" aria-hidden />{t('Signature')}</span>}
          </span>
          {out && <span className="absolute bottom-2.5 start-2.5 rounded-full bg-critical px-2 py-0.5 text-[11px] font-semibold text-white">{outLabel || t('Sold out')}</span>}
        </div>
        <div className="px-4 pt-3.5">
          <div className="flex flex-col gap-1 sm:flex-row sm:items-start sm:justify-between sm:gap-3">
            <div className="min-w-0">
              <h3 className="truncate font-semibold text-ink"><bdi>{name}</bdi></h3>
              <p className="truncate text-xs text-muted">{other ? <bdi>{other}</bdi> : <span dir="ltr">{i.code}</span>}</p>
            </div>
            <p className="shrink-0 font-bold tabular-nums text-ink sm:text-end">
              {price == null ? <span className="text-sm font-medium text-muted">{t('branch confirms')}</span> : money(price, sym)}
              {i.unit === 'kg' && <span className="text-xs font-normal text-muted"> / {t('kg')}</span>}
              {branch && branchPrice != null && branchPrice !== i.price && <span className="block text-[11px] font-normal text-gold-ink">{t('this branch’s price')}</span>}
            </p>
          </div>
        </div>
      </button>

      {/* how it is selling: the last 30 days against the 30 before, eight weeks drawn */}
      <div className="flex min-h-10 items-center justify-between gap-2 px-4 pt-2">
        {sold === null ? <span className="text-xs text-muted">{choices ? <span className="inline-flex items-center gap-1"><Layers className="size-3.5" aria-hidden />{choices > 1 ? t('{n} choices', { n: choices }) : t('1 choice')}</span> : ''}</span>
          : sold > 0 ? (
            <span className="flex min-w-0 flex-wrap items-center gap-x-1.5 whitespace-nowrap text-xs">
              <b className="tabular-nums text-ink">{t('{n} sold', { n: +sold.toFixed(2) })}</b>
              {trend !== null && trend !== 0 && (
                <span className={cx('inline-flex items-center font-semibold tabular-nums', trend > 0 ? 'text-positive' : 'text-critical')}>
                  {trend > 0 ? <ArrowUpRight className="size-3.5" aria-hidden /> : <ArrowDownRight className="size-3.5" aria-hidden />}{Math.abs(trend)}%
                </span>
              )}
            </span>
          ) : <span className="text-xs text-muted">{t('Not ordered in 30 days')}</span>}
        {sales && sales.weeks.some(v => Number(v) > 0) && <Sparkline values={sales.weeks.map(Number)} className="hidden h-6 w-16 shrink-0 sm:block" />}
      </div>

      <div className="mt-auto flex items-center gap-2 px-4 pb-3.5 pt-2.5">
        <StockButton itemId={i.id} branchId={branch?.id} available={stock.available} soldOutUntil={stock.soldOutUntil} onDone={onStock} />
        {branch && <span className="ms-auto flex items-center gap-1.5 text-xs text-muted">{t('Served here')}<Switch checked={served} disabled={!canEdit || busy} label={t('Served here')} onChange={onServed} /></span>}
      </div>
    </article>
  );
}
