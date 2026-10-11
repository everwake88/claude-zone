import { html, useState } from '../lib/h.js';
import { useStore } from '../lib/store.js';
import { useNow, stopwatch, human, clock } from '../lib/time.js';
import { isMuted, setMuted, unlockAudio } from '../lib/alerts.js';
import { isSup, setStatus, logout, post, toast, refreshMe } from '../state.js';
import { Icon } from './icons.js';
import { Avatar, Meter, Popover, Modal, STATUS_LABEL } from './common.js';

const CFG = window.DESK_CONFIG || {};

function StatusSwitch() {
  const state = useStore((s) => s.me.state);
  const t = useNow(1000);
  const since = state.status_since ? new Date(state.status_since).getTime() : t;
  const ready = state.status === 'ready';
  return html`<div class="status">
    <div class="status__switch" role="radiogroup" aria-label="Your status">
      <button role="radio" aria-checked=${ready} class=${ready ? 'on ready' : ''} onClick=${() => !ready && setStatus('ready')}
        title="Receive chats">
        <i class="dot ready"></i><span>Ready</span>
      </button>
      <button role="radio" aria-checked=${!ready} class=${!ready ? 'on not_ready' : ''}
        onClick=${() => ready && setStatus('not_ready')} title="Keep your chats, receive nothing new">
        <${Icon} name="coffee" cls="sm" /><span class="lbl-not">Not ready</span>
      </button>
    </div>
    <div class="status__time">
      <strong class="timer">${stopwatch(t - since)}</strong>
      <span>${ready ? 'Ready' : 'Not ready'} for</span>
    </div>
  </div>`;
}

function TeamMenu() {
  const { team, me } = useStore((s) => ({ team: s.team, me: s.me }));
  const t = useNow(5000);
  const [q, setQ] = useState('');
  const others = team.filter((m) => m.id !== me.user.id);
  const ready = others.filter((m) => m.status === 'ready').length;
  const notReady = others.filter((m) => m.status === 'not_ready').length;
  const list = others.filter((m) => !q || `${m.full_name} ${m.employee_id}`.toLowerCase().includes(q.toLowerCase()));
  return html`<${Popover}
    panelClass="team-pop"
    button=${({ toggle, open }) => html`<button class=${`btn ${open ? '' : 'ghost'}`} onClick=${toggle} aria-expanded=${open}>
      <${Icon} name="users" /><span class="hide-sm">Team</span>
      <span class="tag ok">${ready} ready</span>
    </button>`}>
    <div class="team-pop__head">
      <h3>Your team right now</h3>
      <div class="team-pop__sum">
        <span><i class="dot ready"></i>${ready} ready</span>
        <span><i class="dot not_ready"></i>${notReady} not ready</span>
        <span><i class="dot offline"></i>${others.length - ready - notReady} offline</span>
      </div>
      <div class="search"><${Icon} name="search" cls="sm" />
        <input class="input" placeholder="Find a teammate" value=${q} onInput=${(e) => setQ(e.target.value)} style=${{ height: '34px', minWidth: 0 }} />
      </div>
    </div>
    <div class="team-list">
      ${list.map((m) => html`<div class=${`member ${m.status === 'offline' ? 'off' : ''}`} key=${m.id}>
        <${Avatar} name=${m.full_name} status=${m.status} />
        <div style=${{ minWidth: 0 }}>
          <div class="member__name">${m.full_name} <small>${m.employee_id}</small></div>
          <div class="member__sub">
            ${STATUS_LABEL[m.status]}${m.status !== 'offline' && m.status_since ? ` · ${human(t - new Date(m.status_since).getTime())}` : ''}
            ${m.awaiting ? html` · <span style=${{ color: 'var(--warn)', fontWeight: 600 }}>${m.awaiting} waiting</span>` : null}
          </div>
        </div>
        <div class="member__load">
          <span class="num">${m.status === 'offline' ? '—' : `${m.load}/${m.cap}`}</span>
          ${m.status !== 'offline' ? html`<${Meter} value=${m.load} max=${m.cap} />` : null}
        </div>
      </div>`)}
      ${!list.length ? html`<div class="empty" style=${{ padding: '20px' }}><p>No teammates match.</p></div>` : null}
    </div>
  <//>`;
}

function ChangePassword({ onClose }) {
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  async function save() {
    setBusy(true);
    setError(null);
    try {
      await post('/api/me/password', { current, next });
      toast({ tone: 'ok', icon: 'key', title: 'Password changed' });
      onClose();
    } catch (err) {
      setError(err.message);
    }
    setBusy(false);
  }
  return html`<${Modal} title="Change your password" onClose=${onClose}
    footer=${html`<button class="btn" onClick=${onClose}>Cancel</button>
      <button class="btn primary" disabled=${busy || next.length < 8} onClick=${save}>Save</button>`}>
    ${error ? html`<div class="login__error">${error}</div>` : null}
    <label class="field"><span>Current password</span>
      <input class="input" type="password" autocomplete="current-password" value=${current} onInput=${(e) => setCurrent(e.target.value)} /></label>
    <label class="field"><span>New password</span>
      <input class="input" type="password" autocomplete="new-password" value=${next} onInput=${(e) => setNext(e.target.value)} />
      <small>At least 8 characters.</small></label>
  <//>`;
}

function UserMenu() {
  const me = useStore((s) => s.me);
  const myChats = useStore((s) => Object.values(s.convs).filter((c) => c.assigned_to === s.me.user.id).length);
  const t = useNow(10000);
  const [muted, setMutedState] = useState(isMuted());
  const [dark, setDark] = useState(document.documentElement.dataset.theme === 'dark');
  const [pw, setPw] = useState(false);
  const today = me.today || {};
  const fetched = me.fetched_at || t;
  const live = Math.max(0, t - fetched);
  const readyMs = (today.ready_ms || 0) + (me.state.status === 'ready' ? live : 0);
  const notReadyMs = (today.not_ready_ms || 0) + (me.state.status === 'not_ready' ? live : 0);

  function toggleTheme() {
    const next = dark ? 'light' : 'dark';
    document.documentElement.dataset.theme = next;
    try {
      localStorage.setItem('desk.theme', next);
    } catch {
      /* ignore */
    }
    setDark(!dark);
  }
  function toggleSound() {
    setMuted(!muted);
    setMutedState(!muted);
    unlockAudio();
  }
  function confirmLogout() {
    if (myChats && !confirm(`You still have ${myChats} chat${myChats === 1 ? '' : 's'}. Checking out sends ${myChats === 1 ? 'it' : 'them'} back to the team. Check out now?`)) return;
    logout();
  }

  return html`<${Popover}
    button=${({ toggle }) => html`<button class="btn ghost" style=${{ padding: '0 6px', height: '40px' }} onClick=${() => { toggle(); refreshMe(); }} aria-label="Your account">
      <${Avatar} name=${me.user.full_name} status=${me.state.status} />
    </button>`}>
    ${({ close }) => html`<div style=${{ width: '300px' }}>
      <div class="me-card">
        <div class="me-card__who">
          <${Avatar} name=${me.user.full_name} size="lg" />
          <div style=${{ minWidth: 0 }}>
            <strong>${me.user.full_name}</strong>
            <span class="muted">${me.user.employee_id} · ${me.user.role}</span>
          </div>
        </div>
        <div class="me-card__stats">
          <div><b>${clock(me.session.checked_in_at)}</b><span>Checked in · ${human(t - new Date(me.session.checked_in_at).getTime())}</span></div>
          <div><b>${today.handled ?? 0}</b><span>Handled today</span></div>
          <div><b>${human(readyMs)}</b><span>Ready today</span></div>
          <div><b>${human(notReadyMs)}</b><span>Not ready today</span></div>
        </div>
      </div>
      <div class="menu">
        <button onClick=${toggleSound}><${Icon} name=${muted ? 'volumeOff' : 'volume'} />${muted ? 'Sounds off' : 'Sounds on'}</button>
        <button onClick=${toggleTheme}><${Icon} name=${dark ? 'sun' : 'moon'} />${dark ? 'Light mode' : 'Dark mode'}</button>
        <button onClick=${() => { close(); setPw(true); }}><${Icon} name="key" />Change password</button>
        <hr />
        <button onClick=${confirmLogout} style=${{ color: 'var(--danger)' }}><${Icon} name="logout" />Check out & sign out</button>
      </div>
    </div>`}
  <//>
  ${pw ? html`<${ChangePassword} onClose=${() => setPw(false)} />` : null}`;
}

function Nav() {
  const { route, me } = useStore((s) => ({ route: s.route, me: s.me }));
  const late = useStore((s) => Object.values(s.convs).filter((c) => c.breached_at && c.status !== 'closed').length);
  const queued = useStore((s) => Object.values(s.convs).filter((c) => c.status === 'queued').length);
  if (!isSup(me)) return null;
  const item = (page, icon, label, badge = null) => html`<a href=${`#/${page}`} class=${route.page === page ? 'on' : ''}>
    <${Icon} name=${icon} /><span class="lbl">${label}</span>${badge}
  </a>`;
  return html`<nav class="nav">
    ${item('inbox', 'inbox', 'My chats')}
    ${item('live', 'live', 'Live', late || queued ? html`<span class=${`badge ${late ? 'hot' : ''}`}>${late || queued}</span>` : null)}
    ${item('reports', 'chart', 'Reports')}
    ${item('team', 'users', 'Team')}
    ${me.user.role === 'admin' ? item('settings', 'sliders', 'Settings') : null}
  </nav>`;
}

export function Topbar() {
  const conn = useStore((s) => s.conn);
  return html`<header class="topbar">
    <a class="brand" href="#/inbox" style=${{ textDecoration: 'none', color: 'inherit' }}>
      <span class="brand__mark">2B</span><span class="word">${(CFG.brandName || '2B Desk').replace(/^2B\s*/, '') || 'Desk'}</span>
    </a>
    <${Nav} />
    <div class="topbar__spacer"></div>
    ${conn === 'offline' || conn === 'reconnecting'
      ? html`<span class="conn" title="Live updates paused; the page keeps refreshing every few seconds"><${Icon} name="wifiOff" cls="sm" />Reconnecting…</span>`
      : null}
    <${StatusSwitch} />
    <${TeamMenu} />
    <${UserMenu} />
  </header>`;
}

