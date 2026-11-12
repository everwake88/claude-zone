import Link from 'next/link';
import { Search, ShieldCheck } from 'lucide-react';
import { getT } from '@/lib/auth';
import { q, one } from '@/lib/db';
import { ago, phone, dateTime } from '@/lib/format';
import type { Key } from '@/lib/i18n';
import { Chat, type Msg } from '@/components/Chat';

type C = { id: string; wa_id: string; phone: string | null; push_name: string | null; employee_name: string | null; verified_at: string | null;
           last: string | null; last_at: string | null };

export default async function Conversations({ searchParams }: { searchParams: Promise<{ id?: string; q?: string }> }) {
  const { t, lang } = await getT();
  const sp = await searchParams;
  const search = (sp.q || '').trim();
  const list = await q<C>(`select c.id, c.wa_id, c.phone, c.push_name, c.employee_name, c.verified_at, m.text as last, m.created_at as last_at
     from salary.conversations c
     left join lateral (select text, created_at from salary.messages where conversation_id = c.id order by id desc limit 1) m on true
     where $1 = '' or c.employee_name ilike '%' || $1 || '%' or c.push_name ilike '%' || $1 || '%' or c.wa_id like '%' || regexp_replace($1, '\\D', '', 'g') || '%'
     order by m.created_at desc nulls last limit 200`, [search]);
  const sel = !sp.id ? list[0] ?? null : list.find((c) => c.id === sp.id) ?? await one<C>(`select id, wa_id, phone, push_name, employee_name, verified_at, null as last, null as last_at from salary.conversations where id::text = $1`, [sp.id]);
  const [messages, attempts] = sel ? await Promise.all([
    q<Msg>(`select * from (select id, direction, author, text, created_at, send_error from salary.messages where conversation_id = $1 order by id desc limit 200) x order by id`, [sel.id]),
    q<{ result: string; given: Record<string, string>; created_at: string }>(`select result, given, created_at from salary.identity_attempts where conversation_id = $1 order by id desc limit 20`, [sel.id])
  ]) : [[], []];
  const name = (c: C) => c.employee_name || c.push_name || phone(c.phone || c.wa_id);
  const selId = sel?.id;

  return (
    <div className="page">
      <div className="title-row">
        <div>
          <h1>{t('cv.title')}</h1>
          <p className="sub">{t('cv.sub')}</p>
        </div>
      </div>
      <div className="split">
        <section className="panel" aria-label={t('cv.title')} style={{ padding: 6 }}>
          <form method="get" style={{ position: 'relative', margin: 8 }}>
            <Search aria-hidden="true" style={{ position: 'absolute', insetInlineStart: 12, top: 11, width: 16, height: 16, color: 'var(--muted)' }} />
            <input className="input" name="q" defaultValue={search} placeholder={t('cv.search')} aria-label={t('cv.search')} style={{ paddingInlineStart: 36 }} />
          </form>
          {list.length === 0 ? <p className="empty" style={{ margin: 8 }}>{t('cv.none')}</p> : (
            <ul className="list picklist">
              {list.map((c) => (
                <li key={c.id}>
                  <Link href={`/conversations?id=${c.id}${search ? `&q=${encodeURIComponent(search)}` : ''}`} aria-current={selId === c.id ? 'true' : undefined}>
                    <span className="row-title"><bdi>{name(c)}</bdi>{c.verified_at && <ShieldCheck aria-label={t('cv.verified')} />}</span>
                    <span className="row-sub"><bdi>{c.last || '—'}</bdi></span>
                    <span className="row-end">{ago(t, c.last_at)}</span>
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </section>
        {!sel ? <p className="empty detail-empty">{t('cv.pick')}</p> : (
          <div className="stack">
            <section className="panel" aria-labelledby="c-h">
              <div className="panel-head">
                <h2 id="c-h"><bdi>{name(sel)}</bdi></h2>
                {(sel.employee_name || sel.push_name || !sel.phone) && <span className="meta ltr">{sel.phone ? phone(sel.phone) : t('cv.hiddenNumber')}</span>}
              </div>
              <div className="panel-body stack">
                <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                  {sel.verified_at ? <span className="pill pos">{t('cv.verified')} · {dateTime(lang, sel.verified_at)}</span> : <span className="pill">{t('cv.notVerified')}</span>}
                </div>
                <Chat messages={messages} lang={lang} hrLabel={t('cv.hr')} />
              </div>
            </section>
            <section className="panel" aria-labelledby="a-h">
              <div className="panel-head"><h2 id="a-h">{t('cv.attempts')}</h2></div>
              <div className="panel-body">
                {attempts.length === 0 ? <p className="empty">{t('cv.noAttempts')}</p> : (
                  <table className="t collapse">
                    <tbody>
                      {attempts.map((a, i) => (
                        <tr key={i}>
                          <td><span className={`pill ${a.result === 'verified' ? 'pos' : 'neg'}`}>{t(`cv.r.${a.result}` as Key)}</span></td>
                          <td data-l2 className="small muted">{Object.values(a.given).filter(Boolean).map((v, j) => <span key={j}>{j > 0 && ' · '}<bdi>{v}</bdi></span>)}</td>
                          <td className="num small muted">{dateTime(lang, a.created_at)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </div>
            </section>
          </div>
        )}
      </div>
    </div>
  );
}
