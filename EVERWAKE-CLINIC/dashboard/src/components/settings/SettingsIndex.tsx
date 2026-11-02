'use client';
import { ChevronRight } from 'lucide-react';
import Link from 'next/link';
import { cx } from '@/lib/format';
import { useLang } from '@/lib/i18n';
import { PageTitle } from '../ui';
import { useTenant } from '../tenant';
import { SETTINGS_SECTIONS } from './sections';

export function SettingsIndex() {
  const { base, can } = useTenant();
  const { t } = useLang();
  return (
    <div>
      <PageTitle title={t('Settings')} finding={t('In the order a new clinic fills them in.')} />
      <div className="card divide-y divide-rule overflow-hidden">
        {SETTINGS_SECTIONS.map((s, i) => {
          const allowed = s.need === 'owner' ? can.owner : can.edit;
          return (
            <Link key={s.key} href={`${base}/settings/${s.key}`} aria-disabled={!allowed}
              className={cx('c-rise group flex items-center gap-4 px-4 py-3.5 hover:bg-raised', !allowed && 'opacity-60')} style={{ animationDelay: `${i * 22}ms` }}>
              <span className="flex size-9 shrink-0 items-center justify-center rounded-[9px] bg-accent-soft text-accent"><s.icon className="size-[18px]" aria-hidden /></span>
              <span className="min-w-0 flex-1">
                <span className="block text-[14px] font-medium">{t(s.label)}</span>
                <span className="block truncate text-[12.5px] text-muted">{t(s.sub)}</span>
              </span>
              <ChevronRight className="size-4 text-faint transition-transform group-hover:translate-x-0.5 rtl:rotate-180 rtl:group-hover:-translate-x-0.5" aria-hidden />
            </Link>
          );
        })}
      </div>
    </div>
  );
}
