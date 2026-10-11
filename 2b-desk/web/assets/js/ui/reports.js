// Supervisors: the day in numbers.
import { html, useEffect, useState, useMemo } from '../lib/h.js';
import { useStore, setState } from '../lib/store.js';
import { human, clock, longDate, shiftDay, dateKey, now } from '../lib/time.js';
import { download } from '../lib/api.js';
import { get, go, toast, CHANNEL_NAMES } from '../state.js';
import { Icon } from './icons.js';
import { Avatar, Channel, Category, Empty, pct } from './common.js';

const CAT_COLORS = { inquiry: 'var(--cat-inquiry)', sales: 'var(--cat-sales)', complaint: 'var(--cat-complaint)', followup: 'var(--cat-followup)' };
const CH_COLORS = { whatsapp: '#22c55e', messenger: '#3b82f6', instagram: '#ec4899' };

function Bars({ rows, color, valueKey = 'opened', extra = null }) {
  const total = rows.reduce((a, r) => a + r[valueKey], 0);
  const max = Math.max(1, ...rows.map((r) => r[valueKey]));
  return html`<div class="bars">
    ${rows.map((r) => html`<div class="bar-row" key=${r.key}>
      <div class="bar-row__label">${r.label}</div>
      <div class="bar-row__track"><i style=${{ width: `${(r[valueKey] / max) * 100}%`, background: color(r.key) }}></i></div>
      <div class="bar-row__val">${r[valueKey]}<small>${total ? pct(r[valueKey] / total) : ''}</small></div>
    </div>`)}
    ${extra}
  </div>`;
}

function Hourly({ hours }) {
  const first = hours.findIndex((h) => h.opened || h.replies);
  const last = 23 - [...hours].reverse().findIndex((h) => h.opened || h.replies);
  const max = Math.max(1, ...hours.map((h) => Math.max(h.opened, h.replies)));
  if (first < 0) return html`<${Empty} icon="chart" title="No activity yet" />`;
  return html`<div>
    <div class="cols">
      ${hours.map((h) => html`<div class="cols__col" key=${h.hour} data-tip=${`${String(h.hour).padStart(2, '0')}:00 · ${h.opened} new · ${h.replies} replies`}
        style=${{ gridTemplateColumns: '1fr 1fr', display: 'grid', opacity: h.hour < first || h.hour > last ? 0.35 : 1 }}>
        <i class="a" style=${{ height: `${(h.opened / max) * 100}%` }}></i>
        <i class="b" style=${{ height: `${(h.replies / max) * 100}%` }}></i>
      </div>`)}
    </div>
    <div class="cols-axis">${hours.map((h) => html`<span key=${h.hour}>${h.hour % 3 === 0 ? String(h.hour).padStart(2, '0') : ''}</span>`)}</div>
    <div class="legend" style=${{ marginTop: '10px' }}>
      <span><i style=${{ background: 'var(--brand)' }}></i>New chats</span>
      <span><i style=${{ background: 'color-mix(in srgb, var(--brand) 30%, transparent)' }}></i>Replies sent</span>
    </div>
  </div>`;
}

function Timeline({ segments, start, end }) {
  const s = new Date(start).getTime();
  const span = new Date(end).getTime() - s;
  return html`<div class="timeline" title="Green = Ready, amber = Not ready, grey = offline">
    ${segments.map((g, i) => {
      const left = ((new Date(g.from).getTime() - s) / span) * 100;
      const width = Math.max(0.3, ((new Date(g.to) - new Date(g.from)) / span) * 100);
      return html`<i key=${i} class=${g.status} style=${{ left: `${left}%`, width: `${width}%` }}></i>`;
    })}
  </div>`;
}

const COLUMNS = [
  ['full_name', 'Agent'],
  ['checked_in_at', 'In / out'],
  ['ready_ms', 'Ready'],
  ['not_ready_ms', 'Not ready'],
  ['timeline', 'Day'],
  ['handled', 'Chats'],
  ['replies', 'Replies'],
  ['avg_wait_ms', 'Avg reply'],
  ['late_replies', 'Late'],
  ['timeouts', 'Moved away'],
  ['typing_ms', 'Typing'],
];

function AgentsTable({ report }) {
  const [sort, setSort] = useState({ key: 'handled', dir: -1 });
  const rows = useMemo(() => {
    const val = (a) => (sort.key === 'timeouts' ? a.timeouts.total : a[sort.key] ?? -1);
    return report.agents
      .filter((a) => a.is_active || a.logged_ms || a.replies)
      .slice()
      .sort((a, b) => {
        const va = val(a);
        const vb = val(b);
        if (typeof va === 'string' || typeof vb === 'string') return String(va).localeCompare(String(vb)) * sort.dir;
        return (va - vb) * sort.dir;
      });
  }, [report, sort]);
  // The bar spans the hours anyone was around, so a 9-to-5 day is not squeezed into 24h.
  const span = useMemo(() => {
    let lo = Infinity;
    let hi = -Infinity;
    for (const a of report.agents) for (const g of a.timeline) {
      lo = Math.min(lo, new Date(g.from).getTime());
      hi = Math.max(hi, new Date(g.to).getTime());
    }
    if (!Number.isFinite(lo)) return { start: report.start, end: report.end };
    const hour = 3600_000;
    return { start: new Date(Math.floor(lo / hour) * hour), end: new Date(Math.ceil(hi / hour) * hour) };
  }, [report]);

  const head = (key, label) => html`<th class=${['full_name', 'checked_in_at', 'timeline'].includes(key) ? '' : 'r'}>
    ${key === 'timeline' ? label : html`<button class=${sort.key === key ? 'on' : ''} onClick=${() => setSort({ key, dir: sort.key === key ? -sort.dir : -1 })}>
      ${label}${sort.key === key ? (sort.dir < 0 ? ' ↓' : ' ↑') : ''}</button>`}
  </th>`;

  return html`<div class="table-wrap"><table class="t">
    <thead><tr>${COLUMNS.map(([k, l]) => head(k, l))}</tr></thead>
    <tbody>
      ${rows.map((a) => html`<tr key=${a.user_id}>
        <td><div class="who"><${Avatar} name=${a.full_name} size="sm" status=${a.online ? 'ready' : null} /><div><b>${a.full_name}</b><small>${a.employee_id}${a.role !== 'agent' ? ` · ${a.role}` : ''}</small></div></div></td>
        <td class="num" style=${{ whiteSpace: 'nowrap' }}>${a.checked_in_at ? html`${clock(a.checked_in_at)} → ${a.checked_out_at ? clock(a.checked_out_at) : html`<span style=${{ color: 'var(--ok)', fontWeight: 600 }}>now</span>`}` : html`<span class="muted">Absent</span>`}</td>
        <td class="r num">${a.ready_ms ? human(a.ready_ms) : '—'}</td>
        <td class="r num">${a.not_ready_ms ? human(a.not_ready_ms) : '—'}</td>
        <td style=${{ minWidth: '180px' }}><${Timeline} segments=${a.timeline} start=${span.start} end=${span.end} /></td>
        <td class="r num"><b>${a.handled}</b></td>
        <td class="r num">${a.replies}</td>
        <td class="r num">${a.avg_wait_ms != null ? human(a.avg_wait_ms) : '—'}</td>
        <td class="r num">${a.late_replies ? html`<span class="tag danger">${a.late_replies}</span>` : '0'}</td>
        <td class="r" title="Chats taken from this agent for not replying in time — and whether they were busy or idle then">
          ${a.timeouts.total ? html`<span class="num">${a.timeouts.total}</span>
            ${a.timeouts.idle ? html` <span class="tag danger">${a.timeouts.idle} idle</span>` : null}
            ${a.timeouts.busy ? html` <span class="tag warn">${a.timeouts.busy} busy</span>` : null}` : html`<span class="muted">0</span>`}
        </td>
        <td class="r num" title=${`${a.keystrokes} keystrokes`}>${a.typing_ms ? html`${human(a.typing_ms)} <small class="muted">${pct(a.typing_share)}</small>` : '—'}</td>
      </tr>`)}
    </tbody>
  </table></div>`;
}

export function Reports() {
  const { route, me } = useStore((s) => ({ route: s.route, me: s.me }));
  const date = route.date || dateKey(now());
  const [report, setReport] = useState(null);
  const [error, setError] = useState(null);
  const today = dateKey(now());

  async function load() {
    try {
      setError(null);
      setReport(await get(`/api/reports/day?date=${date}`));
    } catch (err) {
      setError(err.message);
    }
  }
  useEffect(() => {
    setReport(null);
    load();
    if (date !== today) return undefined;
    const id = setInterval(load, 60_000);
    return () => clearInterval(id);
  }, [date]);

  const r = report;
  const exportCsv = () =>
    download(`/api/reports/day.csv?date=${date}`, `2b-desk-agents-${date}.csv`).catch((e) => toast({ tone: 'hot', title: 'Export failed', text: e.message }));

  return html`<div class="page"><div class="page__inner">
    <div class="page__head">
      <div style=${{ flex: 1 }}><h1>Reports</h1><p>${r?.live ? 'Today so far — refreshes every minute.' : 'A full working day.'} Times in ${me.settings.timezone}.</p></div>
      <div class="datebar">
        <button class="btn ghost icon sm" onClick=${() => go(`reports/${shiftDay(date, -1)}`)} aria-label="Previous day"><${Icon} name="chevronLeft" /></button>
        <strong>${date === today ? 'Today' : longDate(date)}</strong>
        <button class="btn ghost icon sm" disabled=${date >= today} onClick=${() => go(`reports/${shiftDay(date, 1)}`)} aria-label="Next day"><${Icon} name="chevronRight" /></button>
      </div>
      <input class="input" type="date" style=${{ width: 'auto', height: '36px' }} value=${date} max=${today} onChange=${(e) => e.target.value && go(`reports/${e.target.value}`)} aria-label="Pick a date" />
      <button class="btn" onClick=${exportCsv}><${Icon} name="download" cls="sm" />Export agents (CSV)</button>
    </div>
    ${error ? html`<div class="callout warn">${error}</div>` : null}
    ${!r && !error ? html`<div class="muted">Loading…</div>` : null}
    ${r ? html`
      <div class="kpis">
        <div class="kpi"><span>Chats handled</span><b>${r.totals.handled}</b><small>${r.totals.replies} replies sent</small></div>
        <div class="kpi"><span>New chats from the AI</span><b>${r.totals.new_chats}</b><small>${r.totals.contacts >= r.totals.new_chats && r.totals.contacts ? `of ${r.totals.contacts} customers who wrote (${pct(r.totals.handoff_share)})` : 'handed to the team'}</small></div>
        <div class="kpi"><span>Resolved</span><b>${r.totals.resolved}</b><small>${r.totals.resolved_without_reply ? `${r.totals.resolved_without_reply} without a reply` : 'all answered'}</small></div>
        <div class=${`kpi ${r.first_response.avg_ms > r.sla_minutes * 60000 ? 'hot' : ''}`}><span>First reply (avg)</span><b>${r.first_response.avg_ms != null ? human(r.first_response.avg_ms) : '—'}</b><small>median ${r.first_response.median_ms != null ? human(r.first_response.median_ms) : '—'}</small></div>
        <div class=${`kpi ${r.waits.on_time_share != null && r.waits.on_time_share < 0.9 ? 'hot' : 'ok'}`}><span>Replies within ${r.sla_minutes} min</span><b>${pct(r.waits.on_time_share)}</b><small>${r.waits.on_time} of ${r.waits.answered} waits</small></div>
        <div class=${`kpi ${r.waits.late ? 'hot' : 'ok'}`}><span>Late replies</span><b>${r.waits.late}</b><small>${r.live_now ? `${r.live_now.late_now} late right now` : `longest wait ${r.waits.max_ms != null ? human(r.waits.max_ms) : '—'}`}</small></div>
      </div>

      <div class="grid-3">
        <section class="panel">
          <div class="panel__head"><h2>By category</h2><p>What the chats handed to the team were about.</p></div>
          <div class="panel__body"><${Bars} color=${(k) => CAT_COLORS[k]}
            rows=${r.by_category.map((x) => ({ ...x, label: html`<${Category} category=${x.key} />` }))} /></div>
        </section>
        <section class="panel">
          <div class="panel__head"><h2>By source</h2><p>Where those customers wrote from.</p></div>
          <div class="panel__body"><${Bars} color=${(k) => CH_COLORS[k]}
            rows=${r.by_channel.map((x) => ({ ...x, label: html`<span style=${{ display: 'flex', gap: '8px', alignItems: 'center' }}><${Channel} channel=${x.key} />${CHANNEL_NAMES[x.key]}</span>` }))}
            extra=${r.totals.contacts ? html`<div class="muted" style=${{ fontSize: '12px' }}>Everyone who wrote to the AI: ${r.by_channel.map((x) => `${CHANNEL_NAMES[x.key]} ${x.contacts}`).join(' · ')}</div>` : null} /></div>
        </section>
        <section class="panel">
          <div class="panel__head"><h2>Through the day</h2><p>New chats and replies per hour.</p></div>
          <div class="panel__body"><${Hourly} hours=${r.hourly} /></div>
        </section>
      </div>

      <section class="panel">
        <div class="panel__head"><h2>Team performance</h2>
          <p>Ready / Not ready time, chats handled, replies, and typing activity. “Moved away” counts chats taken from an agent for not replying in time — with whether they were busy or idle then.</p></div>
        <div class="panel__body" style=${{ paddingTop: '6px' }}><${AgentsTable} report=${r} /></div>
      </section>

      <section class="panel">
        <div class="panel__head"><h2>Late chats</h2><p>Waits longer than ${r.sla_minutes} minutes. Track shows who had each one and what they were doing.</p></div>
        <div class="panel__body table-wrap" style=${{ paddingTop: '6px' }}>
          ${r.late_chats.length || r.late_now.length ? html`<table class="t">
            <thead><tr><th>Customer</th><th>Category</th><th class="r">Waited</th><th class="r">Late by</th><th class="r">Agents</th><th>Answered by</th><th></th></tr></thead>
            <tbody>
              ${r.late_now.map((c) => html`<tr key=${`n${c.id}`}>
                <td><div class="who"><${Channel} channel=${c.channel} /><b dir="auto">${c.customer_name || 'Customer'}</b></div></td>
                <td><${Category} category=${c.category} /></td>
                <td class="r num">${human(now() - new Date(c.waiting_since).getTime())}</td>
                <td class="r"><span class="tag danger">still waiting</span></td>
                <td class="r num">${c.transfers + 1}</td>
                <td>${c.holder_name ? `with ${c.holder_name}` : 'team queue'}</td>
                <td class="r"><button class="btn sm" onClick=${() => setState({ journeyId: c.id })}><${Icon} name="route" cls="sm" />Track</button></td>
              </tr>`)}
              ${r.late_chats.map((c, i) => html`<tr key=${`l${c.id}-${i}`}>
                <td><div class="who"><${Channel} channel=${c.channel} /><b dir="auto">${c.customer_name || 'Customer'}</b></div></td>
                <td><${Category} category=${c.category} /></td>
                <td class="r num">${human(c.wait_ms)}</td>
                <td class="r num" style=${{ color: 'var(--danger)', fontWeight: 700 }}>${human(c.late_ms)}</td>
                <td class="r num">${c.holders}</td>
                <td>${c.replied_by_name || '—'} <span class="muted">${clock(c.replied_at)}</span></td>
                <td class="r"><button class="btn sm" onClick=${() => setState({ journeyId: c.id })}><${Icon} name="route" cls="sm" />Track</button></td>
              </tr>`)}
            </tbody>
          </table>` : html`<${Empty} icon="checkCircle" title="No late chats">Every customer got a reply within ${r.sla_minutes} minutes.</${Empty}>`}
        </div>
      </section>
    ` : null}
  </div></div>`;
}

