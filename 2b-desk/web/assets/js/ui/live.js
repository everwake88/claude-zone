// Supervisors: the whole floor at a glance.
import { html, useEffect, useState } from '../lib/h.js';
import { useStore, setState } from '../lib/store.js';
import { useNow, human, stopwatch } from '../lib/time.js';
import { go, customerName, refreshBoard, forceNotReady } from '../state.js';
import { Icon } from './icons.js';
import { Avatar, Channel, Category, SlaPill, slaInfo, Meter, Empty, STATUS_LABEL, pct } from './common.js';

function Kpi({ label, value, hint, tone = '', accent }) {
  return html`<div class=${`kpi ${tone}`} style=${accent ? { '--accent': accent } : null}>
    <span>${label}</span><b>${value}</b>${hint ? html`<small>${hint}</small>` : null}
  </div>`;
}

function AgentCard({ m, t, selected, onSelect }) {
  const since = m.status_since ? human(t - new Date(m.status_since).getTime()) : '';
  return html`<div role="button" tabindex="0" class=${`agent-card ${selected ? 'on' : ''} ${m.status === 'offline' ? 'offline' : ''}`}
    title=${selected ? 'Show everyone’s chats' : `Show ${m.full_name}’s chats below`}
    onClick=${onSelect} onKeyDown=${(e) => (e.key === 'Enter' || e.key === ' ') && (e.preventDefault(), onSelect())}>
    <div class="agent-card__top">
      <${Avatar} name=${m.full_name} status=${m.status} />
      <div style=${{ flex: 1, minWidth: 0 }}>
        <b>${m.full_name}</b>
        <small>${m.employee_id} · ${STATUS_LABEL[m.status]}${m.status !== 'offline' ? ` ${since}` : ''}</small>
      </div>
    </div>
    <div class="agent-card__load">
      <div><span>Chats</span><span class="num">${m.load}/${m.cap}</span></div>
      <${Meter} value=${m.load} max=${m.cap} />
    </div>
    <div class="agent-card__nums">
      ${m.awaiting ? html`<span class="tag warn">${m.awaiting} waiting</span>` : html`<span class="tag">none waiting</span>`}
      ${m.late ? html`<span class="tag danger">${m.late} late</span>` : null}
      ${m.status === 'ready' ? html`<button class="btn ghost icon sm" title="Pause: set to Not ready (keeps their chats)"
        onClick=${(e) => { e.stopPropagation(); forceNotReady(m.id); }}><${Icon} name="coffee" cls="sm" /></button>` : null}
    </div>
  </div>`;
}

export function Live() {
  const { convs, team, today, me } = useStore((s) => ({ convs: s.convs, team: s.team, today: s.today, me: s.me }));
  const t = useNow(1000);
  const [filter, setFilter] = useState('all');
  const [agent, setAgent] = useState(null);
  const [q, setQ] = useState('');
  useEffect(() => {
    refreshBoard();
    const id = setInterval(refreshBoard, 30_000);
    return () => clearInterval(id);
  }, []);

  const settings = me.settings;
  const open = Object.values(convs).filter((c) => c.status !== 'closed');
  const queued = open.filter((c) => c.status === 'queued');
  const awaiting = open.filter((c) => c.waiting_since);
  const lateNow = open.filter((c) => slaInfo(c, t, settings).kind === 'late');
  const online = team.filter((m) => m.status !== 'offline');
  const readyN = team.filter((m) => m.status === 'ready').length;
  const capacity = team.filter((m) => m.status === 'ready').reduce((a, m) => a + Math.max(0, m.cap - m.load), 0);

  let rows = filter === 'waiting' ? awaiting : filter === 'late' ? lateNow : filter === 'queue' ? queued : open;
  if (agent) rows = rows.filter((c) => c.assigned_to === agent);
  if (q.trim()) {
    const needle = q.trim().toLowerCase();
    rows = rows.filter((c) => `${customerName(c)} ${c.customer_phone || ''} ${c.assigned_name || ''}`.toLowerCase().includes(needle));
  }
  rows = rows.slice().sort((a, b) => {
    const wa = a.waiting_since ? +new Date(a.waiting_since) : Infinity;
    const wb = b.waiting_since ? +new Date(b.waiting_since) : Infinity;
    return wa - wb || new Date(b.last_message_at || 0) - new Date(a.last_message_at || 0);
  });
  const onTime = today && today.answered ? (today.answered - today.late_replies) / today.answered : null;
  const sortedTeam = team.slice().sort((a, b) => {
    const rank = { ready: 0, not_ready: 1, offline: 2 };
    return rank[a.status] - rank[b.status] || b.late - a.late || b.awaiting - a.awaiting || a.full_name.localeCompare(b.full_name);
  });

  return html`<div class="page"><div class="page__inner">
    <div class="page__head">
      <div style=${{ flex: 1 }}><h1>Live</h1><p>Updates by itself. Waiting customers float to the top.</p></div>
    </div>
    <div class="kpis">
      <${Kpi} label="Ready agents" value=${`${readyN}`} hint=${`${online.length} online · room for ${capacity} more`} accent="#22c55e" />
      <${Kpi} label="Customers waiting for a reply" value=${awaiting.length} tone=${awaiting.length ? '' : 'ok'} accent="#f59e0b" />
      <${Kpi} label="Late right now" value=${lateNow.length} tone=${lateNow.length ? 'hot' : 'ok'} hint=${`over ${settings.sla_minutes} min`} accent="var(--danger)" />
      <${Kpi} label="Waiting for a free agent" value=${queued.length} tone=${queued.length ? 'hot' : ''} hint="everyone is full or not ready" accent="var(--brand)" />
      <${Kpi} label="Handled today" value=${today?.handled ?? '—'} hint=${`${today?.new_chats ?? 0} new · ${today?.resolved ?? 0} resolved`} />
      <${Kpi} label="Replies on time today" value=${pct(onTime)} tone=${onTime != null && onTime < 0.9 ? 'hot' : 'ok'} hint=${today?.avg_wait_ms != null ? `avg reply ${human(today.avg_wait_ms)}` : ''} />
    </div>

    <section class="panel">
      <div class="panel__head"><h2>Team</h2><span class="muted">${readyN} ready · ${team.filter((m) => m.status === 'not_ready').length} not ready · ${team.length - online.length} offline</span></div>
      <div class="panel__body">
        <div class="agents-grid">
          ${sortedTeam.map((m) => html`<${AgentCard} key=${m.id} m=${m} t=${t} selected=${agent === m.id}
            onSelect=${() => setAgent(agent === m.id ? null : m.id)} />`)}
        </div>
      </div>
    </section>

    <section class="panel">
      <div class="panel__head">
        <h2>Open chats ${agent ? html`<span class="tag accent">${team.find((m) => m.id === agent)?.full_name} <button class="btn ghost icon sm" style=${{ height: '18px', width: '18px' }} onClick=${() => setAgent(null)} aria-label="Clear filter"><${Icon} name="x" cls="sm" /></button></span>` : null}</h2>
        <div class="toolbar">
          <div class="seg">
            <button class=${filter === 'all' ? 'on' : ''} onClick=${() => setFilter('all')}>All <span class="count">${open.length}</span></button>
            <button class=${filter === 'waiting' ? 'on' : ''} onClick=${() => setFilter('waiting')}>Waiting <span class="count">${awaiting.length}</span></button>
            <button class=${filter === 'late' ? 'on' : ''} onClick=${() => setFilter('late')}>Late <span class=${`count ${lateNow.length ? 'hot' : ''}`}>${lateNow.length}</span></button>
            <button class=${filter === 'queue' ? 'on' : ''} onClick=${() => setFilter('queue')}>Team queue <span class=${`count ${queued.length ? 'hot' : ''}`}>${queued.length}</span></button>
          </div>
          <div class="search"><${Icon} name="search" cls="sm" /><input class="input" placeholder="Customer, phone or agent" value=${q} onInput=${(e) => setQ(e.target.value)} /></div>
        </div>
      </div>
      <div class="panel__body table-wrap" style=${{ paddingTop: '6px' }}>
        ${rows.length ? html`<table class="t">
          <thead><tr><th>Customer</th><th>Category</th><th>With</th><th>Reply</th><th class="r">In queue</th><th class="r">Moved</th><th></th></tr></thead>
          <tbody>
            ${rows.slice(0, 300).map((c) => html`<tr key=${c.id}>
              <td><div class="who"><${Channel} channel=${c.channel} /><div style=${{ minWidth: 0 }}><b dir="auto">${customerName(c)}</b><small dir="auto" style=${{ display: 'block', maxWidth: '320px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>${c.last_preview || ''}</small></div></div></td>
              <td><${Category} category=${c.category} /></td>
              <td>${c.status === 'queued' ? html`<span class="tag danger">Team queue</span>` : html`<div class="who"><${Avatar} name=${c.assigned_name} size="sm" /><span>${c.assigned_name}</span></div>`}</td>
              <td><${SlaPill} conv=${c} t=${t} settings=${settings} doneLabel="Answered" /></td>
              <td class="r num">${c.assigned_at ? stopwatch(t - new Date(c.assigned_at).getTime()) : stopwatch(t - new Date(c.opened_at).getTime())}</td>
              <td class="r num">${c.transfers || ''}</td>
              <td class="r" style=${{ whiteSpace: 'nowrap' }}>
                <button class="btn ghost sm" onClick=${() => setState({ journeyId: c.id })} title="Track"><${Icon} name="route" cls="sm" /></button>
                <button class="btn sm" onClick=${() => go(`inbox/${c.id}`)}>Open</button>
              </td>
            </tr>`)}
          </tbody>
        </table>` : html`<${Empty} icon="checkCircle" title="Nothing here">No chats match this view.</${Empty}>`}
      </div>
    </section>
  </div></div>`;
}
