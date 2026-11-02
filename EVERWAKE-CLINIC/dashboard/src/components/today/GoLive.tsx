'use client';
import { Check, ChevronRight, Rocket } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useState } from 'react';
import { cx } from '@/lib/format';
import { useLang } from '@/lib/i18n';
import { sb } from '@/lib/supabase/client';
import { Button, useAction } from '../ui';
import { useTenant } from '../tenant';

interface Item { key: string; label: string; required: boolean; done: boolean; detail?: string; href: string }
interface Checklist { status: string; items: Item[]; ready: boolean }

// Until the clinic goes live only test numbers reach the assistant. This is what is left, in order.
export function GoLive() {
  const { tenant, base, can } = useTenant();
  const { t } = useLang();
  const router = useRouter();
  const { busy, run } = useAction();
  const [c, setC] = useState<Checklist | null>(null);
  const load = useCallback(async () => {
    const { data } = await sb().rpc('onboarding_checklist', { p_tenant: tenant.id });
    setC(data as Checklist);
  }, [tenant.id]);
  useEffect(() => { load(); }, [load]);
  // "2 of 3 doctors have a schedule" from the database, in the dashboard's language
  const detail = (d: string) => {
    const m = d.match(/^(\d+) of (\d+) (doctors have a schedule|services have a price)$/);
    return m ? t(m[3] === 'doctors have a schedule' ? '{a} of {b} doctors have a schedule' : '{a} of {b} services have a price', { a: m[1], b: m[2] }) : d;
  };
  if (!c) return null;
  const done = c.items.filter(i => i.done).length;
  const live = async () => {
    const r = await run(async () => {
      const { data, error } = await sb().rpc('go_live', { p_tenant: tenant.id, p_force: false });
      if (error) throw new Error(error.message);
      return data as { live: boolean };
    });
    if (r?.live) router.refresh();
  };
  return (
    <section className="card overflow-hidden">
      <div className="flex flex-wrap items-center gap-4 px-4 py-3.5 sm:px-5">
        <div className="min-w-0 flex-1">
          <h2 className="text-[15px] font-semibold">{t('Getting the clinic ready')}</h2>
          <p className="text-[13px] text-muted">{t('{done} of {n} done. Until you go live, only test numbers reach the assistant.', { done, n: c.items.length })}</p>
        </div>
        <div className="h-1.5 w-40 overflow-hidden rounded-full bg-rule max-sm:w-full">
          <span className="c-bar block h-full rounded-full bg-accent" style={{ width: `${(done / c.items.length) * 100}%` }} />
        </div>
        {can.owner && <Button variant="accent" disabled={!c.ready} busy={busy} onClick={live}><Rocket className="size-4" aria-hidden />{t('Go live')}</Button>}
      </div>
      <ol className="grid border-t border-rule sm:grid-cols-2 lg:grid-cols-4">
        {c.items.map((i, n) => (
          <li key={i.key} className="border-b border-rule sm:border-e lg:[&:nth-child(4n)]:border-e-0">
            <Link href={`${base}/${i.href}`} className="group flex h-full items-start gap-2.5 px-4 py-3 hover:bg-raised">
              <span className={cx('mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-full text-[11px] font-semibold',
                i.done ? 'bg-positive text-white' : 'ring-1 ring-inset ring-control text-muted')}>
                {i.done ? <Check className="size-3" aria-hidden /> : n + 1}
              </span>
              <span className="min-w-0 flex-1">
                <span className={cx('block text-[13px] font-medium', i.done && 'text-muted line-through decoration-faint/50')}>{t(i.label)}{!i.required && <span className="ms-1 font-normal text-faint">· {t('optional')}</span>}</span>
                {i.detail && !i.done && <span className="block text-xs text-muted">{detail(i.detail)}</span>}
              </span>
              <ChevronRight className="mt-0.5 size-4 shrink-0 text-faint opacity-0 transition-opacity group-hover:opacity-100 rtl:rotate-180" aria-hidden />
            </Link>
          </li>
        ))}
      </ol>
    </section>
  );
}
