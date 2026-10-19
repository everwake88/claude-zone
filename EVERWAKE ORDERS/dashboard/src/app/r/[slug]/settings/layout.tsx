'use client';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import type { ReactNode } from 'react';
import { PageHeader } from '@/components/ui';
import { useTenant } from '@/components/tenant';
import { cx } from '@/lib/format';

const TABS = [
  ['agent', 'Agent'], ['knowledge', 'Answers'], ['ordering', 'Ordering'], ['messages', 'Messages'], ['whatsapp', 'WhatsApp'], ['team', 'Team']
];

export default function SettingsLayout({ children }: { children: ReactNode }) {
  const { base } = useTenant();
  const path = usePathname();
  return (
    <div>
      <PageHeader title="Settings" subtitle="What the agent knows and how your restaurant works. Every save reaches the agent on its next message." />
      <nav className="mb-5 flex flex-wrap gap-1 border-b border-hairline">
        {TABS.map(([k, label]) => (
          <Link key={k} href={`${base}/settings/${k}`}
            className={cx('-mb-px border-b-2 px-3 py-2 text-sm', path.endsWith(`/settings/${k}`) ? 'border-gold font-medium text-ink' : 'border-transparent text-muted hover:text-ink')}>
            {label}
          </Link>
        ))}
      </nav>
      {children}
    </div>
  );
}
