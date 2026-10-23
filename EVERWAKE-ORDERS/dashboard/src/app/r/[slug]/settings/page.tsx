'use client';
import Link from 'next/link';
import { SETTINGS_SECTIONS } from '@/components/settings/sections';
import { useTenant } from '@/components/tenant';
import { useT } from '@/lib/i18n';

// The settings, each with what it changes, so nobody has to open them one by one to find out.
export default function SettingsIndex() {
  const { base } = useTenant();
  const t = useT();
  return (
    <ul className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
      {SETTINGS_SECTIONS.map(({ key, label, about, icon: Icon }) => (
        <li key={key}>
          <Link href={`${base}/settings/${key}`}
            className="flex h-full gap-3 rounded-xl border border-hairline bg-white p-4 transition-colors hover:border-gold focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gold/50">
            <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-gold-wash text-gold-ink"><Icon className="size-5" aria-hidden /></span>
            <span>
              <span className="block font-medium text-ink">{t(label)}</span>
              <span className="mt-0.5 block text-sm text-muted">{t(about)}</span>
            </span>
          </Link>
        </li>
      ))}
    </ul>
  );
}
