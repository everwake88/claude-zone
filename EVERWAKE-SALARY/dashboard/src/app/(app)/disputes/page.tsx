import Link from 'next/link';
import { getT } from '@/lib/auth';
import { q, one } from '@/lib/db';
import { ago, cell, dateTime, count } from '@/lib/format';
import { periodLabel } from '@/lib/i18n';
import { resolveDispute } from '../../actions';
import { ReplyForm } from '@/components/ReplyForm';
import { Submit } from '@/components/Submit';
import { PageHeader } from '@/components/PageHeader';
import { Segmented } from '@/components/Segmented';
import { LiveRefresh } from '@/components/LiveRefresh';

type D = { id: string; ticket_no: number; employee_name: string | null; item: string; details: string; period: string | null; status: string;
           hr_note: string; created_at: string; resolved_at: string | null; resolver: string | null; conversation_id: string; person_key: string | null };

export default async function Disputes({ searchParams }: { searchParams: Promise<{ tab?: string; id?: string }> }) {
  const { t, lang } = await getT();
  const sp = await searchParams;
  const tab = sp.tab === 'resolved' ? 'resolved' : 'open';
  const [list, counts] = await Promise.all([
    q<D>(`select d.*, u.name as resolver from salary.disputes d left join salary.hr_users u on u.id = d.resolved_by
          where d.status = $1 order by ${tab === 'open' ? 'd.created_at' : 'd.resolved_at desc'} limit 200`, [tab]),
    one<{ open: number; resolved: number }>(`select count(*) filter (where status = 'open')::int as open, count(*) filter (where status = 'resolved')::int as resolved from salary.disputes`)
  ]);
  const sel = !sp.id ? list[0] ?? null : await one<D>(`select d.*, u.name as resolver from salary.disputes d left join salary.hr_users u on u.id = d.resolved_by where d.id::text = $1`, [sp.id]);
  // their row for that month, as the agent showed it (visible columns only)
  const row = sel?.person_key && sel.period ? await one<{ items: { column: string; value: unknown }[] }>(
    `select coalesce(jsonb_agg(jsonb_build_object('column', col ->> 'header', 'value', r.cells -> (col ->> 'key')) order by ord), '[]') as items
     from salary.payroll_rows r join salary.payroll_sheets s on s.id = r.sheet_id,
          jsonb_array_elements(s.columns) with ordinality as c(col, ord)
     where s.status = 'published' and s.period = $1 and r.person_key = $2 and coalesce((col ->> 'visible')::boolean, true)
       and coalesce(r.cells ->> (col ->> 'key'), '') <> ''`, [sel.period, sel.person_key]) : null;
  const tabHref = (x: string) => `/disputes?tab=${x}`;

  return (
    <div className="page">
      <PageHeader title={t('dp.title')} sub={t('dp.sub')} live={<LiveRefresh label={t('hd.live')} />} />
      <div className="rise" style={{ ['--i' as string]: 1 }}>
        <Segmented label={t('dp.title')} current={tab} options={[
          { key: 'open', href: tabHref('open'), label: <>{t('dp.open')}<span className="n num">{count(lang, counts?.open ?? 0)}</span></> },
          { key: 'resolved', href: tabHref('resolved'), label: <>{t('dp.resolved')}<span className="n num">{count(lang, counts?.resolved ?? 0)}</span></> }]} />
      </div>
      <div className="split">
        <section className="panel rise" aria-label={t('dp.title')} style={{ padding: 6, ['--i' as string]: 2 }}>
          {list.length === 0 ? <p className="empty" style={{ margin: 8 }}>{tab === 'open' ? t('dp.none') : t('dp.noneResolved')}</p> : (
            <ul className="list picklist">
              {list.map((d) => (
                <li key={d.id}>
                  <Link href={`/disputes?tab=${tab}&id=${d.id}`} aria-current={sel?.id === d.id ? 'true' : undefined}>
                    <span className="row-title"><bdi>{d.employee_name || '—'}</bdi></span>
                    <span className="row-sub">{d.item || '—'}{d.period ? ` · ${periodLabel(lang, d.period)}` : ''}</span>
                    <span className="row-end"><span className="num">{t('dp.ticket', { n: d.ticket_no })}</span><br />{ago(t, tab === 'open' ? d.created_at : d.resolved_at)}</span>
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </section>

        {!sel ? <p className="empty detail-empty">{t('dp.pick')}</p> : (
          <section className="panel rise" style={{ ['--i' as string]: 3 }} aria-labelledby="d-h">
            <div className="panel-head">
              <h2 id="d-h">{sel.employee_name || '—'}</h2>
              <span className="meta num">{t('dp.ticket', { n: sel.ticket_no })} · {dateTime(lang, sel.created_at)}</span>
            </div>
            <div className="panel-body detail-cols">
             <div className="stack">
              <dl className="kv">
                <div><dt>{t('dp.item')}</dt><dd>{sel.item || '—'}</dd></div>
                <div><dt>{t('dp.month')}</dt><dd>{sel.period ? periodLabel(lang, sel.period) : '—'}</dd></div>
              </dl>
              <div className="field">
                <span className="label">{t('dp.theyWrote')}</span>
                <p className="quote" dir="auto">{sel.details}</p>
              </div>
              <Link className="btn sm" href={`/conversations?id=${sel.conversation_id}`} style={{ justifySelf: 'start' }}>{t('dp.chat')}</Link>
              <ReplyForm id={sel.id} words={{ reply: t('dp.reply'), hint: t('dp.replyHint'), send: t('dp.send') }} />
              <form action={resolveDispute} className="form" style={{ borderTop: '1px solid var(--rule)', paddingTop: 16 }}>
                <input type="hidden" name="id" value={sel.id} />
                {sel.status === 'open' ? (
                  <>
                    <div className="field">
                      <label htmlFor="note">{t('dp.note')}</label>
                      <input className="input" id="note" name="note" defaultValue={sel.hr_note} />
                    </div>
                    <div className="form-foot"><Submit>{t('dp.resolve')}</Submit></div>
                  </>
                ) : (
                  <>
                    <p className="hint">{t('dp.resolvedBy', { date: dateTime(lang, sel.resolved_at), name: sel.resolver || '—' })}{sel.hr_note ? ` · ${sel.hr_note}` : ''}</p>
                    <input type="hidden" name="reopen" value="1" />
                    <div className="form-foot"><Submit className="btn">{t('dp.reopen')}</Submit></div>
                  </>
                )}
              </form>
             </div>
             <div className="stack">
              {sel.period && (
                <div className="field">
                  <span className="label">{t('dp.theirRow', { month: periodLabel(lang, sel.period) })}</span>
                  {row?.items?.length ? (
                    <dl className="kv">
                      {row.items.map((i) => (
                        <div key={i.column}><dt style={i.column === sel.item ? { color: 'var(--text)', fontWeight: 600 } : undefined}>{i.column}</dt>
                          <dd className="num" style={i.column === sel.item ? { color: 'var(--accent)' } : undefined}>{cell(lang, i.value)}</dd></div>
                      ))}
                    </dl>
                  ) : <p className="empty">{t('dp.noRow')}</p>}
                </div>
              )}
             </div>
            </div>
          </section>
        )}
      </div>
    </div>
  );
}
