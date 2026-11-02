'use client';
import { CalendarPlus, Trash2 } from 'lucide-react';
import { AnimatePresence, motion } from 'motion/react';
import { useState } from 'react';
import { clock, cx, dateShort, phone as fmtPhone, timeAgo } from '@/lib/format';
import { useLang } from '@/lib/i18n';
import { useLive } from '@/lib/live';
import { sb } from '@/lib/supabase/client';
import { useCached } from '@/lib/use-cached';
import { useShell } from '../shell/Shell';
import { Avatar, Button, Empty, PageTitle, Pill, Segmented, Skeleton } from '../ui';
import { useTenant } from '../tenant';

interface Entry { id: number; patient_id: number | null; patient: string | null; phone: string | null; doctor: string | null; doctor_en: string | null; doctor_id: string | null;
  location: string | null; service: string | null; service_en: string | null; from_date: string; to_date: string | null; band: string; status: string;
  offered_at: string | null; offered_slot: { label_ar?: string; label_en?: string } | null; notes: string | null; created_at: string; holds: { id: number; starts_at: string } | null }
const BAND: Record<string, string> = { any: 'Any time', morning: 'Mornings', afternoon: 'Afternoons', evening: 'Evenings' };

// People who want an earlier time. When a booking is cancelled the assistant offers the freed time
// to the first one who fits; the desk can also book them straight away.
export function Waitlist() {
  const { tenant } = useTenant();
  const { t, lang } = useLang();
  const shell = useShell();
  const [status, setStatus] = useState<'open' | 'all'>('open');
  const { data, refresh } = useCached<Entry[]>(`waitlist:${tenant.id}:${status}`, async () => {
    const { data, error } = await sb().rpc('waitlist_list', { p_tenant: tenant.id, p_status: status });
    if (error) throw new Error(error.message);
    return data as Entry[];
  });
  useLive(['waitlist'], () => refresh());
  const remove = async (id: number) => { await sb().from('waitlist').update({ status: 'cancelled' }).eq('id', id); refresh(); };
  const tz = tenant.timezone;

  return (
    <div>
      <PageTitle title={t('Waitlist')} finding={t('When a time frees up, the assistant offers it to the first patient who fits.')}
        actions={<Segmented label="wl-status" value={status} onChange={setStatus} options={[{ value: 'open', label: t('Waiting') }, { value: 'all', label: t('Everything') }]} />} />
      {!data ? <Skeleton className="h-48" /> : data.length === 0 ? <Empty>{t('Nobody is waiting for an earlier time.')}</Empty> : (
        <div className="card overflow-hidden">
          <ul className="divide-y divide-rule">
            <AnimatePresence initial={false}>
              {data.map(w => (
                <motion.li key={w.id} layout exit={{ opacity: 0, height: 0 }} transition={{ duration: 0.2 }} className="flex flex-wrap items-center gap-3 px-4 py-3">
                  <Avatar name={w.patient} size={34} />
                  <div className="min-w-0 flex-1">
                    <p className="flex flex-wrap items-center gap-2 text-[14px] font-medium"><bdi>{w.patient}</bdi>
                      {w.status === 'offered' ? <Pill tone="caution">{t('Offered a time')}</Pill> : w.status !== 'waiting' ? <Pill>{t(w.status === 'booked' ? 'Booked' : w.status === 'expired' ? 'Expired' : 'Removed')}</Pill> : null}</p>
                    <p className="text-[12.5px] text-muted">
                      <bdi>{lang === 'en' ? w.doctor_en : w.doctor}</bdi>{w.service ? <> · <bdi>{(lang === 'en' && w.service_en) || w.service}</bdi></> : null} · {t(BAND[w.band] || w.band)}
                      {' · '}{t('from {d}', { d: dateShort(w.from_date, tz) })}{w.to_date ? ` ${t('to {d}', { d: dateShort(w.to_date, tz) })}` : ''}
                    </p>
                    <p className="text-xs text-faint">{w.holds ? t('Holds {d} at {t}', { d: dateShort(w.holds.starts_at, tz), t: clock(w.holds.starts_at, tz) }) + ' · ' : ''}{t('waiting since {t}', { t: timeAgo(w.created_at) })}{w.phone ? <> · <bdi dir="ltr">{fmtPhone(w.phone)}</bdi></> : null}</p>
                  </div>
                  {['waiting', 'offered'].includes(w.status) && (
                    <div className={cx('flex gap-2')}>
                      <Button size="sm" variant="ghost" onClick={() => remove(w.id)} aria-label={t('Remove')}><Trash2 className="size-4" aria-hidden /></Button>
                      <Button size="sm" variant="outline" onClick={() => shell.newBooking({ patientId: w.patient_id || undefined, patientName: w.patient || undefined, doctorId: w.doctor_id || undefined })}>
                        <CalendarPlus className="size-4" aria-hidden />{t('Book now')}
                      </Button>
                    </div>
                  )}
                </motion.li>
              ))}
            </AnimatePresence>
          </ul>
        </div>
      )}
    </div>
  );
}
