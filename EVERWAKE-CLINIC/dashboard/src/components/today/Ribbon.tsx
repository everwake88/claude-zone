'use client';
import { motion, useReducedMotion } from 'motion/react';
import { useEffect, useMemo, useRef } from 'react';
import { clock, cx } from '@/lib/format';
import { useLang } from '@/lib/i18n';
import type { ApptCard, ApptStatus, SessionBlock } from '@/lib/types';
import { DocDot } from '../booking/pickers';

// The session ribbon: the day as a line per doctor and place. Each patient is a block at their
// time; the needle is now. When the doctor is late, a hatched band opens at the start of the
// session and the blocks slide along by the same minutes.
const BLOCK: Record<ApptStatus, string> = {
  held: 'bg-sheet text-faint border border-dashed border-control',
  booked: 'bg-sheet text-ink ring-1 ring-inset ring-control',
  confirmed: 'bg-accent-soft text-accent-ink ring-1 ring-inset ring-accent-track',
  arrived: 'bg-caution-soft text-caution ring-1 ring-inset ring-caution-line',
  in_visit: 'bg-accent text-white',
  done: 'bg-positive-soft text-positive-ink',
  no_show: 'bg-critical-soft text-critical-ink line-through decoration-critical/50',
  cancelled: 'hidden'
};
const HOUR = 60 * 60_000;
const QUEUE_MIN = 12;

export interface RibbonRow { key: string; session: SessionBlock | null; label: string; sub: string; appointments: ApptCard[] }

export function Ribbon({ rows, now, tz, onPick, lanePx = 84 }: { rows: RibbonRow[]; now: number; tz: string; onPick: (a: ApptCard) => void; lanePx?: number }) {
  const { t, lang } = useLang();
  const reduce = useReducedMotion();
  const scroller = useRef<HTMLDivElement>(null);

  // the axis: whole hours around every session and every appointment
  const [from, to] = useMemo(() => {
    const times: number[] = [];
    rows.forEach(r => {
      if (r.session) times.push(+new Date(r.session.starts_at), +new Date(r.session.ends_at));
      r.appointments.forEach(a => times.push(+new Date(a.est_at || a.starts_at), +new Date(a.est_at || a.starts_at) + QUEUE_MIN * 60_000));
    });
    if (!times.length) return [0, 0];
    const lo = Math.min(...times), hi = Math.max(...times);
    return [Math.floor(lo / HOUR) * HOUR, Math.ceil(hi / HOUR) * HOUR];
  }, [rows]);
  const span = Math.max(to - from, HOUR);
  const pct = (ms: number) => ((ms - from) / span) * 100;
  const hours = useMemo(() => Array.from({ length: Math.round(span / HOUR) + 1 }, (_, i) => from + i * HOUR), [from, span]);
  const nowPct = pct(now);
  const nowIn = nowPct >= 0 && nowPct <= 100;
  const rtl = lang === 'ar';

  // on a phone the ribbon scrolls sideways: open it at now
  useEffect(() => {
    const sc = scroller.current;
    if (nowIn && sc && sc.scrollWidth > sc.clientWidth + 2) {
      // the needle's place in the scrolled track, from the start edge (the right one in Arabic)
      const label = sc.firstElementChild?.firstElementChild?.getBoundingClientRect().width || 0;
      const track = sc.scrollWidth - label;
      const x = label + (track * nowPct) / 100 - sc.clientWidth / 2;
      sc.scrollLeft = rtl ? -Math.max(0, x) : Math.max(0, x);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [from, to]);

  if (!rows.length) return null;
  const minWidth = Math.round(span / HOUR) * lanePx;

  return (
    <div ref={scroller} className="overflow-x-auto overscroll-x-contain">
      <div className="relative grid grid-cols-[116px_minmax(0,1fr)] sm:grid-cols-[176px_minmax(0,1fr)]" style={{ minWidth: minWidth + 176 }}>
        {/* the hours */}
        <div className="sticky start-0 z-20 bg-sheet" />
        <div className="relative h-7 border-b border-rule">
          {hours.map((h, i) => (
            <span key={h} className={cx('absolute top-1.5 -translate-x-1/2 text-[11px] tabular-nums text-faint rtl:translate-x-1/2', i === hours.length - 1 && 'hidden')}
              style={{ insetInlineStart: `${pct(h)}%` }}>{clock(new Date(h).toISOString(), tz)}</span>
          ))}
        </div>

        {rows.map((r, ri) => {
          const s = r.session;
          const delay = s?.delay_minutes || 0;
          return (
            <div key={r.key} className="contents">
              <div className="sticky start-0 z-20 flex min-w-0 flex-col justify-center gap-0.5 border-b border-rule bg-sheet py-2.5 pe-3">
                <p className="flex min-w-0 items-center gap-2 text-[12.5px] font-medium sm:text-[13px]">
                  <DocDot color={s?.color} /><span className="truncate">{r.label}</span>
                </p>
                <p className="truncate ps-4 text-[11.5px] text-muted">{r.sub}</p>
                {delay > 0 && <p className="ps-4"><span className="inline-flex whitespace-nowrap rounded-full bg-caution-soft px-1.5 text-[10.5px] font-medium text-caution sm:text-[11px]">{t('+{n} min late', { n: delay })}</span></p>}
              </div>
              <div className="relative h-[62px] border-b border-rule">
                {/* hour lines */}
                {hours.slice(1, -1).map(h => <span key={h} aria-hidden className="absolute inset-y-0 w-px bg-rule" style={{ insetInlineStart: `${pct(h)}%` }} />)}
                {/* the session itself */}
                {s && (
                  <span aria-hidden className="absolute inset-y-2.5 rounded-[8px] bg-raised"
                    style={{ insetInlineStart: `${pct(+new Date(s.starts_at))}%`, width: `${(+new Date(s.ends_at) - +new Date(s.starts_at)) / span * 100}%` }} />
                )}
                {/* the minutes the doctor is not there yet */}
                {s && delay > 0 && (() => {
                  // from where the first moved patient was due, for the minutes they all moved
                  const moved = r.appointments.filter(a => a.delay_minutes > 0 && a.original_starts_at).map(a => +new Date(a.original_starts_at!));
                  const at = moved.length ? Math.min(...moved) : +new Date(s.starts_at);
                  return <span className="hatch c-bar absolute inset-y-2.5 rounded-[8px] ring-1 ring-inset ring-caution-line"
                    style={{ insetInlineStart: `${pct(at)}%`, width: `${(delay * 60_000) / span * 100}%` }} title={t('+{n} min late', { n: delay })} />;
                })()}
                {r.appointments.filter(a => a.status !== 'cancelled').map((a, i) => {
                  const st = +new Date(a.est_at || a.starts_at);
                  const en = a.mode === 'queue' ? st + QUEUE_MIN * 60_000 : +new Date(a.ends_at);
                  const first = (a.patient || '').split(/\s+/)[0] || a.ref_no;
                  const late = a.delay_reply === 'sent' || a.delay_reply === 'no_reply';
                  return (
                    <motion.button key={a.id} layout={reduce ? false : 'position'} onClick={() => onPick(a)}
                      initial={reduce ? false : { opacity: 0, y: 4 }} animate={{ opacity: 1, y: 0 }}
                      transition={{ layout: { duration: 0.5, ease: [0.23, 1, 0.32, 1] }, default: { duration: 0.24, delay: Math.min(ri * 3 + i, 24) * 0.015 } }}
                      title={`${a.patient || ''} · ${clock(a.est_at || a.starts_at, tz)}`}
                      className={cx('press absolute inset-y-3.5 flex min-w-0 items-center overflow-hidden rounded-[7px] px-1.5 text-start text-[11.5px] font-medium leading-none',
                        BLOCK[a.status], a.status === 'in_visit' && 'c-live z-10', a.urgency === 'emergency' && 'ring-2 ring-critical')}
                      style={{ insetInlineStart: `${pct(st)}%`, width: `max(${((en - st) / span) * 100}% - 2px, 22px)` }}>
                      {a.mode === 'queue'
                        ? <span className="w-full text-center tabular-nums">{a.queue_no}</span>
                        : <span className="truncate">{first}</span>}
                      {late && <span aria-label={t('No answer to the delay yet')} className={cx('absolute end-1 top-1 size-1.5 rounded-full', a.delay_reply === 'no_reply' ? 'bg-critical' : 'bg-caution')} />}
                    </motion.button>
                  );
                })}
              </div>
            </div>
          );
        })}

        {/* now */}
        {nowIn && (
          <div aria-hidden className="pointer-events-none absolute inset-0 z-10 overflow-hidden" style={{ gridColumn: 2, gridRow: `1 / span ${rows.length + 1}` }}>
            <div className="h-full w-full transition-transform duration-700 ease-[var(--ease-out)]" style={{ transform: `translateX(${rtl ? -nowPct : nowPct}%)` }}>
              <span className="absolute inset-y-0 start-0 w-0.5 -translate-x-1/2 rounded-full bg-critical rtl:translate-x-1/2" />
              <span className="absolute start-0 top-0 -translate-x-1/2 rounded-full bg-critical px-1.5 py-0.5 text-[10px] font-semibold tabular-nums text-white rtl:translate-x-1/2">
                {clock(new Date(now).toISOString(), tz)}
              </span>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
