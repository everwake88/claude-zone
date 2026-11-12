import Link from 'next/link';
import { ArrowUpRight, Plus, Fingerprint } from 'lucide-react';
import { getT, requireUser } from '@/lib/auth';
import { one } from '@/lib/db';
import { askedFields, type Settings } from '@/lib/settings';
import { ago, count, firstName, initials, tint } from '@/lib/format';
import { periodLabel } from '@/lib/i18n';
import { PageHeader } from '@/components/PageHeader';
import { LiveRefresh } from '@/components/LiveRefresh';
import { CountUp } from '@/components/CountUp';
import { Segmented } from '@/components/Segmented';
import { AreaChart } from '@/components/AreaChart';
import { AgentSwitch } from '@/components/AgentSwitch';
import { Sparkline, MiniBars, Gauge } from '@/components/charts';

type Sheet = { id: string; period: string; title: string; row_count: number; problem_count: number; status: string };
type Dispute = { id: string; ticket_no: number; employee_name: string | null; item: string; period: string | null; created_at: string };
type Overview = {
  latest: Sheet | null; months: { period: string; row_count: number }[]; pile: Sheet[];
  daily: { d: string; n: number }[]; dispute_days: number[];
  month_messages: number; prev_month_messages: number; month_verified: number;
  checks_passed: number; checks_total: number;
  today_chats: number; today_verified: number; today_replies: number;
  open: number; oldest_open: string | null; waiting: Dispute[]; settings: Settings;
};

// Everything on this page in one trip to the database: the page waits for one answer, not seven.
const OVERVIEW = `
with c as (select now() at time zone 'Africa/Cairo' as now_c),
b as (select (date_trunc('month', now_c) at time zone 'Africa/Cairo') as m0,
             ((date_trunc('month', now_c) - interval '1 month') at time zone 'Africa/Cairo') as m1,
             (date_trunc('day', now_c) at time zone 'Africa/Cairo') as d0, now_c::date as today from c)
select json_build_object(
  'latest', (select row_to_json(x) from (select id, period, title, row_count, problem_count, status from salary.payroll_sheets
             where status = 'published' order by period desc limit 1) x),
  'months', (select coalesce(json_agg(x order by x.period), '[]') from (select period, row_count from salary.payroll_sheets
             where status = 'published' order by period desc limit 6) x),
  'pile', (select coalesce(json_agg(x order by x.period desc), '[]') from (select distinct on (period) id, period, title, row_count, problem_count, status
             from salary.payroll_sheets order by period desc, (status = 'published') desc, uploaded_at desc limit 3) x),
  'daily', (select coalesce(json_agg(json_build_object('d', to_char(g.d, 'YYYY-MM-DD'), 'n', coalesce(m.n, 0)) order by g.d), '[]')
            from b, generate_series(b.today - ($1::int - 1), b.today, interval '1 day') g(d)
            left join (select (created_at at time zone 'Africa/Cairo')::date as d, count(*)::int as n from salary.messages
                       where direction = 'in' and created_at > now() - make_interval(days => $1::int + 1) group by 1) m on m.d = g.d::date),
  'dispute_days', (select coalesce(json_agg(coalesce(m.n, 0) order by g.d), '[]')
            from b, generate_series(b.today - 13, b.today, interval '1 day') g(d)
            left join (select (created_at at time zone 'Africa/Cairo')::date as d, count(*)::int as n from salary.disputes
                       where created_at > now() - interval '15 days' group by 1) m on m.d = g.d::date),
  'month_messages', (select count(*)::int from salary.messages, b where direction = 'in' and created_at >= b.m0),
  'prev_month_messages', (select count(*)::int from salary.messages, b where direction = 'in' and created_at >= b.m1 and created_at < b.m0),
  'month_verified', (select count(distinct conversation_id)::int from salary.identity_attempts, b where result = 'verified' and created_at >= b.m0),
  'checks_passed', (select count(*)::int from salary.identity_attempts where result = 'verified' and created_at > now() - interval '30 days'),
  'checks_total', (select count(*)::int from salary.identity_attempts where created_at > now() - interval '30 days'),
  'today_chats', (select count(distinct conversation_id)::int from salary.messages, b where direction = 'in' and created_at >= b.d0),
  'today_verified', (select count(distinct conversation_id)::int from salary.identity_attempts, b where result = 'verified' and created_at >= b.d0),
  'today_replies', (select count(*)::int from salary.messages, b where author = 'agent' and created_at >= b.d0),
  'open', (select count(*)::int from salary.disputes where status = 'open'),
  'oldest_open', (select min(created_at) from salary.disputes where status = 'open'),
  'waiting', (select coalesce(json_agg(x order by x.created_at), '[]') from (select id, ticket_no, employee_name, item, period, created_at
              from salary.disputes where status = 'open' order by created_at limit 3) x),
  'settings', (select row_to_json(s) from salary.settings s)
) as r`;

const RANGES = [7, 30, 90];

export default async function OverviewPage({ searchParams }: { searchParams: Promise<{ range?: string }> }) {
  const user = await requireUser();
  const { t, lang } = await getT();
  const range = RANGES.includes(Number((await searchParams).range)) ? Number((await searchParams).range) : 30;
  const o = (await one<{ r: Overview }>(OVERVIEW, [range]))!.r;
  const s = o.settings;
  const locale = lang === 'ar' ? 'ar-EG-u-nu-latn' : 'en-GB';
  const first = firstName(user.name || '');

  const finding = !o.latest ? t('ov.findingNoSheet')
    : o.open === 2 ? t('ov.findingTwo', { age: ago(t, o.oldest_open) })
    : o.open > 1 ? t('ov.findingDisputes', { n: o.open, age: ago(t, o.oldest_open) })
    : o.open === 1 ? t('ov.findingOne', { age: ago(t, o.oldest_open) })
    : t('ov.findingNone', { month: periodLabel(lang, o.latest.period) });

  const rangeTotal = o.daily.reduce((a, p) => a + p.n, 0);
  const busiest = o.daily.reduce<{ d: string; n: number } | null>((a, p) => (p.n > (a?.n ?? 0) ? p : a), null);
  const day = new Intl.DateTimeFormat(locale, { day: 'numeric', month: 'short' });
  const verifiedShare = o.latest?.row_count ? Math.min(1, o.month_verified / o.latest.row_count) : null;
  const passShare = o.checks_total ? o.checks_passed / o.checks_total : null;
  const asked = askedFields(s);

  return (
    <div className="page">
      <PageHeader title={first ? t('hd.hello', { name: `\u2068${first}\u2069` }) : t('ov.title')} sub={finding} live={<LiveRefresh label={t('hd.live')} />} />

      <div className="ov">
        {/* the four figures HR reads first */}
        <Link href={o.latest ? `/sheets/${o.latest.id}` : '/sheets'} className="card kpi rise" style={{ ['--i' as string]: 1 }}>
          <span className="label">{t('k.employees')}</span>
          <span className="value"><CountUp value={o.latest?.row_count ?? 0} locale={locale} /></span>
          <span className="note">{o.latest ? periodLabel(lang, o.latest.period) : t('k.noMonth')}</span>
          <span className="viz"><MiniBars values={o.months.map((m) => m.row_count)} /></span>
        </Link>
        <Link href="/conversations" className="card kpi rise" style={{ ['--i' as string]: 2 }}>
          <span className="label">{t('k.messages')}</span>
          <span className="value"><CountUp value={o.month_messages} locale={locale} /></span>
          <span className="note">{t('k.messagesSub', { n: count(lang, o.prev_month_messages) })}</span>
          <span className="viz"><Sparkline values={o.daily.slice(-14).map((p) => p.n)} /></span>
        </Link>
        <Link href="/conversations" className="card kpi rise" style={{ ['--i' as string]: 3 }}>
          <span className="label">{t('k.verified')}</span>
          <span className="value"><CountUp value={o.month_verified} locale={locale} /></span>
          <span className="note" style={{ gridColumn: '1 / -1' }}>
            {verifiedShare == null ? t('k.noMonth') : t('k.verifiedSub', { p: Math.round(verifiedShare * 100) })}
            {verifiedShare != null && <span className="meter" aria-hidden="true"><i style={{ ['--p' as string]: `${Math.max(2, verifiedShare * 100)}%` }} /></span>}
          </span>
        </Link>
        <Link href="/disputes" className="card kpi filled rise" style={{ ['--i' as string]: 4 }}>
          <span className="go" aria-hidden="true"><ArrowUpRight className="flip" /></span>
          <span className="label">{t('k.waiting')}</span>
          <span className="value"><CountUp value={o.open} locale={locale} /></span>
          <span className="note">{o.open ? t('k.waitingSub', { age: ago(t, o.oldest_open) }) : t('k.waitingNone')}</span>
          <span className="viz"><Sparkline values={o.dispute_days} /></span>
        </Link>

        {/* the employees' messages over time */}
        <section className="card activity w2 rise" style={{ ['--i' as string]: 5 }} aria-labelledby="act-h">
          <div className="top">
            <h2 id="act-h">{t('a.title')}</h2>
            <Segmented label={t('a.title')} current={String(range)}
                       options={RANGES.map((r) => ({ key: String(r), href: `/?range=${r}`, label: t('a.range', { n: r }) }))} />
          </div>
          <div style={{ position: 'relative', flex: 1, display: 'flex', flexDirection: 'column' }}>
            <div className="chips">
              <div className="chip"><div className="k">{t('a.messages')}</div><div className="v num">{count(lang, rangeTotal)}</div></div>
              {busiest && <div className="chip"><div className="k">{t('a.busiest')}</div><div className="v">{day.format(new Date(busiest.d + 'T12:00:00'))}<small className="pill sage num">{busiest.n}</small></div></div>}
            </div>
            <AreaChart data={o.daily} locale={locale} unit={t('a.unit')} empty={t('a.empty')} />
          </div>
        </section>

        {/* how often the identity check succeeds */}
        <section className="card gauge-card rise" style={{ ['--i' as string]: 6 }} aria-labelledby="g-h">
          <h2 id="g-h">{t('g.title')}</h2>
          <span className="meta">{t('g.sub')}</span>
          <div className="big num">{passShare == null ? '—' : <CountUp value={o.checks_passed} locale={locale} />}</div>
          <span className="detail">{passShare == null ? t('g.none') : t('g.of', { b: count(lang, o.checks_total) })}</span>
          <Gauge share={passShare} label={passShare == null ? t('g.none') : `${Math.round(passShare * 100)}%`} />
        </section>

        {/* the agent herself */}
        <section className={`card agent rise${s.agent_enabled ? '' : ' off'}`} style={{ ['--i' as string]: 7 }} aria-labelledby="ag-h">
          <div className="face" aria-hidden="true">{[...(s.agent_name || 'ن')][0]}</div>
          <h2 id="ag-h">{s.agent_name}</h2>
          <p className="role">{t('ag.role', { company: s.company_name })}</p>
          <span className={`pill state ${s.agent_enabled ? 'pos' : ''}`}>
            <i className={`dot${s.agent_enabled ? ' pulse' : ''}`} aria-hidden="true" />{s.agent_enabled ? t('ag.on') : t('ag.off')}
          </span>
          <div className="stats">
            <div><div className="v num"><CountUp value={o.today_chats} locale={locale} /></div><div className="k">{t('ag.chats')}</div></div>
            <div><div className="v num"><CountUp value={o.today_verified} locale={locale} /></div><div className="k">{t('ag.verified')}</div></div>
            <div><div className="v num"><CountUp value={o.today_replies} locale={locale} /></div><div className="k">{t('ag.replies')}</div></div>
          </div>
          <div className="toggle"><span>{t('ag.switch')}</span><AgentSwitch on={s.agent_enabled} label={t('ag.switch')} /></div>
        </section>

        {/* the payroll months, as a pile of payslips */}
        <section className="card months w2 rise" style={{ ['--i' as string]: 8 }} aria-labelledby="m-h">
          <div className="text">
            <h2 id="m-h">{t('pm.title')}</h2>
            <p>{o.latest ? t('pm.latest', { month: periodLabel(lang, o.latest.period), n: count(lang, o.latest.row_count) }) : t('pm.empty')}</p>
            {o.latest && o.latest.problem_count > 0 && <p style={{ color: 'var(--neg)' }}>{t('pm.problems', { n: count(lang, o.latest.problem_count) })}</p>}
            <Link className="btn primary" href="/sheets#upload">{t('ov.upload')}<Plus aria-hidden="true" /></Link>
          </div>
          <div className="pile">
            {o.pile.length === 0 ? <p className="first">{t('pm.empty')}</p> : o.pile.map((sh, k) => (
              <Link key={sh.id} href={`/sheets/${sh.id}`} className="slip" style={{ ['--k' as string]: k }} aria-label={periodLabel(lang, sh.period)}>
                <div><div className="m">{periodLabel(lang, sh.period)}</div><div className="t">{sh.title}</div></div>
                <div className="row">
                  <span><b className="num">{count(lang, sh.row_count)}</b> {t('pm.employees')}</span>
                  <span className="pill">{sh.status === 'published' ? t('sh.published') : t('sh.draft')}</span>
                </div>
              </Link>
            ))}
          </div>
        </section>

        {/* who is waiting for HR */}
        <section className="card rise" style={{ ['--i' as string]: 9 }} aria-labelledby="w-h">
          <div className="panel-head">
            <h2 id="w-h">{t('ov.waiting')}</h2>
            {o.open > 0 && <Link className="meta" href="/disputes">{t('ov.viewAll')}</Link>}
          </div>
          <div className="panel-body">
            {o.waiting.length === 0 ? <p className="empty">{t('ov.noDisputes')}</p> : (
              <div className="people feed">
                {o.waiting.map((d) => (
                  <Link key={d.id} href={`/disputes?id=${d.id}`} className="who-row">
                    <span className={`avatar ${tint(d.employee_name || '')}`} aria-hidden="true">{initials(d.employee_name || '؟')}</span>
                    <span style={{ minWidth: 0 }}>
                      <span className="name" style={{ display: 'block' }}><bdi>{d.employee_name || '—'}</bdi></span>
                      <span className="what" style={{ display: 'block' }}>{d.item || '—'}{d.period ? ` · ${periodLabel(lang, d.period)}` : ''}</span>
                    </span>
                    <span className="end"><span className="pill sage num">{t('dp.ticket', { n: d.ticket_no })}</span>{ago(t, d.created_at)}</span>
                  </Link>
                ))}
              </div>
            )}
          </div>
        </section>

        {/* what the agent asks before any salary detail */}
        <section className="card guard rise" style={{ ['--i' as string]: 10 }} aria-labelledby="i-h">
          <span className="ring" aria-hidden="true"><Fingerprint /></span>
          <h2 id="i-h">{t('ic.title')}</h2>
          <p>{t('ic.sub')}</p>
          <div className="chips-row">{asked.map((f) => <span key={f} className="pill sage">{t(`f.${f}`)}</span>)}</div>
          {s.phone_must_match_sender && <p>{t('ov.phoneMatchShort')}</p>}
          <Link className="btn primary sm" href="/identity">{t('ic.change')}</Link>
        </section>
      </div>
    </div>
  );
}
