'use client';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import type { ReactNode } from 'react';
import { SETTINGS_SECTIONS } from '@/components/settings/sections';
import { PageHeader } from '@/components/ui';
import { useTenant } from '@/components/tenant';
import { cx } from '@/lib/format';
import { useT } from '@/lib/i18n';

export default function SettingsLayout({ children }: { children: ReactNode }) {
  const { base } = useTenant();
  const path = usePathname();
  const t = useT();
  const current = SETTINGS_SECTIONS.find(s => path.endsWith(`/settings/${s.key}`));
  return (
    <div>
      <PageHeader title={t('Settings')} subtitle={t('What the agent knows and how your restaurant works. Every save reaches the agent on its next message.')} />
      <nav className="-mx-1 flex gap-1 overflow-x-auto whitespace-nowrap border-b border-hairline px-1" aria-label={t('Settings')}>
        <Link href={`${base}/settings`} aria-current={!current ? 'page' : undefined}
          className={cx('-mb-px shrink-0 border-b-2 px-3 py-2 text-sm', !current ? 'border-gold font-medium text-ink' : 'border-transparent text-muted hover:text-ink')}>
          {t('All settings')}
        </Link>
        {SETTINGS_SECTIONS.map(s => (
          <Link key={s.key} href={`${base}/settings/${s.key}`} aria-current={current?.key === s.key ? 'page' : undefined}
            className={cx('-mb-px shrink-0 border-b-2 px-3 py-2 text-sm', current?.key === s.key ? 'border-gold font-medium text-ink' : 'border-transparent text-muted hover:text-ink')}>
            {t(s.label)}
          </Link>
        ))}
      </nav>
      <p className="mb-5 mt-3 text-sm text-muted">{current ? t(current.about) : t('Choose what you want to change. Each one says what it does.')}</p>
      {children}
    </div>
  );
}
