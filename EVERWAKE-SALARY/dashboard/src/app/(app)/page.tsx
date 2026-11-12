import Link from 'next/link';
import { Upload, ChevronLeft, ChevronRight } from 'lucide-react';
import { getT } from '@/lib/auth';
import { q, one } from '@/lib/db';
import { getSettings, askedFields } from '@/lib/settings';
import { ago, count } from '@/lib/format';
import { monthName, periodLabel } from '@/lib/i18n';

type SheetRow = { id: string; period: string; status: string; row_count: number; problem_count: number };
type DisputeRow = { id: string; ticket_no: number; employee_name: string | null; item: string; period: string | null; created_at: string };

export default async function Overview({ searchParams }: { searchParams: Promise<{ year?: string }> }) {
  const { t, lang } = await getT();
  const now = new Date(new Date().toLocaleString('en-US', { timeZone: 'Africa/Cairo' }));
  const thisYear = now.getFullYear(), thisMonth = now.getMonth() + 1;
  const year = Number((await searchParams).year) || thisYear;

  const [sheets, latest, disputes, week, settings] = await Promise.all([
    q<SheetRow>(`select distinct on (period) id, period, status, row_count, problem_count from salary.payroll_sheets
                 where extract(year from period) = $1 order by period, (status = 'published') desc, uploaded_at desc`, [year]),
    one<{ period: string }>(`select period from salary.payroll_sheets where status = 'published' order by period desc limit 1`),
    q<DisputeRow>(`select id, ticket_no, employee_name, item, period, created_at from salary.disputes where status = 'open' order by created_at limit 5`),
    one<{ chats: number; verified: number; failed: number }>(`select
        (select count(distinct conversation_id)::int from salary.messages where direction = 'in' and created_at > now() - interval '7 days') as chats,
        (select count(distinct conversation_id)::int from salary.identity_attempts where result = 'verified' and created_at > now() - interval '7 days') as verified,
        (select count(*)::int from salary.identity_attempts where result <> 'verified' and created_at > now() - interval '7 days') as failed`),
    getSettings()
  ]);
  const [openRow, firstRow, recent] = await Promise.all([
    one<{ n: number }>(`select count(*)::int as n from salary.disputes where status = 'open'`),
    one<{ first: string | null }>(`select min(period)::text as first from salary.payroll_sheets`),
    // when little is waiting, the last few resolved fill the column (and show what HR did)
    q<DisputeRow & { resolved_at: string }>(`select id, ticket_no, employee_name, item, period, created_at, resolved_at from salary.disputes
                                             where status = 'resolved' order by resolved_at desc limit 3`)
  ]);
  const openCount = openRow?.n ?? 0;
  // months before the company's first upload are not "missing", they are before the agent
  const first = firstRow?.first ? { y: Number(firstRow.first.slice(0, 4)), m: Number(firstRow.first.slice(5, 7)) } : null;
  const byMonth = new Map(sheets.map((s) => [Number(s.period.slice(5, 7)), s]));
  const asked = askedFields(settings);

  const finding = !latest ? t('ov.findingNoSheet')
    : openCount === 2 ? t('ov.findingTwo', { age: ago(t, disputes[0]?.created_at) })
    : openCount > 1 ? t('ov.findingDisputes', { n: openCount, age: ago(t, disputes[0]?.created_at) })
    : openCount === 1 ? t('ov.findingOne', { age: ago(t, disputes[0]?.created_at) })
    : t('ov.findingNone', { month: periodLabel(lang, latest.period) });
  const Prev = lang === 'ar' ? ChevronRight : ChevronLeft, Next = lang === 'ar' ? ChevronLeft : ChevronRight;

  return (
    <div className="page">
      <div className="title-row">
        <div>
          <h1>{t('ov.title')}</h1>
          <p className="sub">{finding}</p>
        </div>
        <div className="actions">
          <Link className="btn primary" href={`/sheets?month=${thisYear}-${String(thisMonth).padStart(2, '0')}`}><Upload aria-hidden="true" />{t('ov.upload')}</Link>
        </div>
      </div>

      <section className="panel" aria-labelledby="year-h">
        <div className="panel-head">
          <h2 id="year-h">{t('ov.year', { year })}</h2>
          <div className="actions" style={{ display: 'flex', gap: 6 }}>
            <Link className="btn sm" href={`/?year=${year - 1}`} aria-label={String(year - 1)}><Prev aria-hidden="true" />{year - 1}</Link>
            {year < thisYear && <Link className="btn sm" href={`/?year=${year + 1}`} aria-label={String(year + 1)}>{year + 1}<Next aria-hidden="true" /></Link>}
          </div>
        </div>
        <div className="panel-body">
          <p className="hint" style={{ marginBottom: 14 }}>{t('ov.yearSub')}</p>
          <div className="year">
            {Array.from({ length: 12 }, (_, i) => i + 1).map((m) => {
              const s = byMonth.get(m);
              const later = year > thisYear || (year === thisYear && m > thisMonth);
              const isNow = year === thisYear && m === thisMonth;
              const before = !s && !isNow && (!first || year < first.y || (year === first.y && m < first.m));
              const cls = `month${s?.status === 'published' ? ' on' : ''}${later && !s ? ' later' : ''}${before && !later ? ' before' : ''}${isNow ? ' now' : ''}`;
              const href = s ? `/sheets/${s.id}` : `/sheets?month=${year}-${String(m).padStart(2, '0')}`;
              return (
                <Link key={m} className={cls} href={href} aria-label={`${monthName(lang, m)} ${year}`}>
                  <span className="m">{monthName(lang, m)}</span>
                  {s?.status === 'published' ? (
                    <span className="v">{count(lang, s.row_count)}<small>{t('sh.rows')}</small></span>
                  ) : s ? <span className="v"><span className="pill warn">{t('sh.draft')}</span></span>
                    : <span className="v" aria-label={later ? t('ov.later') : t('ov.notUploaded')}>{isNow ? t('ov.uploadIt') : later ? t('ov.later') : '—'}</span>}
                  {s && s.problem_count > 0 && <span className="flag" title={`${s.problem_count} ${t('sh.problems')}`} />}
                </Link>
              );
            })}
          </div>
        </div>
      </section>

      <div className="panel today">
        <section aria-labelledby="wait-h">
          <div className="panel-head">
            <h2 id="wait-h">{t('ov.waiting')} {openCount > 0 && <span className="muted num">· {count(lang, openCount)}</span>}</h2>
            {openCount > 0 && <Link className="meta" href="/disputes">{t('ov.viewAll')}</Link>}
          </div>
          <div className="panel-body">
            {disputes.length === 0 ? <p className="empty">{t('ov.noDisputes')}</p> : (
              <ul className="list">
                {disputes.map((d) => (
                  <li key={d.id}>
                    <Link className="row-link" href={`/disputes?id=${d.id}`}>
                      <span className="row-title">{d.employee_name || '—'}</span>
                      <span className="row-sub">{d.item || '—'}{d.period ? ` · ${periodLabel(lang, d.period)}` : ''}</span>
                      <span className="row-end"><span className="num">{t('dp.ticket', { n: d.ticket_no })}</span><br />{ago(t, d.created_at)}</span>
                    </Link>
                  </li>
                ))}
              </ul>
            )}
            {disputes.length < 3 && recent.length > 0 && (
              <div className="recent">
                <h3>{t('ov.recent')}</h3>
                <ul className="list">
                  {recent.slice(0, 3 - disputes.length + 1).map((d) => (
                    <li key={d.id}>
                      <Link className="row-link" href={`/disputes?tab=resolved&id=${d.id}`}>
                        <span className="row-title"><bdi>{d.employee_name || '—'}</bdi></span>
                        <span className="row-sub">{d.item || '—'}{d.period ? ` · ${periodLabel(lang, d.period)}` : ''}</span>
                        <span className="row-end">{ago(t, d.resolved_at)}</span>
                      </Link>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        </section>
        <section aria-labelledby="week-h">
          <div className="panel-head"><h2 id="week-h">{t('ov.week')}</h2></div>
          <div className="panel-body">
            <div className="strip">
              <div><div className="label">{t('ov.chats')}</div><div className="value num">{count(lang, week?.chats ?? 0)}</div></div>
              <div><div className="label">{t('ov.verified')}</div><div className="value num">{count(lang, week?.verified ?? 0)}</div></div>
              <div><div className="label">{t('ov.failed')}</div><div className="value num">{count(lang, week?.failed ?? 0)}</div></div>
            </div>
            <div className="asks">
              <div className="asks-head"><span>{t('ov.asks')}</span><Link className="meta muted small" href="/identity">{t('ov.change')}</Link></div>
              <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                {asked.map((f) => <span key={f} className="pill">{t(`f.${f}`)}</span>)}
              </div>
              {settings.phone_must_match_sender && <p className="hint" style={{ marginTop: 10 }}>{t(settings.hidden_number_ask_phone ? 'ov.phoneMatchHidden' : 'ov.phoneMatch')}</p>}
            </div>
          </div>
        </section>
      </div>
    </div>
  );
}
