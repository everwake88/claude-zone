'use client';
import { Check } from 'lucide-react';
import { motion, useReducedMotion } from 'motion/react';
import { useEffect, useMemo, useRef } from 'react';
import { docName, useClinic } from '@/lib/clinic-data';
import { clock, cx } from '@/lib/format';
import { useLang } from '@/lib/i18n';
import type { ApptCard } from '@/lib/types';

// The day as one column: a time, then the patient. The one with the doctor is navy; the
// moment now is a dotted line with a breathing gold dot; the minutes the doctor is late are
// a hatched gap. Tap a patient to check them in, move or cancel.
type Row = { kind: 'appt'; a: ApptCard; at: number } | { kind: 'now'; at: number } | { kind: 'late'; at: number; minutes: number };

export function Timeline({ appts, now, tz, delay, onPick, showDoctor }:
  { appts: ApptCard[]; now: number; tz: string; delay: { at: number; minutes: number } | null; onPick: (a: ApptCard) => void; showDoctor?: boolean }) {
  const { t, lang } = useLang();
  const { doctors } = useClinic();
  const reduce = useReducedMotion();
  const box = useRef<HTMLDivElement>(null);
  const nowRef = useRef<HTMLLIElement>(null);

  const rows = useMemo<Row[]>(() => {
    const list: Row[] = appts.filter(a => a.status !== 'cancelled' && a.status !== 'held')
      .map(a => ({ kind: 'appt' as const, a, at: +new Date(a.est_at || a.starts_at) }));
    if (delay) list.push({ kind: 'late', at: delay.at - 1, minutes: delay.minutes });
    if (list.length) list.push({ kind: 'now', at: now });
    return list.sort((x, y) => x.at - y.at || (x.kind === 'now' ? -1 : 1));
  }, [appts, now, delay]);

  // open the column at now
  useEffect(() => {
    const b = box.current, n = nowRef.current;
    if (b && n && b.scrollHeight > b.clientHeight) b.scrollTop = Math.max(0, n.offsetTop - b.clientHeight / 3);
  }, [rows.length]);

  if (!appts.length) return <p className="px-1 py-6 text-center text-[13px] text-muted">{t('Nobody is booked on this day.')}</p>;

  return (
    <div ref={box} className="relative max-h-[560px] overflow-y-auto overscroll-contain pe-1 lg:max-h-[calc(100dvh-230px)]">
      <ol className="relative">
        {rows.map((r, i) => {
          if (r.kind === 'now') {
            return (
              <li key="now" ref={nowRef} className="relative flex items-center gap-2 py-1.5" aria-label={t('Now, {t}', { t: clock(new Date(now).toISOString(), tz) })}>
                <span className="w-[52px] shrink-0 text-end text-[11px] font-semibold tabular-nums text-gold-ink">{clock(new Date(now).toISOString(), tz)}</span>
                <span className="relative flex size-3 shrink-0 items-center justify-center">
                  <span className="c-breathe absolute size-3 rounded-full bg-gold/40" aria-hidden />
                  <span className="relative size-2 rounded-full bg-gold" aria-hidden />
                </span>
                <span className="h-px flex-1 border-t border-dashed border-gold" aria-hidden />
              </li>
            );
          }
          if (r.kind === 'late') {
            return (
              <li key="late" className="flex gap-2 py-1">
                <span className="w-[52px] shrink-0" />
                <span className="hatch flex-1 rounded-xl px-3 py-2 text-[12px] font-medium text-caution ring-1 ring-inset ring-caution-line">
                  {t('+{n} min — the doctor is late', { n: r.minutes })}
                </span>
              </li>
            );
          }
          const a = r.a;
          const current = a.status === 'in_visit';
          const done = a.status === 'done';
          const gone = a.status === 'no_show';
          const waiting = a.status === 'arrived';
          const doc = doctors.find(d => d.id === a.doctor_id);
          const first = (a.patient || a.ref_no).split(/\s+/).slice(0, 2).join(' ');
          return (
            <li key={a.id} className="flex gap-2 py-1">
              <span className={cx('w-[52px] shrink-0 pt-2.5 text-end text-[12px] tabular-nums', current ? 'font-semibold text-ink' : 'text-faint')}>
                {a.mode === 'queue' && a.queue_no ? `#${a.queue_no}` : clock(a.est_at || a.starts_at, tz)}
              </span>
              <motion.button layout={reduce ? false : 'position'} onClick={() => onPick(a)}
                initial={reduce ? false : { opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }}
                transition={{ layout: { duration: 0.5, ease: [0.23, 1, 0.32, 1] }, default: { duration: 0.3, delay: Math.min(i, 12) * 0.025 } }}
                className={cx('press group min-w-0 flex-1 rounded-xl px-3 py-2 text-start',
                  current ? 'bg-navy text-white shadow-[0_10px_24px_-14px_rgb(11_34_46/.7)]'
                    : 'bg-raised hover:bg-sunk/70', (done || gone) && 'opacity-60')}>
                <span className="flex items-center gap-2">
                  <span className={cx('min-w-0 flex-1 truncate text-[13.5px] font-medium', gone && 'line-through')}><bdi>{first}</bdi></span>
                  {done && <Check className="size-3.5 shrink-0 text-positive" aria-label={t('Done')} />}
                  {current && <span className="shrink-0 text-[11px] font-semibold text-gold-bright">{t('With the doctor')}</span>}
                  {waiting && <span className="shrink-0 text-[11px] font-medium text-caution">{t('Waiting')}</span>}
                  {a.status === 'confirmed' && <span className="size-1.5 shrink-0 rounded-full bg-positive" aria-label={t('Confirmed')} />}
                  {(a.delay_reply === 'sent' || a.delay_reply === 'no_reply') && <span className={cx('size-1.5 shrink-0 rounded-full', a.delay_reply === 'no_reply' ? 'bg-critical' : 'bg-caution')} aria-label={t('No answer to the delay yet')} />}
                </span>
                <span className={cx('mt-0.5 flex items-center gap-1.5 truncate text-[11.5px]', current ? 'text-on-navy-muted' : 'text-faint')}>
                  {showDoctor && doc && <span aria-hidden className="size-1.5 shrink-0 rounded-full" style={{ background: doc.color || 'var(--color-navy)' }} />}
                  <bdi className="truncate">{(lang === 'en' && a.service_en) || a.service || (showDoctor && doc ? docName(doc, lang) : '')}</bdi>
                </span>
              </motion.button>
            </li>
          );
        })}
      </ol>
    </div>
  );
}
