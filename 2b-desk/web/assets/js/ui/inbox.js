// The agent's workspace: queue on the left, the conversation in the middle,
// customer details on the right.
import { html, useState, useEffect, useRef, useLayoutEffect, useMemo } from '../lib/h.js';
import { useStore, setState } from '../lib/store.js';
import { useNow, human, clock, stopwatch, dayLabel, dateKey } from '../lib/time.js';
import { notifyPermission, askNotify } from '../lib/alerts.js';
import * as typing from '../lib/typing.js';
import {
  isSup, go, customerName, CATEGORIES, CHANNEL_NAMES, respondTransfer, sendReply, retryMessage,
  setCategory, resolve, cancelTransfer, setStatus, requeue, reassign,
} from '../state.js';
import { Icon } from './icons.js';
import { Avatar, Channel, Category, SlaPill, slaInfo, Meter, Empty, Popover } from './common.js';

// ------------------------------------------------------------------ queue

function sortQueue(list) {
  return list.sort((a, b) => {
    const wa = a.waiting_since ? new Date(a.waiting_since).getTime() : Infinity;
    const wb = b.waiting_since ? new Date(b.waiting_since).getTime() : Infinity;
    if (wa !== wb) return wa - wb;
    return new Date(b.last_message_at || 0) - new Date(a.last_message_at || 0);
  });
}

function QueueCard({ c, active, t, settings }) {
  const s = slaInfo(c, t, settings);
  const withMe = c.assigned_at ? t - new Date(c.assigned_at).getTime() : 0;
  return html`<button type="button" class=${`card ${active ? 'on' : ''} ${s.kind === 'late' ? 'late' : ''} ${c.unread ? 'unread' : ''}`}
    onClick=${() => go(`inbox/${c.id}`)}>
    <div class="card__top">
      <${Channel} channel=${c.channel} />
      <span class="card__name" dir="auto">${customerName(c)}</span>
      <${SlaPill} conv=${c} t=${t} settings=${settings} doneLabel=${c.last_agent_at ? 'Replied' : null} />
    </div>
    <div class="card__preview" dir="auto">${c.last_preview || c.summary || 'No messages yet'}</div>
    <div class="card__meta">
      <${Category} category=${c.category} />
      <span title="How long this chat has been in your queue">with you ${human(withMe)}</span>
      ${c.transfers ? html`<i class="sep"></i><span title="Times this chat changed hands">${c.transfers} moved</span>` : null}
      ${c.unread ? html`<span class="badge" title="Unread messages">${c.unread}</span>` : null}
    </div>
  </button>`;
}

function IncomingCard({ c, t, settings }) {
  const tr = c.transfer;
  const left = Math.max(0, Math.ceil((new Date(tr.expires_at).getTime() - t) / 1000));
  return html`<div class="card incoming">
    <div class="incoming-box">
      <div class="incoming-box__head"><${Icon} name="transfer" cls="sm" />${tr.from_name} asks for help · ${left}s</div>
      <div class="card__top">
        <${Channel} channel=${c.channel} />
        <span class="card__name" dir="auto">${customerName(c)}</span>
        <${SlaPill} conv=${c} t=${t} settings=${settings} />
      </div>
      <div class="card__meta"><${Category} category=${c.category} /><span dir="auto">${c.last_preview || ''}</span></div>
      ${tr.note ? html`<div class="incoming-box__note" dir="auto">“${tr.note}”</div>` : null}
      <div class="incoming-box__actions">
        <button class="btn primary sm" onClick=${() => respondTransfer(tr.id, true)}><${Icon} name="check" cls="sm" />Accept</button>
        <button class="btn sm" onClick=${() => respondTransfer(tr.id, false)}>No availability</button>
      </div>
    </div>
  </div>`;
}

function Queue({ activeId }) {
  const { me, convs } = useStore((s) => ({ me: s.me, convs: s.convs }));
  const t = useNow(1000);
  const [filter, setFilter] = useState('all');
  const settings = me.settings;
  const cap = me.user.max_chats ?? settings.max_chats;
  const mine = sortQueue(Object.values(convs).filter((c) => c.status === 'assigned' && c.assigned_to === me.user.id));
  const incoming = Object.values(convs).filter((c) => c.transfer?.to === me.user.id && c.status !== 'closed');
  const waiting = mine.filter((c) => c.waiting_since);
  const late = mine.filter((c) => slaInfo(c, t, settings).kind === 'late');
  const shown = filter === 'waiting' ? waiting : filter === 'late' ? late : mine;
  const today = me.today || {};
  const ready = me.state.status === 'ready';

  return html`<section class="queue" aria-label="My chats">
    <div class="queue__head">
      <div class="queue__title">
        <h2>My chats</h2>
        <div class="cap" title="You never get more than ${cap} chats at once">
          <div class="cap__row"><span>Capacity</span><span class="num">${mine.length}/${cap}</span></div>
          <${Meter} value=${mine.length} max=${cap} />
        </div>
      </div>
    </div>
    <div class="queue__filters">
      <div class="seg" role="tablist">
        <button class=${filter === 'all' ? 'on' : ''} onClick=${() => setFilter('all')}>All <span class="count">${mine.length}</span></button>
        <button class=${filter === 'waiting' ? 'on' : ''} onClick=${() => setFilter('waiting')}>Waiting <span class="count">${waiting.length}</span></button>
        <button class=${filter === 'late' ? 'on' : ''} onClick=${() => setFilter('late')}>Late <span class=${`count ${late.length ? 'hot' : ''}`}>${late.length}</span></button>
      </div>
    </div>
    <div class="queue__list">
      ${incoming.map((c) => html`<${IncomingCard} key=${`in${c.id}`} c=${c} t=${t} settings=${settings} />`)}
      ${shown.map((c) => html`<${QueueCard} key=${c.id} c=${c} active=${c.id === activeId} t=${t} settings=${settings} />`)}
      ${!shown.length && !incoming.length
        ? filter !== 'all'
          ? html`<${Empty} icon="checkCircle" title=${filter === 'late' ? 'Nothing late' : 'Nobody waiting'}>Nice work.</${Empty}>`
          : ready
            ? html`<${Empty} icon="sparkles" title="All caught up">New chats appear here by themselves, with a sound.</${Empty}>`
            : html`<div class="empty">
                <div class="empty__art"><${Icon} name="coffee" /></div>
                <h3>You are Not ready</h3>
                <p>Press Ready when you want to start receiving chats.</p>
                <button class="btn primary" onClick=${() => setStatus('ready')}><${Icon} name="zap" />I’m ready</button>
              </div>`
        : null}
    </div>
    <div class="queue__foot" title="Your day so far">
      <div class="mini"><b>${today.handled ?? 0}</b><span>Handled</span></div>
      <div class="mini"><b>${today.avg_wait_ms != null ? human(today.avg_wait_ms) : '—'}</b><span>Avg reply</span></div>
      <div class="mini"><b>${human(today.typing_ms || 0)}</b><span>Typing</span></div>
    </div>
  </section>`;
}

// ------------------------------------------------------------------ thread

function noteText(n, nameOf, settings) {
  const who = nameOf(n.user_id);
  const by = nameOf(n.actor_id);
  const d = n.data || {};
  switch (n.type) {
    case 'opened':
      return { text: `Handed over by the AI agent · ${CATEGORIES[d.category] || d.category}`, icon: 'sparkles' };
    case 'assigned':
      if (d.how === 'sla') return { text: `Moved to ${who} — no reply in time`, icon: 'transfer', tone: 'hot' };
      if (d.how === 'transfer') return { text: `${who} took over the chat`, icon: 'transfer' };
      if (d.how === 'manual') return { text: `${by} gave the chat to ${who}`, icon: 'transfer' };
      return { text: `Assigned to ${who}`, icon: 'inbox' };
    case 'returned':
      return {
        text: {
          offline: `${who} disconnected — back to the team queue`,
          logout: `${who} checked out — back to the team queue`,
          supervisor: `${by} sent the chat back to the team queue`,
        }[d.reason] || 'Back to the team queue',
        icon: 'undo',
      };
    case 'transfer_requested': return { text: `${by} asked ${who} to take this chat`, icon: 'transfer' };
    case 'transfer_declined': return { text: `${who}: no availability`, icon: 'transfer' };
    case 'transfer_expired': return { text: `${who} did not answer the transfer request`, icon: 'transfer' };
    case 'transfer_cancelled': return { text: `${by} withdrew the transfer request`, icon: 'transfer' };
    case 'late': return { text: `Late — over ${settings.sla_minutes} minutes without a reply`, icon: 'alert', tone: 'hot' };
    case 'category': return { text: `${by} changed the category to ${CATEGORIES[d.to] || d.to}`, icon: 'flag' };
    case 'closed': return { text: `Resolved by ${by}${d.note ? ` — “${d.note}”` : ''}`, icon: 'checkCircle', tone: 'ok' };
    case 'no_target': return { text: 'Every teammate is full or not ready — staying here for now', icon: 'info' };
    default: return null;
  }
}

function MessageMeta({ m, nameOf }) {
  if (m.sender === 'customer') return html`<div class="msg__meta">${clock(m.created_at)}</div>`;
  if (m.sender === 'ai') return html`<div class="msg__meta"><span class="ai-tag"><${Icon} name="sparkles" cls="sm" />AI agent</span>${clock(m.created_at)}</div>`;
  return html`<div class="msg__meta">
    <span>${m.author_name || nameOf(m.user_id)}</span><span>·</span><span>${clock(m.created_at)}</span>
    ${m.delivery === 'pending' ? html`<span title="Sending"><${Icon} name="clock" cls="sm" /></span>` : null}
    ${m.delivery === 'sent' ? html`<span title="Delivered to the channel" style=${{ color: 'var(--ok)' }}><${Icon} name="check" cls="sm" /></span>` : null}
    ${m.delivery === 'failed' ? html`<span class="fail" title=${m.error || ''}>Not delivered</span><button onClick=${() => retryMessage(m.id)}>Retry</button>` : null}
  </div>`;
}

function Thread({ conv, thread, settings, nameOf }) {
  const ref = useRef(null);
  const stick = useRef(true);
  const items = useMemo(() => {
    const list = [
      ...thread.messages.map((m) => ({ kind: 'msg', at: new Date(m.created_at).getTime(), id: `m${m.id}`, m })),
      ...thread.notes.map((n) => ({ kind: 'note', at: new Date(n.created_at).getTime(), id: `n${n.id}`, n })),
    ];
    // Same moment: system notes before messages, then in the order they happened.
    list.sort((a, b) => a.at - b.at || (a.kind === b.kind ? 0 : a.kind === 'note' ? -1 : 1) || (a.kind === 'note' ? a.n.id - b.n.id : a.m.id - b.m.id));
    return list;
  }, [thread.messages, thread.notes]);

  useLayoutEffect(() => {
    const el = ref.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [items.length, conv.id]);
  useEffect(() => {
    stick.current = true;
  }, [conv.id]);

  const out = [];
  let lastDay = null;
  items.forEach((it, i) => {
    const day = dateKey(it.at);
    if (day !== lastDay) {
      out.push(html`<div class="day-sep" key=${`d${day}`}>${dayLabel(it.at)}</div>`);
      lastDay = day;
    }
    if (it.kind === 'note') {
      const nt = noteText(it.n, nameOf, settings);
      if (nt) out.push(html`<div class=${`note ${nt.tone || ''}`} key=${it.id}><${Icon} name=${nt.icon} cls="sm" />${nt.text} · ${clock(it.at)}</div>`);
      return;
    }
    const m = it.m;
    const next = items[i + 1];
    const prev = items[i - 1];
    const sameAs = (o) => o && o.kind === 'msg' && o.m.sender === m.sender && (m.sender !== 'agent' || o.m.user_id === m.user_id) && Math.abs(o.at - it.at) < 5 * 60_000;
    out.push(html`<div key=${it.id} class=${`msg ${m.sender} ${m.delivery === 'failed' ? 'failed' : ''} ${sameAs(prev) ? 'same' : ''}`}>
      <div class="bubble" dir="auto">${m.body}</div>
      ${!sameAs(next) || m.delivery === 'failed' ? html`<${MessageMeta} m=${m} nameOf=${nameOf} />` : null}
    </div>`);
  });

  return html`<div class="thread" ref=${ref} onScroll=${(e) => {
    const el = e.currentTarget;
    stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
  }}>
    ${conv.summary ? html`<div class="summary">
      <div class="summary__head"><${Icon} name="sparkles" cls="sm" />AI hand-off note</div>
      <p dir="auto">${conv.summary}</p>
    </div>` : null}
    ${thread.loading && !thread.messages.length ? html`<div class="note">Loading the conversation…</div>` : null}
    ${out}
  </div>`;
}

// ------------------------------------------------------------------ composer

const drafts = new Map();
const LIMITS = { whatsapp: 4000, messenger: 2000, instagram: 1000 };

function Composer({ conv, me }) {
  const [text, setText] = useState(drafts.get(conv.id) || '');
  const [busy, setBusy] = useState(false);
  const ref = useRef(null);
  useEffect(() => {
    setText(drafts.get(conv.id) || '');
    if (window.matchMedia('(min-width: 861px)').matches) ref.current?.focus();
  }, [conv.id]);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 160)}px`;
  }, [text]);

  const supView = isSup(me) && conv.assigned_to !== me.user.id;
  if (conv.status === 'closed') return html`<div class="composer locked">This chat is resolved. If the customer writes again, the AI picks it up.</div>`;
  if (conv.status === 'queued' && !isSup(me)) return html`<div class="composer locked">Waiting in the team queue for a free agent.</div>`;

  const limit = LIMITS[conv.channel] || 4000;
  const length = text.trim().length;
  const tooLong = length > limit;

  async function send() {
    const body = text.trim();
    if (!body || busy || tooLong) return;
    setBusy(true);
    const ok = await sendReply(conv.id, body);
    setBusy(false);
    if (ok) {
      drafts.delete(conv.id);
      setText('');
      ref.current?.focus();
    }
  }

  return html`<div class="composer">
    <div class="composer__box">
      <textarea ref=${ref} rows="1" dir="auto" value=${text}
        placeholder=${supView ? 'Reply as supervisor…' : 'Write a reply…'}
        onInput=${(e) => { setText(e.target.value); drafts.set(conv.id, e.target.value); }}
        onKeyDown=${(e) => {
          typing.onKeyDown(e);
          if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
            e.preventDefault();
            send();
          }
        }}></textarea>
      <button class="composer__send" disabled=${!text.trim() || busy || tooLong} onClick=${send} aria-label="Send"><${Icon} name="send" /></button>
    </div>
    <div class="composer__hint">
      <span><kbd>Enter</kbd> send · <kbd>Shift</kbd>+<kbd>Enter</kbd> new line</span>
      <span>·</span>
      <span>Goes out on ${CHANNEL_NAMES[conv.channel]}</span>
      ${length > limit * 0.8 ? html`<span class=${`tag ${tooLong ? 'danger' : 'warn'}`}>${length}/${limit}${tooLong ? ' — split it in two' : ''}</span>` : null}
      ${supView ? html`<span class="tag accent">Supervisor reply</span>` : null}
    </div>
  </div>`;
}

// ------------------------------------------------------------------ header

function ResolveButton({ conv }) {
  const [note, setNote] = useState('');
  return html`<${Popover} button=${({ toggle }) => html`<button class="btn ok solid sm" onClick=${toggle}><${Icon} name="checkCircle" cls="sm" /><span class="hide-sm">Resolve</span></button>`}>
    ${({ close }) => html`<div style=${{ padding: '14px', width: '300px', display: 'grid', gap: '10px' }}>
      <strong>Resolve this chat?</strong>
      ${conv.waiting_since ? html`<div class="callout warn"><${Icon} name="alert" cls="sm" />The customer’s last message has no reply yet.</div>` : null}
      <span class="muted" style=${{ fontSize: '12.5px' }}>The chat leaves your queue and the AI agent answers if the customer writes again.</span>
      <input class="input" placeholder="Short note (optional)" value=${note} onInput=${(e) => setNote(e.target.value)} />
      <div style=${{ display: 'flex', gap: '8px', justifyContent: 'flex-end' }}>
        <button class="btn sm" onClick=${close}>Cancel</button>
        <button class="btn ok solid sm" onClick=${() => { close(); resolve(conv.id, note); }}>Resolve</button>
      </div>
    </div>`}
  <//>`;
}

function CategoryMenu({ conv, canEdit }) {
  if (!canEdit) return html`<${Category} category=${conv.category} />`;
  return html`<${Popover} align="left" button=${({ toggle }) => html`<${Category} category=${conv.category} onClick=${toggle} />`}>
    ${({ close }) => html`<div class="menu" style=${{ width: '200px' }}>
      ${Object.entries(CATEGORIES).map(([k, label]) => html`<button class=${conv.category === k ? 'on' : ''}
        onClick=${() => { close(); setCategory(conv.id, k); }}><span class=${`cat ${k}`}>${label}</span></button>`)}
      ${conv.ai_category && conv.ai_category !== conv.category ? html`<hr /><span class="muted" style=${{ padding: '4px 10px', fontSize: '12px' }}>The AI said: ${CATEGORIES[conv.ai_category]}</span>` : null}
    </div>`}
  <//>`;
}

function ReassignMenu({ conv }) {
  const team = useStore((s) => s.team);
  const options = team.filter((m) => m.status !== 'offline' && m.id !== conv.assigned_to);
  return html`<${Popover} button=${({ toggle }) => html`<button class="btn sm" onClick=${toggle}><${Icon} name="transfer" cls="sm" /><span class="hide-sm">Reassign</span></button>`}>
    ${({ close }) => html`<div class="menu" style=${{ width: '290px', maxHeight: '360px', overflow: 'auto' }}>
      ${options.map((m) => html`<button disabled=${m.load >= m.cap} onClick=${() => { close(); reassign(conv.id, m.id); }}>
        <${Avatar} name=${m.full_name} status=${m.status} size="sm" />
        <span style=${{ flex: 1 }}>${m.full_name}</span><span class="muted num">${m.load}/${m.cap}</span>
      </button>`)}
      ${conv.status === 'assigned' ? html`<hr /><button onClick=${() => { close(); requeue(conv.id); }}><${Icon} name="undo" />Send back to the team queue</button>` : null}
      ${!options.length ? html`<span class="muted" style=${{ padding: '8px 10px' }}>Nobody else is online.</span>` : null}
    </div>`}
  <//>`;
}

// A real number shows as +20…; WhatsApp's private ids ("…@lid") are not phone numbers.
function phoneLabel(conv) {
  const p = String(conv.customer_phone || '').replace(/^\+/, '');
  return /^\d{6,}$/.test(p) ? `+${p}` : null;
}

function Header({ conv, me, onDetails }) {
  const t = useNow(1000);
  const mineNow = conv.assigned_to === me.user.id;
  const sup = isSup(me);
  const canAct = conv.status !== 'closed' && (mineNow || sup);
  const contact = phoneLabel(conv) || (conv.external_id.endsWith('@lid') ? 'WhatsApp (number hidden)' : conv.external_id.replace(/@.*/, ''));
  return html`<header class="convo__head">
    <button class="btn ghost icon only-sm" onClick=${() => go('inbox')} aria-label="Back"><${Icon} name="chevronLeft" /></button>
    <${Avatar} name=${customerName(conv)} size="lg" />
    <div class="convo__who">
      <h2><span dir="auto">${customerName(conv)}</span><${Channel} channel=${conv.channel} /></h2>
      <div class="convo__sub">
        <${CategoryMenu} conv=${conv} canEdit=${canAct} />
        <span class="hide-sm">${contact}</span>
        ${conv.status === 'assigned' && !mineNow ? html`<span>· with ${conv.assigned_name}</span>` : null}
        <${SlaPill} conv=${conv} t=${t} settings=${me.settings} />
      </div>
    </div>
    <div class="convo__actions">
      ${sup ? html`<button class="btn sm" onClick=${() => setState({ journeyId: conv.id })} title="See everyone who held this chat and what they were doing">
        <${Icon} name="route" cls="sm" /><span class="hide-sm">Track</span></button>` : null}
      ${mineNow && conv.status === 'assigned' && !conv.transfer ? html`<button class="btn sm" onClick=${() => setState({ transferFor: conv.id })}>
        <${Icon} name="transfer" cls="sm" /><span class="hide-sm">Transfer</span></button>` : null}
      ${sup && conv.status !== 'closed' ? html`<${ReassignMenu} conv=${conv} />` : null}
      ${canAct ? html`<${ResolveButton} conv=${conv} />` : null}
      <button class="btn ghost icon sm" onClick=${onDetails} title="Customer details" aria-label="Customer details"><${Icon} name="panel" /></button>
    </div>
  </header>`;
}

function Banners({ conv, me }) {
  const t = useNow(1000);
  const mineNow = conv.assigned_to === me.user.id;
  const s = slaInfo(conv, t, me.settings);
  const out = [];
  if (conv.transfer && conv.transfer.from === me.user.id) {
    const left = Math.max(0, Math.ceil((new Date(conv.transfer.expires_at).getTime() - t) / 1000));
    out.push(html`<div class="banner info" key="tr"><${Icon} name="transfer" cls="sm" />Waiting for ${conv.transfer.to_name} to accept · ${left}s
      <button class="btn sm" onClick=${() => cancelTransfer(conv.transfer.id)}>Withdraw</button></div>`);
  }
  if (conv.status === 'queued') {
    out.push(html`<div class="banner info" key="q"><${Icon} name="layers" cls="sm" />In the team queue — it goes to the next agent with room.</div>`);
  } else if (conv.status === 'closed') {
    out.push(html`<div class="banner info" key="c"><${Icon} name="checkCircle" cls="sm" />Resolved by ${conv.closed_by_name || 'the team'} at ${clock(conv.closed_at)}.</div>`);
  } else if (s.kind === 'late') {
    out.push(html`<div class="banner hot" key="late"><${Icon} name="alert" cls="sm" />Late by ${stopwatch(-s.left)} — the customer has waited ${human(s.waited)}. Reply now.</div>`);
  } else if (mineNow && s.moveIn != null && s.moveIn > 0 && s.moveIn <= 3 * 60_000) {
    out.push(html`<div class="banner warn" key="mv"><${Icon} name="clock" cls="sm" />Reply within ${stopwatch(s.moveIn)} or this chat moves to a teammate.</div>`);
  }
  if (isSup(me) && conv.status === 'assigned' && !mineNow) {
    out.push(html`<div class="banner info" key="sv"><${Icon} name="eye" cls="sm" />You are viewing ${conv.assigned_name}’s chat. A reply from you stops the SLA clock.</div>`);
  }
  return out;
}

// ------------------------------------------------------------------ details

function Details({ conv, thread, onClose, asDrawer }) {
  const t = useNow(10_000);
  return html`<aside class=${`details ${asDrawer ? 'as-drawer' : ''}`} aria-label="Customer details">
    ${asDrawer ? html`<div style=${{ display: 'flex', justifyContent: 'flex-end' }}><button class="btn ghost icon sm" onClick=${onClose} aria-label="Close"><${Icon} name="x" /></button></div>` : null}
    <section>
      <h3>Customer</h3>
      <div class="kv">
        <div><span>Name</span><b dir="auto">${conv.customer_name || '—'}</b></div>
        <div><span>Source</span><b>${CHANNEL_NAMES[conv.channel]}</b></div>
        ${phoneLabel(conv) ? html`<div><span>Phone</span><b>${phoneLabel(conv)}</b></div>` : null}
        <div><span>${conv.channel === 'whatsapp' ? 'WhatsApp ID' : 'Account ID'}</span><b>${conv.external_id.replace(/@.*/, '')}</b></div>
        ${conv.customer_ref ? html`<div><span>Customer no.</span><b>${conv.customer_ref}</b></div>` : null}
      </div>
    </section>
    <section>
      <h3>This chat</h3>
      <div class="kv">
        <div><span>Opened</span><b>${clock(conv.opened_at)} · ${human(t - new Date(conv.opened_at).getTime())} ago</b></div>
        <div><span>First reply</span><b>${conv.first_reply_at ? `${human(new Date(conv.first_reply_at) - new Date(conv.opened_at))} after opening` : 'Not yet'}</b></div>
        ${conv.assigned_at ? html`<div><span>With ${conv.assigned_name?.split(' ')[0] || 'agent'} for</span><b>${human(t - new Date(conv.assigned_at).getTime())}</b></div>` : null}
        <div><span>Changed hands</span><b>${conv.transfers} time${conv.transfers === 1 ? '' : 's'}</b></div>
        ${conv.late_cycles ? html`<div><span>Late waits</span><b style=${{ color: 'var(--danger)' }}>${conv.late_cycles}</b></div>` : null}
      </div>
    </section>
    ${thread?.previous?.length ? html`<section>
      <h3>Earlier chats</h3>
      <div class="prev">
        ${thread.previous.map((p) => html`<a href=${`#/inbox/${p.id}`} key=${p.id}>
          <span style=${{ display: 'flex', gap: '6px', alignItems: 'center' }}><${Category} category=${p.category} /><small>${dayLabel(p.opened_at)}</small></span>
          <small dir="auto">${p.closed_by_name ? `Resolved by ${p.closed_by_name}` : p.last_preview || ''}</small>
        </a>`)}
      </div>
    </section>` : null}
  </aside>`;
}

// ------------------------------------------------------------------ page

function Conversation({ id }) {
  const { me, conv, thread, team, detailsOpen } = useStore((s) => ({
    me: s.me,
    conv: s.convs[id] || s.threads[id]?.conv,
    thread: s.threads[id],
    team: s.team,
    detailsOpen: s.detailsOpen,
  }));
  const nameOf = useMemo(() => {
    const m = new Map(team.map((x) => [x.id, x.full_name]));
    return (uid) => (uid == null ? 'The system' : uid === me.user.id ? 'You' : m.get(uid) || 'A teammate');
  }, [team, me.user.id]);

  if (!thread || (!conv && thread.loading)) return html`<section class="convo"><div></div><div></div><div class="thread"><div class="note">Loading…</div></div><div></div></section>`;
  if (thread.error || !conv) {
    return html`<section class="convo"><div></div><div></div>
      <${Empty} icon="alert" title="Can’t open this chat">${thread.error || 'It may have moved to a teammate.'}</${Empty}>
      <div></div></section>`;
  }
  return html`<section class="convo">
    <${Header} conv=${conv} me=${me} onDetails=${() => setState({ detailsOpen: !detailsOpen })} />
    <div><${Banners} conv=${conv} me=${me} /></div>
    <${Thread} conv=${conv} thread=${thread} settings=${me.settings} nameOf=${nameOf} />
    <${Composer} conv=${conv} me=${me} />
  </section>
  <${Details} conv=${conv} thread=${thread} asDrawer=${detailsOpen} onClose=${() => setState({ detailsOpen: false })} />`;
}

function AlertsBanner() {
  const [perm, setPerm] = useState(notifyPermission());
  const [hidden, setHidden] = useState(() => {
    try {
      return localStorage.getItem('desk.alerts-dismissed') === '1';
    } catch {
      return false;
    }
  });
  if (perm !== 'default' || hidden) return null;
  return html`<div class="alerts-banner"><${Icon} name="bell" cls="sm" />Turn on desktop alerts so reminders reach you even when this tab is in the background.
    <button class="btn primary sm" onClick=${async () => setPerm(await askNotify())}>Turn on</button>
    <button class="btn ghost sm" onClick=${() => { setHidden(true); try { localStorage.setItem('desk.alerts-dismissed', '1'); } catch { /* ignore */ } }}>Not now</button>
  </div>`;
}

export function Inbox() {
  const { route, me, hasActive } = useStore((s) => ({ route: s.route, me: s.me, hasActive: !!s.route.id }));
  const id = route.id;
  const ready = me.state.status === 'ready';
  return html`<div class="workspace">
    <${AlertsBanner} />
    <div class=${`inbox ${hasActive ? 'has-active' : 'no-details'}`}>
      <${Queue} activeId=${id} />
      ${id ? html`<${Conversation} id=${id} key=${id} />` : html`<section class="convo"><div></div><div></div>
        ${ready
          ? html`<${Empty} icon="message" title="Pick a chat">The most urgent chats are at the top of your queue.</${Empty}>`
          : html`<div class="empty">
              <div class="empty__art"><${Icon} name="coffee" /></div>
              <h3>Welcome, ${me.user.full_name.split(' ')[0]}</h3>
              <p>You are checked in and Not ready. Chats start arriving the moment you press Ready.</p>
              <button class="btn primary" onClick=${() => setStatus('ready')}><${Icon} name="zap" />I’m ready</button>
            </div>`}
        <div></div></section>`}
    </div>
  </div>`;
}
