'use client';
import { ChevronRight } from 'lucide-react';
import Link from 'next/link';
import { SETTINGS_SECTIONS } from '@/components/settings/sections';
import { useTenant } from '@/components/tenant';
import { useT } from '@/lib/i18n';

// The settings, each with what it changes, grouped as in the list beside them,
// so nobody has to open them one by one to find out.
export default function SettingsIndex() {
  const { base } = useTenant();
  const t = useT();
  const groups = [...new Set(SETTINGS_SECTIONS.map(s => s.group))];
  return (
    <div className="space-y-7">
      {groups.map(g => (
        <section key={g}>
          <h2 className="mb-2.5 text-sm font-semibold text-ink">{t(g)}</h2>
          <ul className="grid gap-3 sm:grid-cols-2 2xl:grid-cols-3">
            {SETTINGS_SECTIONS.filter(s => s.group === g).map(({ key, label, about, icon: Icon }) => (
              <li key={key}>
                <Link href={`${base}/settings/${key}`}
                  className="group flex h-full items-start gap-3.5 rounded-2xl border border-hairline/80 bg-white p-4 transition-[border-color,box-shadow,transform] duration-200
                             hover:-translate-y-0.5 hover:border-gold-line hover:shadow-[0_10px_24px_-14px_rgba(0,0,0,0.25)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gold/50 active:translate-y-0">
                  <span className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-gold-wash text-gold-ink transition-transform duration-200 group-hover:scale-105">
                    <Icon className="size-5" aria-hidden />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block font-medium text-ink">{t(label)}</span>
                    <span className="mt-0.5 block text-sm leading-relaxed text-muted">{t(about)}</span>
                  </span>
                  <ChevronRight className="mt-0.5 size-4 shrink-0 text-muted/60 transition-transform duration-200 group-hover:translate-x-0.5 group-hover:text-gold-ink rtl:rotate-180 rtl:group-hover:-translate-x-0.5" aria-hidden />
                </Link>
              </li>
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}
