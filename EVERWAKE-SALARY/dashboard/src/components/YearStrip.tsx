import Link from 'next/link';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { count } from '@/lib/format';
import { monthName, type Lang, type T } from '@/lib/i18n';

type S = { id: string; period: string; status: string; row_count: number; problem_count: number };

// The payroll year: the months on file in sage with their headcount, gaps dashed, the current
// month outlined until it is uploaded. A month opens its sheet; an empty one opens the upload.
export function YearStrip({ sheets, year, now, lang, t, i = 0 }: { sheets: S[]; year: number; now: Date; lang: Lang; t: T; i?: number }) {
  const thisYear = now.getFullYear(), thisMonth = now.getMonth() + 1;
  const byMonth = new Map<number, S>();
  for (const s of sheets) {
    if (Number(s.period.slice(0, 4)) !== year) continue;
    const m = Number(s.period.slice(5, 7));
    const cur = byMonth.get(m);
    if (!cur || (s.status === 'published' && cur.status !== 'published')) byMonth.set(m, s);
  }
  const firstPeriod = sheets.map((s) => s.period).sort()[0];
  const first = firstPeriod ? { y: Number(firstPeriod.slice(0, 4)), m: Number(firstPeriod.slice(5, 7)) } : null;
  const Prev = lang === 'ar' ? ChevronRight : ChevronLeft, Next = lang === 'ar' ? ChevronLeft : ChevronRight;
  return (
    <section className="card rise" style={{ ['--i' as string]: i }} aria-labelledby="year-h">
      <div className="panel-head">
        <h2 id="year-h">{t('ov.year', { year })}</h2>
        <div style={{ display: 'flex', gap: 6 }}>
          <Link className="btn sm" href={`/sheets?year=${year - 1}`} scroll={false}><Prev aria-hidden="true" />{year - 1}</Link>
          {year < thisYear && <Link className="btn sm" href={`/sheets?year=${year + 1}`} scroll={false}>{year + 1}<Next aria-hidden="true" /></Link>}
        </div>
      </div>
      <div className="panel-body">
        <p className="hint" style={{ marginBottom: 14 }}>{t('ov.yearSub')}</p>
        <div className="year">
          {Array.from({ length: 12 }, (_, k) => k + 1).map((m) => {
            const s = byMonth.get(m);
            const later = year > thisYear || (year === thisYear && m > thisMonth);
            const isNow = year === thisYear && m === thisMonth;
            const before = !s && !isNow && (!first || year < first.y || (year === first.y && m < first.m));
            const cls = `month${s?.status === 'published' ? ' on' : ''}${later && !s ? ' later' : ''}${before && !later ? ' before' : ''}${isNow ? ' now' : ''}`;
            const href = s ? `/sheets/${s.id}` : `/sheets?month=${year}-${String(m).padStart(2, '0')}#upload`;
            return (
              <Link key={m} className={cls} href={href} style={{ ['--n' as string]: m }} aria-label={`${monthName(lang, m)} ${year}`}>
                <span className="m">{monthName(lang, m)}</span>
                {s?.status === 'published' ? <span className="v">{count(lang, s.row_count)}<small>{t('sh.rows')}</small></span>
                  : s ? <span className="v"><span className="pill warn">{t('sh.draft')}</span></span>
                  : <span className="v" aria-label={later ? t('ov.later') : t('ov.notUploaded')}>{isNow ? t('ov.uploadIt') : later ? t('ov.later') : '—'}</span>}
                {s && s.problem_count > 0 && <span className="flag" title={`${s.problem_count} ${t('sh.problems')}`} />}
              </Link>
            );
          })}
        </div>
      </div>
    </section>
  );
}
