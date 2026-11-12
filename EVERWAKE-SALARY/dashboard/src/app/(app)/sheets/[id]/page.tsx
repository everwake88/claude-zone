import Link from 'next/link';
import { notFound } from 'next/navigation';
import { ArrowRight, ArrowLeft, Search, TriangleAlert } from 'lucide-react';
import { getT } from '@/lib/auth';
import { q, one } from '@/lib/db';
import { getSettings, askedFields, FIELDS } from '@/lib/settings';
import { cell, count, dateTime, isNumeric } from '@/lib/format';
import { periodLabel, type Key } from '@/lib/i18n';
import { SheetForm, PublishButton, DeleteForm } from '@/components/SheetForms';
import { PageHeader } from '@/components/PageHeader';

const PAGE = 100;
type Sheet = { id: string; period: string; title: string; status: string; columns: { key: string; header: string; visible: boolean }[];
               identity: Record<string, string>; row_count: number; problem_count: number; published_at: string | null; file_name: string };

export default async function SheetPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ q?: string; bad?: string; p?: string }> }) {
  const { t, lang } = await getT();
  const { id } = await params;
  if (!/^[0-9a-f-]{36}$/.test(id)) notFound();
  const sp = await searchParams;
  const sheet = await one<Sheet>('select * from salary.payroll_sheets where id = $1', [id]);
  if (!sheet) notFound();
  const settings = await getSettings();
  const search = (sp.q || '').trim();
  const onlyBad = sp.bad === '1';
  const pageNo = Math.max(0, Number(sp.p) || 0);

  const where = `sheet_id = $1 and ($2 = '' or cells::text ilike '%' || $2 || '%' or name_norm like '%' || coalesce(salary.norm_name($2), '~') || '%')
                 and (not $3 or cardinality(problems) > 0)`;
  const [rows, total, existing] = await Promise.all([
    q<{ row_no: number; cells: Record<string, unknown>; problems: string[] }>(
      `select row_no, cells, problems from salary.payroll_rows where ${where} order by row_no limit ${PAGE} offset $4`, [id, search, onlyBad, pageNo * PAGE]),
    one<{ n: number }>(`select count(*)::int as n from salary.payroll_rows where ${where}`, [id, search, onlyBad]),
    one<{ id: string }>(`select id from salary.payroll_sheets where period = $1 and status = 'published' and id <> $2`, [sheet.period, id])
  ]);
  const n = total?.n ?? 0;
  const rawCols = new Set(Object.values(sheet.identity));
  const month = periodLabel(lang, sheet.period);
  const Back = lang === 'ar' ? ArrowRight : ArrowLeft;
  const asked = askedFields(settings);
  const hasId = !!(sheet.identity.national_id || sheet.identity.work_id);
  const missingAsked = asked.filter((f) => !sheet.identity[f]);
  if (settings.phone_must_match_sender && !sheet.identity.phone && !missingAsked.includes('phone')) missingAsked.push('phone');
  const link = (o: Record<string, string | number | undefined>) => {
    const u = new URLSearchParams();
    const v = { q: search || undefined, bad: onlyBad ? '1' : undefined, p: undefined, ...o };
    for (const [k, x] of Object.entries(v)) if (x !== undefined && x !== '') u.set(k, String(x));
    return `/sheets/${id}${u.size ? `?${u}` : ''}#rows`;
  };

  return (
    <div className="page">
      <PageHeader
        crumb={<Link className="crumb" href="/sheets"><Back aria-hidden="true" />{t('sd.back')}</Link>}
        title={month}
        sub={<>{sheet.status === 'published' ? t('sd.publishedNote', { date: dateTime(lang, sheet.published_at) }) : t('sd.draftNote')}
             <span className="small ltr" style={{ display: 'block', color: 'var(--muted)' }}>{sheet.file_name}</span></>}
        actions={sheet.status !== 'published' ? <PublishButton id={id} label={t('sd.publish', { month })} pending={t('sd.publishing')} disabled={!hasId} /> : undefined} />

      {(!hasId || missingAsked.length > 0 || (existing && sheet.status !== 'published')) && (
        <div className="stack rise" style={{ gap: 8, ['--i' as string]: 1 }}>
          {!hasId && <p className="notice neg"><TriangleAlert aria-hidden="true" />{t('sd.needId')}</p>}
          {missingAsked.map((f) => <p key={f} className="notice"><TriangleAlert aria-hidden="true" />{t('sd.needAsked', { field: t(`f.${f}`) })}</p>)}
          {existing && sheet.status !== 'published' && <p className="notice plain">{t('sh.replaceWarn', { month })}</p>}
        </div>
      )}

      <SheetForm id={id} title={sheet.title} columns={sheet.columns} identity={sheet.identity} words={{
        identity: t('sd.identity'), identitySub: t('sd.identitySub'), notInSheet: t('sd.notInSheet'), columns: t('sd.columns'),
        columnsSub: t('sd.columnsSub'), save: t('sd.save'), saving: t('sh.reading'), titleField: t('sh.titleField'),
        fields: Object.fromEntries(FIELDS.map((f) => [f, t(`f.${f}`)]))
      }} />

      <section className="panel rise" style={{ ['--i' as string]: 3 }} id="rows" aria-labelledby="rows-h">
        <div className="panel-head">
          <h2 id="rows-h">{t('sd.rows')}</h2>
          <span className="meta">{t('sd.rowsSub', { n: count(lang, sheet.row_count), p: count(lang, sheet.problem_count) })}</span>
        </div>
        <div className="panel-body" style={{ paddingBottom: 12 }}>
          <form method="get" action={`/sheets/${id}#rows`} style={{ display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'center' }}>
            <div style={{ position: 'relative', flex: '1 1 260px', maxWidth: 360 }}>
              <Search aria-hidden="true" style={{ position: 'absolute', insetInlineStart: 12, top: 11, width: 16, height: 16, color: 'var(--muted)' }} />
              <input className="input" name="q" defaultValue={search} placeholder={t('sd.search')} aria-label={t('sd.search')} style={{ paddingInlineStart: 36 }} />
            </div>
            <label style={{ display: 'flex', gap: 8, alignItems: 'center', cursor: 'pointer' }}>
              <input type="checkbox" name="bad" value="1" defaultChecked={onlyBad} style={{ width: 16, height: 16, accentColor: 'var(--text)' }} />
              {t('sd.onlyProblems')}
            </label>
            <button className="btn sm" type="submit">{t('sd.find')}</button>
          </form>
        </div>
        {rows.length === 0 ? <div className="panel-body"><p className="empty">{search ? t('sd.noMatch', { q: search }) : t('sh.none')}</p></div> : (
          <div className="sheet-wrap" tabIndex={0} aria-label={t('sd.rows')}>
            <table className="sheet">
              <thead><tr>
                <th>{t('sd.row')}</th>
                {sheet.columns.map((c) => <th key={c.key} className={`${c.visible ? '' : 'off'}`} title={c.visible ? t('sd.visible') : t('sd.hidden')}>{c.header}</th>)}
              </tr></thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.row_no} className={r.problems.length ? 'bad' : ''}>
                    <td className="num">
                      {r.row_no}
                      {r.problems.length > 0 && <div className="probs">{r.problems.map((p) => <span key={p} className="pill neg">{t(`sd.problem.${p}` as Key)}</span>)}</div>}
                    </td>
                    {sheet.columns.map((c) => {
                      const v = r.cells[c.key];
                      return <td key={c.key} className={`${isNumeric(v) ? 'num' : ''} ${c.visible ? '' : 'off'}`}>{cell(lang, v, rawCols.has(c.key))}</td>;
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {n > PAGE && (
          <div className="panel-body" style={{ display: 'flex', gap: 8, alignItems: 'center', justifyContent: 'space-between' }}>
            <span className="muted num">{t('sd.range', { a: pageNo * PAGE + 1, b: Math.min(n, (pageNo + 1) * PAGE), n: count(lang, n) })}</span>
            <span style={{ display: 'flex', gap: 8 }}>
              {pageNo > 0 && <Link className="btn sm" href={link({ p: pageNo - 1 })}>{t('sd.prev')}</Link>}
              {(pageNo + 1) * PAGE < n && <Link className="btn sm" href={link({ p: pageNo + 1 })}>{t('sd.next')}</Link>}
            </span>
          </div>
        )}
      </section>

      <section className="section" aria-labelledby="del-h" style={{ borderTop: '1px solid var(--border)', paddingTop: 28 }}>
        <header><h2 id="del-h">{t('sd.delete')}</h2><p>{t('sd.deleteSub', { month })}</p></header>
        <DeleteForm id={id} words={{ confirm: t('sd.deleteConfirm', { month: sheet.period.slice(0, 7) }), button: t('sd.deleteBtn', { month }) }} />
      </section>
    </div>
  );
}
