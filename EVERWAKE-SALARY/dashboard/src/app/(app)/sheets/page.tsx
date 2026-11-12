import Link from 'next/link';
import { getT } from '@/lib/auth';
import { q } from '@/lib/db';
import { count, dateTime } from '@/lib/format';
import { periodLabel } from '@/lib/i18n';
import { UploadForm } from '@/components/UploadForm';

type Row = { id: string; period: string; title: string; row_count: number; problem_count: number; status: string; uploaded_at: string; by: string | null };

export default async function Sheets({ searchParams }: { searchParams: Promise<{ month?: string }> }) {
  const { t, lang } = await getT();
  const sp = await searchParams;
  const rows = await q<Row>(`select s.id, s.period, s.title, s.row_count, s.problem_count, s.status, s.uploaded_at, u.name as by
                             from salary.payroll_sheets s left join salary.hr_users u on u.id = s.uploaded_by
                             order by s.period desc, s.uploaded_at desc`);
  const now = new Date(new Date().toLocaleString('en-US', { timeZone: 'Africa/Cairo' }));
  const defaultMonth = /^\d{4}-\d{2}$/.test(sp.month || '') ? sp.month! : `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
  const published = Object.fromEntries(rows.filter((r) => r.status === 'published').map((r) => [r.period.slice(0, 7), periodLabel(lang, r.period)]));

  return (
    <div className="page">
      <div className="title-row">
        <div>
          <h1>{t('sh.title')}</h1>
          <p className="sub">{t('sh.sub')}</p>
        </div>
      </div>
      <div className="grid-2">
        <section className="panel" aria-labelledby="months-h">
          <div className="panel-head">
            <h2 id="months-h">{t('nav.sheets')}</h2>
            <span className="meta num">{count(lang, rows.length)}</span>
          </div>
          <div className="panel-body">
            {rows.length === 0 ? <p className="empty">{t('sh.none')}</p> : (
              <div className="table-wrap">
                <table className="t collapse">
                  <thead><tr>
                    <th>{t('sh.month')}</th><th className="num">{t('sh.rows')}</th><th className="num">{t('sh.problems')}</th>
                    <th>{t('sh.status')}</th><th>{t('sh.uploaded')}</th>
                  </tr></thead>
                  <tbody>
                    {rows.map((r) => (
                      <tr key={r.id}>
                        <td><Link className="cell-link" href={`/sheets/${r.id}`}>{periodLabel(lang, r.period)}</Link><div className="small muted">{r.title}</div></td>
                        <td className="num no-phone">{count(lang, r.row_count)}</td>
                        <td className="num no-phone">{r.problem_count ? <span style={{ color: 'var(--negative)' }}>{count(lang, r.problem_count)}</span> : '0'}</td>
                        <td>{r.status === 'published' ? <span className="pill pos">{t('sh.published')}</span> : <span className="pill warn">{t('sh.draft')}</span>}</td>
                        <td data-l2 className="small muted">
                          <span className="only-phone">{t('sd.rowsSub', { n: count(lang, r.row_count), p: count(lang, r.problem_count) })} · </span>
                          {dateTime(lang, r.uploaded_at)}{r.by ? ` · ${r.by}` : ''}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </section>
        <section className="panel" aria-labelledby="up-h" id="upload">
          <div className="panel-head"><h2 id="up-h">{t('sh.uploadTitle')}</h2></div>
          <div className="panel-body">
            <UploadForm defaultMonth={defaultMonth} published={published} words={{
              file: t('sh.file'), fileHint: t('sh.fileHint'), period: t('sh.period'), title: t('sh.titleField'),
              titleHint: t('sh.titleHint', { month: periodLabel(lang, defaultMonth) }), read: t('sh.read'), reading: t('sh.reading'),
              replaceWarn: t('sh.replaceWarn')
            }} />
          </div>
        </section>
      </div>
    </div>
  );
}
