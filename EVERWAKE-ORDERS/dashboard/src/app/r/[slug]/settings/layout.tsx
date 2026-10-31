'use client';
import { LayoutGrid } from 'lucide-react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useEffect, useRef, type ReactNode } from 'react';
import { SETTINGS_SECTIONS } from '@/components/settings/sections';
import { PageHeader } from '@/components/ui';
import { useTenant } from '@/components/tenant';
import { cx } from '@/lib/format';
import { useT } from '@/lib/i18n';

// Settings: on a wide screen a list down the side, grouped by what it is about,
// that stays put while the page scrolls; on a phone a row of choices that slides
// sideways with no scrollbar, the one you're on brought into view.
export default function SettingsLayout({ children }: { children: ReactNode }) {
  const { base } = useTenant();
  const path = usePathname();
  const t = useT();
  const rail = useRef<HTMLDivElement>(null);
  const current = SETTINGS_SECTIONS.find(s => path.endsWith(`/settings/${s.key}`));
  const groups = [...new Set(SETTINGS_SECTIONS.map(s => s.group))];

  useEffect(() => {
    const r = rail.current, on = r?.querySelector<HTMLElement>('[aria-current="page"]');
    if (!r || !on) return;
    const a = r.getBoundingClientRect(), b = on.getBoundingClientRect();
    r.scrollBy({ left: b.left + b.width / 2 - (a.left + a.width / 2), behavior: 'smooth' });
  }, [path]);

  const item = (href: string, label: string, Icon: typeof LayoutGrid, on: boolean) => (
    <Link key={href} href={href} aria-current={on ? 'page' : undefined}
      className={cx('group relative flex items-center gap-3 rounded-xl px-3 py-2 text-sm transition-colors duration-150',
        on ? 'bg-white font-medium text-ink shadow-[0_1px_2px_rgba(0,0,0,0.05)] before:absolute before:inset-y-2.5 before:start-0 before:w-[3px] before:rounded-full before:bg-gold'
           : 'text-muted hover:bg-white/70 hover:text-ink')}>
      <span className={cx('flex size-7 shrink-0 items-center justify-center rounded-lg transition-colors duration-150',
        on ? 'bg-gold-wash text-gold-ink' : 'text-muted group-hover:text-ink')}><Icon className="size-4" aria-hidden /></span>
      <span className="truncate">{label}</span>
    </Link>
  );

  return (
    <div>
      <PageHeader title={t('Settings')} subtitle={t('What the agent knows and how your restaurant works. Every save reaches the agent on its next message.')} />

      {/* a phone: one row that slides */}
      <div ref={rail} className="rail -mx-4 mb-5 flex gap-2 overflow-x-auto px-4 lg:hidden" role="navigation" aria-label={t('Settings')}>
        {[{ key: '', label: 'All settings', icon: LayoutGrid }, ...SETTINGS_SECTIONS].map(s => {
          const on = s.key ? current?.key === s.key : !current;
          return (
            <Link key={s.key || 'all'} href={`${base}/settings${s.key ? '/' + s.key : ''}`} aria-current={on ? 'page' : undefined}
              className={cx('flex h-10 shrink-0 items-center gap-2 rounded-full px-4 text-sm transition-colors duration-150',
                on ? 'bg-navy font-medium text-white' : 'bg-white text-ink shadow-[0_1px_0_var(--color-hairline)]')}>
              <s.icon className="size-4" aria-hidden /> {t(s.label)}
            </Link>
          );
        })}
      </div>

      <div className="lg:grid lg:grid-cols-[232px_minmax(0,1fr)] lg:gap-8">
        {/* a wide screen: the list down the side */}
        <nav aria-label={t('Settings')} className="hidden lg:block">
          <div className="sticky top-20 space-y-5">
            {item(`${base}/settings`, t('All settings'), LayoutGrid, !current)}
            {groups.map(g => (
              <div key={g}>
                <p className="mb-1 px-3 text-xs font-medium text-muted/80">{t(g)}</p>
                <div className="space-y-0.5">
                  {SETTINGS_SECTIONS.filter(s => s.group === g).map(s => item(`${base}/settings/${s.key}`, t(s.label), s.icon, current?.key === s.key))}
                </div>
              </div>
            ))}
          </div>
        </nav>

        <div key={current?.key || 'all'} className="ew-page min-w-0">
          {current && (
            <div className="mb-5 flex items-start gap-3">
              <span className="flex size-11 shrink-0 items-center justify-center rounded-2xl bg-gold-wash text-gold-ink"><current.icon className="size-5" aria-hidden /></span>
              <div>
                <h2 className="text-xl font-semibold text-ink">{t(current.label)}</h2>
                <p className="mt-0.5 text-sm text-muted">{t(current.about)}</p>
              </div>
            </div>
          )}
          {children}
        </div>
      </div>
    </div>
  );
}
