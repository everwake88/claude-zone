// "Track": everyone who held a chat, how loaded and how active they were.
import { html, useEffect, useState } from '../lib/h.js';
import { setState } from '../lib/store.js';
import { human, clock, clockSec } from '../lib/time.js';
import { get, customerName, CATEGORIES, CHANNEL_NAMES } from '../state.js';
import { Icon } from './icons.js';
import { Drawer, Category, Channel, pct } from './common.js';

const HOW = { auto: 'Auto-assigned', sla: 'Moved here: no reply in time', transfer: 'Accepted a transfer', manual: 'Given by a supervisor' };
const END = {
  timeout: ['Timed out', 'danger'],
  transferred: ['Passed to a teammate', 'accent'],
  reassigned: ['Reassigned', 'accent'],
  offline: ['Disconnected', 'warn'],
  logout: ['Checked out', 'warn'],
  supervisor: ['Sent back to queue', 'warn'],
  closed: ['Resolved', 'ok'],
};
const VERDICT = {
  busy: ['Busy', 'warn', 'Was working: replying in other chats or typing much of the time.'],
  idle: ['Idle', 'danger', 'No replies anywhere and almost no typing while this customer waited.'],
  some: ['Some activity', '', 'Some activity, but below the “busy” line.'],
  replied: ['Replied', 'ok', 'Answered the customer.'],
  offline: ['Offline', 'warn', 'Was disconnected for most of this time.'],
};

function Segment({ seg, i }) {
  const [endLabel, endTone] = seg.ongoing ? ['With them now', 'accent'] : END[seg.end_reason] || [seg.end_reason, ''];
  const v = seg.verdict ? VERDICT[seg.verdict] : null;
  return html`<div class=${`j-seg ${seg.verdict || ''}`}>
    <div class="j-seg__node">${i + 1}</div>
    <div class="j-card">
      <div class="j-card__top">
        <strong>${seg.full_name}</strong><span class="muted">${seg.employee_id}</span>
        <span class=${`tag ${endTone}`}>${endLabel}</span>
        ${v ? html`<span class=${`tag ${v[1]}`}>${v[0]}</span>` : null}
      </div>
      <div class="muted" style=${{ fontSize: '12.5px' }}>
        ${HOW[seg.how] || seg.how} · ${clockSec(seg.started_at)} → ${seg.ended_at ? clockSec(seg.ended_at) : 'now'} · held ${human(seg.duration_ms)}
      </div>
      <div class="j-card__facts">
        <div title="Chats this agent already had when this one arrived"><b>${seg.load_at_start}</b><span>Chats on arrival</span></div>
        <div title="All chats this agent held at some point while this one waited"><b>${seg.chats_during}</b><span>Chats meanwhile</span></div>
        <div title="Replies this agent sent to other customers meanwhile"><b>${seg.other_replies}</b><span>Replies elsewhere</span></div>
        <div title="Active typing time while holding this chat"><b>${human(seg.typing_ms)}</b><span>Typing · ${pct(seg.typing_share)}</span></div>
      </div>
      ${seg.not_ready_ms > 1000 ? html`<span class="muted" style=${{ fontSize: '12px' }}>Not ready for ${human(seg.not_ready_ms)} of this time.</span>` : null}
      ${v ? html`<span style=${{ fontSize: '12.5px', color: 'var(--text-2)' }}>${v[2]}</span>` : null}
    </div>
  </div>`;
}

const EVENT_TEXT = {
  opened: (e) => `Handed over by the AI (${CATEGORIES[e.data.category] || e.data.category})`,
  assigned: (e) => `→ ${e.user_name}${e.data.how === 'sla' ? ' (no reply in time)' : e.data.how === 'transfer' ? ' (transfer)' : ''} · had ${e.data.load} chats`,
  reminder: (e) => `Reminder ${e.data.number} to ${e.user_name}`,
  late: (e) => `Marked late while with ${e.user_name}`,
  replied: (e) => `${e.actor_name} replied after ${human(e.data.wait_ms)}${e.data.late_ms > 0 ? ` (late by ${human(e.data.late_ms)})` : ''}`,
  transfer_requested: (e) => `${e.actor_name} asked ${e.user_name} to take it`,
  transfer_accepted: (e) => `${e.user_name} accepted`,
  transfer_declined: (e) => `${e.user_name}: no availability`,
  transfer_expired: (e) => `${e.user_name} did not answer the request`,
  transfer_cancelled: (e) => `${e.actor_name} withdrew the request`,
  returned: (e) => `Back to the team queue (${e.data.reason})`,
  no_target: () => 'Nobody free to take it',
  category: (e) => `${e.actor_name} changed the category to ${CATEGORIES[e.data.to]}`,
  closed: (e) => `Resolved by ${e.actor_name}`,
  send_failed: (e) => `A reply by ${e.user_name} was not delivered`,
};

export function JourneyDrawer({ id }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  useEffect(() => {
    get(`/api/conversations/${id}/journey`).then(setData, (e) => setError(e.message));
  }, [id]);
  const close = () => setState({ journeyId: null });
  const c = data?.conversation;
  return html`<${Drawer} title="Chat journey" onClose=${close}
    actions=${c ? html`<a class="btn sm" href=${`#/inbox/${id}`} onClick=${close}>Open chat</a>` : null}>
    ${error ? html`<div class="callout warn">${error}</div>` : null}
    ${!data && !error ? html`<div class="muted">Loading…</div>` : null}
    ${c ? html`
      <div style=${{ display: 'flex', alignItems: 'center', gap: '10px' }}>
        <${Channel} channel=${c.channel} /><strong dir="auto" style=${{ fontSize: '16px' }}>${customerName(c)}</strong>
        <${Category} category=${c.category} />
        <span class="muted">${CHANNEL_NAMES[c.channel]} · opened ${clock(c.opened_at)}</span>
      </div>
      <div class="j-stats">
        <div class=${`j-stat ${data.first_response_ms > data.sla_minutes * 60000 ? 'hot' : ''}`}>
          <b>${data.first_response_ms != null ? human(data.first_response_ms) : 'Not yet'}</b><span>First reply</span></div>
        <div class="j-stat"><b>${data.segments.length}</b><span>Agents who held it</span></div>
        <div class=${`j-stat ${c.late_cycles ? 'hot' : ''}`}><b>${c.late_cycles}</b><span>Late waits</span></div>
      </div>
      ${data.waits.length ? html`<section>
        <h3 class="muted" style=${{ margin: '0 0 8px', fontSize: '11.5px', textTransform: 'uppercase', letterSpacing: '.07em' }}>Customer waits</h3>
        <div class="j-events">
          ${data.waits.map((w) => html`<div><time>${clock(w.started_at)}</time><span>
            Waited ${human(w.wait_ms)}${w.replied_at ? ` · answered by ${w.by_name}` : ' · still waiting'}
            ${w.late_ms > 0 ? html` · <b style=${{ color: 'var(--danger)' }}>late by ${human(w.late_ms)}</b>` : html` · <span style=${{ color: 'var(--ok)' }}>on time</span>`}
          </span></div>`)}
        </div>
      </section>` : null}
      <section>
        <h3 class="muted" style=${{ margin: '0 0 10px', fontSize: '11.5px', textTransform: 'uppercase', letterSpacing: '.07em' }}>Who had it</h3>
        <div class="j-line">${data.segments.map((s, i) => html`<${Segment} key=${s.id} seg=${s} i=${i} />`)}</div>
        ${!data.segments.length ? html`<span class="muted">Still in the team queue — nobody has had it yet.</span>` : null}
      </section>
      <section>
        <h3 class="muted" style=${{ margin: '0 0 8px', fontSize: '11.5px', textTransform: 'uppercase', letterSpacing: '.07em' }}>Everything that happened</h3>
        <div class="j-events">
          ${data.events.map((e) => {
            const f = EVENT_TEXT[e.type];
            return f ? html`<div key=${e.id}><time>${clockSec(e.created_at)}</time><span>${f({ ...e, user_name: e.user_name || 'someone', actor_name: e.actor_name || 'The system' })}</span></div>` : null;
          })}
        </div>
      </section>
      <div class="callout"><${Icon} name="info" cls="sm" /><span><b>Busy</b> = at least one reply every two minutes in other chats, or typing a quarter of the time. <b>Idle</b> = no replies and almost no typing. Supervisors can tune these in Settings.</span></div>
    ` : null}
  <//>`;
}
