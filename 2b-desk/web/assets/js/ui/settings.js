// Admins: the numbers behind routing and the SLA.
import { html, useState } from '../lib/h.js';
import { useStore, setState } from '../lib/store.js';
import { api, toast } from '../state.js';
import { Icon } from './icons.js';

const FIELDS = [
  ['max_chats', 'Max chats per agent', 'Nobody ever holds more than this at once. Can be changed per person on the Team page.', 1],
  ['sla_minutes', 'Reply within (minutes)', 'A customer waiting longer than this is a violation and the chat is marked LATE.', 0.5],
  ['first_hold_minutes', 'First agent’s time (minutes)', 'How long the first agent has before an unanswered chat is moved to someone else.', 0.5],
  ['hop_minutes', 'Each next agent gets (minutes)', 'After that, the chat moves on this often until somebody replies.', 0.25],
  ['transfer_timeout_seconds', 'Accept a transfer within (seconds)', 'A teammate who does not answer a transfer request in time is skipped.', 5],
  ['offline_after_seconds', 'Disconnected after (seconds)', 'No signal from a dashboard for this long = offline; waiting customers move on.', 5],
  ['auto_checkout_minutes', 'Check out after offline (minutes)', 'Offline this long = checked out, and all their chats go back to the team.', 1],
];
const ADVANCED = [
  ['busy_replies_per_minute', '“Busy” if replies per minute ≥', 'In the chat journey: replies to other customers per minute.', 0.1],
  ['busy_typing_share', '“Busy” if typing share ≥', '0.25 = typing a quarter of the time.', 0.05],
  ['idle_typing_share', '“Idle” if typing share <', 'With no replies at all.', 0.01],
];

function Flow({ v }) {
  const reminders = (v.reminder_minutes || []).join(' & ');
  const steps = [
    ['0', 'Customer writes', 'Chat goes to the least busy Ready agent', 'var(--brand)'],
    [reminders || '—', 'Reminders', 'Toast, sound and desktop alert', '#f59e0b'],
    [String(v.first_hold_minutes), 'Moves on', 'To the least busy teammate who has not had it', '#fb923c'],
    [`+${v.hop_minutes}`, 'Keeps moving', 'Every hop, until somebody replies', '#f97316'],
    [String(v.sla_minutes), 'LATE', 'Flagged for supervisors, still moving', 'var(--danger)'],
  ];
  return html`<div class="flow">${steps.map(([m, t, d, c]) => html`<div style=${{ '--c': c }}><b>${m} min · ${t}</b>${d}</div>`)}</div>`;
}

export function Settings() {
  const me = useStore((s) => s.me);
  const [v, setV] = useState({ ...me.settings, reminder_minutes: me.settings.reminder_minutes.join(', ') });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [advanced, setAdvanced] = useState(false);
  if (me.user.role !== 'admin') return html`<div class="page"><div class="page__inner"><div class="callout warn">Only admins can change settings.</div></div></div>`;

  const set = (k) => (e) => setV({ ...v, [k]: e.target.value });
  async function save() {
    setBusy(true);
    setError(null);
    const body = {};
    for (const [k] of [...FIELDS, ...ADVANCED]) body[k] = Number(v[k]);
    body.reminder_minutes = String(v.reminder_minutes).split(',').map((x) => Number(x.trim())).filter((x) => x > 0);
    body.timezone = v.timezone;
    try {
      const res = await api('PUT', '/api/settings', body);
      setState((s) => ({ me: { ...s.me, settings: res.settings } }));
      setV({ ...res.settings, reminder_minutes: res.settings.reminder_minutes.join(', ') });
      toast({ tone: 'ok', icon: 'check', title: 'Settings saved', text: 'They apply within a few seconds, for everyone.' });
    } catch (err) {
      setError(err.message);
    }
    setBusy(false);
  }

  const preview = { ...v, reminder_minutes: String(v.reminder_minutes).split(',').map((x) => x.trim()).filter(Boolean) };
  const field = ([k, label, help, step]) => html`<label class="field" key=${k}><span>${label}</span>
    <input class="input" type="number" step=${step} value=${v[k]} onInput=${set(k)} /><small>${help}</small></label>`;

  return html`<div class="page"><div class="page__inner" style=${{ maxWidth: '980px' }}>
    <div class="page__head">
      <div style=${{ flex: 1 }}><h1>Settings</h1><p>How chats are shared out and how the 15-minute rule works.</p></div>
      <button class="btn primary" disabled=${busy} onClick=${save}><${Icon} name="check" cls="sm" />Save</button>
    </div>
    ${error ? html`<div class="login__error">${error}</div>` : null}
    <section class="panel">
      <div class="panel__head"><h2>What happens to an unanswered chat</h2></div>
      <div class="panel__body"><${Flow} v=${preview} /></div>
    </section>
    <section class="panel">
      <div class="panel__head"><h2>Capacity and the SLA</h2></div>
      <div class="panel__body">
        <div class="form-grid">
          ${FIELDS.slice(0, 4).map(field)}
          <label class="field"><span>Reminders at (minutes)</span>
            <input class="input" value=${v.reminder_minutes} onInput=${set('reminder_minutes')} placeholder="5, 8" />
            <small>Minutes after the customer wrote, separated by commas.</small></label>
          ${field(FIELDS[4])}
        </div>
      </div>
    </section>
    <section class="panel">
      <div class="panel__head"><h2>Presence</h2></div>
      <div class="panel__body"><div class="form-grid">
        ${FIELDS.slice(5).map(field)}
        <label class="field"><span>Time zone</span><input class="input" value=${v.timezone} onInput=${set('timezone')} />
          <small>Decides where a “day” starts in reports. Egypt: Africa/Cairo.</small></label>
      </div></div>
    </section>
    <section class="panel">
      <div class="panel__head"><h2>Busy or idle</h2>
        <button class="btn ghost sm" onClick=${() => setAdvanced(!advanced)}>${advanced ? 'Hide' : 'Show'}</button>
        <p>When a chat times out with someone, the journey says whether they were busy or idle at that time.</p></div>
      ${advanced ? html`<div class="panel__body"><div class="form-grid">${ADVANCED.map(field)}</div></div>` : null}
    </section>
  </div></div>`;
}
