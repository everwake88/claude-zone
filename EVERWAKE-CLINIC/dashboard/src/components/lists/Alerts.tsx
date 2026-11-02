'use client';
import { AlertTriangle, BellRing, CalendarX2, Check, CircleHelp, Clock4, MessageCircle, Phone, Siren, TimerReset } from 'lucide-react';
import { AnimatePresence, motion } from 'motion/react';
import Link from 'next/link';
import { useState } from 'react';
import { cx, phone as fmtPhone, timeAgo } from '@/lib/format';
import { useLang } from '@/lib/i18n';
import { useLive } from '@/lib/live';
import { sb } from '@/lib/supabase/client';
import type { Alert } from '@/lib/types';
import { useCached } from '@/lib/use-cached';
import { Empty, PageTitle, Segmented, Skeleton } from '../ui';
import { useTenant } from '../tenant';

const KIND: Record<string, { icon: typeof BellRing; label: string; tone: string }> = {
  emergency: { icon: Siren, label: 'Possible emergency', tone: 'text-critical bg-critical-soft' },
  urgent: { icon: AlertTriangle, label: 'Needs to be seen soon', tone: 'text-critical bg-critical-soft' },
  attention: { icon: BellRing, label: 'Needs someone', tone: 'text-caution bg-caution-soft' },
  at_risk: { icon: Clock4, label: 'Not confirmed', tone: 'text-caution bg-caution-soft' },
  no_reply: { icon: TimerReset, label: 'No answer to the delay', tone: 'text-caution bg-caution-soft' },
  cancelled: { icon: CalendarX2, label: 'Cancelled', tone: 'text-muted bg-raised' },
  waitlist: { icon: Clock4, label: 'Waitlist', tone: 'text-accent bg-accent-soft' },
  payment: { icon: BellRing, label: 'Payment', tone: 'text-accent bg-accent-soft' },
  team_question: { icon: CircleHelp, label: 'Question for the team', tone: 'text-caution bg-caution-soft' },
  system: { icon: BellRing, label: 'System', tone: 'text-muted bg-raised' }
};

// Everything that needs a person, newest first, emergencies on top. "Done" clears it for everyone.
export function Alerts() {
  const { tenant, base } = useTenant();
  const { t } = useLang();
  const [status, setStatus] = useState<'open' | 'all'>('open');
  const { data, refresh } = useCached<Alert[]>(`alerts:${tenant.id}:${status}`, async () => {
    const { data, error } = await sb().rpc('alert_list', { p_tenant: tenant.id, p_status: status, p_kind: null, p_limit: 100 });
    if (error) throw new Error(error.message);
    return data as Alert[];
  });
  useLive(['alerts'], () => refresh());
  const done = async (id: number) => { await sb().rpc('acknowledge_alert', { p_alert: id, p_resolve: true }); refresh(); };
  const open = (data || []).filter(a => a.status === 'open').length;

  return (
    <div>
      <PageTitle title={t('Alerts')} finding={data ? (open ? t('{n} need someone', { n: open }) : t('Nothing needs you right now.')) : ''}
        actions={<Segmented label="alert-status" value={status} onChange={setStatus} options={[{ value: 'open', label: t('Open') }, { value: 'all', label: t('Everything') }]} />} />
      {!data ? <Skeleton className="h-64" /> : data.length === 0 ? <Empty>{t('Nothing needs you right now.')}</Empty> : (
        <ul className="space-y-2.5">
          <AnimatePresence initial={false}>
            {data.map((a, i) => {
              const k = KIND[a.kind] || KIND.system;
              const closed = a.status !== 'open';
              return (
                <motion.li key={a.id} layout initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, x: 16, transition: { duration: 0.18 } }}
                  transition={{ duration: 0.22, delay: Math.min(i, 10) * 0.02 }}
                  className={cx('card flex flex-wrap items-start gap-3 p-4', a.kind === 'emergency' && !closed && 'ring-1 ring-critical/40', closed && 'opacity-70')}>
                  <span className={cx('flex size-9 shrink-0 items-center justify-center rounded-full', k.tone)}><k.icon className="size-4" aria-hidden /></span>
                  <div className="min-w-0 flex-1">
                    <p className="text-xs font-medium text-muted">{t(k.label)} · {timeAgo(a.created_at)}{a.doctor ? <> · <bdi>{a.doctor}</bdi></> : null}</p>
                    <p className="mt-0.5 text-[14px] font-semibold"><bdi>{a.who || a.title}</bdi></p>
                    {a.body && <p className="mt-0.5 text-[13.5px] leading-relaxed"><bdi>{a.body}</bdi></p>}
                    {a.appointment && <p className="mt-1 text-xs text-muted"><bdi>{a.appointment}</bdi></p>}
                    {closed && a.acknowledged_by_name && <p className="mt-1 text-xs text-faint">{t('Seen by {name}', { name: a.acknowledged_by_name })}</p>}
                  </div>
                  <div className="flex flex-wrap items-center gap-2">
                    {a.phone && <a href={`tel:+${a.phone}`} className="press inline-flex h-8 items-center gap-1.5 rounded-full px-2.5 text-[13px] ring-1 ring-inset ring-border hover:bg-raised"><Phone className="size-3.5 text-muted" aria-hidden /><bdi dir="ltr">{fmtPhone(a.phone)}</bdi></a>}
                    {a.conversation_id && <Link href={`${base}/inbox?c=${a.conversation_id}`} className="press inline-flex h-8 items-center gap-1.5 rounded-full px-2.5 text-[13px] ring-1 ring-inset ring-border hover:bg-raised"><MessageCircle className="size-3.5 text-positive" aria-hidden />{t('Chat')}</Link>}
                    {!closed && <button onClick={() => done(a.id)} className="press inline-flex h-8 items-center gap-1.5 rounded-full bg-ink px-3 text-[13px] font-medium text-white hover:bg-[#1e2a42]"><Check className="size-3.5" aria-hidden />{t('Done')}</button>}
                  </div>
                </motion.li>
              );
            })}
          </AnimatePresence>
        </ul>
      )}
    </div>
  );
}
