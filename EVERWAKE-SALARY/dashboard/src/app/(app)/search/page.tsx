import Link from 'next/link';
import { Search } from 'lucide-react';
import { getT } from '@/lib/auth';
import { q } from '@/lib/db';
import { ago, phone, initials, tint } from '@/lib/format';
import { periodLabel } from '@/lib/i18n';
import { PageHeader } from '@/components/PageHeader';

type Person = { person_key: string; name: string | null; work_id: string | null; months: number; latest_period: string; sheet_id: string; row_no: number };
type Chat = { id: string; name: string | null; phone: string | null; wa_id: string; verified: boolean; last_at: string | null };


// One box for "where is this person": their payroll months and their chats with the agent.
export default async function SearchPage({ searchParams }: { searchParams: Promise<{ q?: string }> }) {
  const { t, lang } = await getT();
  const term = ((await searchParams).q || '').trim().slice(0, 80);
  const [people, chats] = term.length < 2 ? [[], []] : await Promise.all([
    q<Person>(`
      select distinct on (r.person_key) r.person_key,
             r.cells ->> (s.identity ->> 'full_name') as name, r.cells ->> (s.identity ->> 'work_id') as work_id,
             count(*) over (partition by r.person_key)::int as months, s.period as latest_period, s.id as sheet_id, r.row_no
      from salary.payroll_rows r join salary.payroll_sheets s on s.id = r.sheet_id
      where s.status = 'published' and r.person_key is not null
        and (r.name_norm like '%' || coalesce(salary.norm_name($1), '~') || '%' or r.national_id = salary.digits($1)
             or r.work_id = salary.norm_work_id($1) or r.phone = salary.norm_phone($1))
      order by r.person_key, s.period desc limit 30`, [term]),
    q<Chat>(`
      select c.id, coalesce(c.employee_name, c.push_name) as name, c.phone, c.wa_id, c.verified_at is not null as verified, c.last_inbound_at as last_at
      from salary.conversations c
      where c.employee_name ilike '%' || $1 || '%' or c.push_name ilike '%' || $1 || '%'
         or (length(salary.digits($1)) >= 4 and c.wa_id like '%' || salary.digits($1) || '%')
      order by c.last_inbound_at desc nulls last limit 20`, [term])
  ]);

  return (
    <div className="page">
      <PageHeader title={t('s.title')} sub={term ? t('s.for', { q: term }) : t('s.hint')} />
      <form action="/search" role="search" className="search rise" style={{ width: '100%', maxWidth: 560, ['--i' as string]: 1 }}>
        <input name="q" defaultValue={term} placeholder={t('hd.search')} aria-label={t('hd.search')} autoFocus={!term} />
        <button type="submit" aria-label={t('s.title')}><Search aria-hidden="true" /></button>
      </form>
      {term.length >= 2 && (
        <div className="grid-even">
          <section className="card rise" style={{ ['--i' as string]: 2 }} aria-labelledby="sp-h">
            <div className="panel-head"><h2 id="sp-h">{t('s.employees')}</h2><span className="meta num">{people.length}</span></div>
            <div className="panel-body">
              {people.length === 0 ? <p className="empty">{t('s.none', { q: term })}</p> : (
                <div className="feed">
                  {people.map((p) => (
                    <Link key={p.person_key} className="found" href={`/sheets/${p.sheet_id}?q=${encodeURIComponent(p.name || p.work_id || '')}#rows`}>
                      <span className={`avatar ${tint(p.name || '')}`} aria-hidden="true">{initials(p.name || '؟')}</span>
                      <span style={{ minWidth: 0 }}>
                        <span className="name" style={{ display: 'block' }}><bdi>{p.name || '—'}</bdi></span>
                        <span className="what" style={{ display: 'block' }}>
                          {p.work_id ? <bdi className="num">{p.work_id}</bdi> : null}{p.work_id ? ' · ' : ''}{t('s.months', { n: p.months })}
                        </span>
                      </span>
                      <span className="pill sage">{periodLabel(lang, p.latest_period)}</span>
                    </Link>
                  ))}
                </div>
              )}
            </div>
          </section>
          <section className="card rise" style={{ ['--i' as string]: 3 }} aria-labelledby="sc-h">
            <div className="panel-head"><h2 id="sc-h">{t('nav.conversations')}</h2><span className="meta num">{chats.length}</span></div>
            <div className="panel-body">
              {chats.length === 0 ? <p className="empty">{t('s.none', { q: term })}</p> : (
                <div className="feed">
                  {chats.map((c) => (
                    <Link key={c.id} className="found" href={`/conversations?id=${c.id}`}>
                      <span className={`avatar ${tint(c.name || c.wa_id)}`} aria-hidden="true">{initials(c.name || '#')}</span>
                      <span style={{ minWidth: 0 }}>
                        <span className="name" style={{ display: 'block' }}><bdi>{c.name || phone(c.phone || c.wa_id)}</bdi></span>
                        <span className="what" style={{ display: 'block' }}>{c.phone ? <bdi className="ltr">{phone(c.phone)}</bdi> : t('cv.hiddenNumber')} · {ago(t, c.last_at)}</span>
                      </span>
                      {c.verified ? <span className="pill pos">{t('cv.verified')}</span> : <span className="pill">{t('cv.notVerified')}</span>}
                    </Link>
                  ))}
                </div>
              )}
            </div>
          </section>
        </div>
      )}
    </div>
  );
}
