import { html, useState } from '../lib/h.js';
import { useStore, setState } from '../lib/store.js';
import { requestTransfer, customerName } from '../state.js';
import { Icon } from './icons.js';
import { Avatar, Meter, Modal, STATUS_LABEL } from './common.js';

export function TransferModal({ convId }) {
  const { team, me, conv } = useStore((s) => ({ team: s.team, me: s.me, conv: s.convs[convId] }));
  const [to, setTo] = useState(null);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const close = () => setState({ transferFor: null });
  if (!conv) return null;

  const people = team
    .filter((m) => m.id !== me.user.id)
    .map((m) => ({
      ...m,
      why: m.status !== 'ready' ? STATUS_LABEL[m.status] : m.load >= m.cap ? 'Full' : null,
    }))
    .sort((a, b) => (a.why ? 1 : 0) - (b.why ? 1 : 0) || a.load / a.cap - b.load / b.cap || a.full_name.localeCompare(b.full_name));
  const available = people.filter((p) => !p.why).length;

  async function send() {
    if (!to) return;
    setBusy(true);
    const ok = await requestTransfer(convId, to, note.trim());
    setBusy(false);
    if (ok) close();
  }

  return html`<${Modal}
    title="Ask a teammate to take this chat"
    subtitle=${`${customerName(conv)} · they can accept or answer “No availability”. Until then the chat stays with you.`}
    onClose=${close}
    footer=${html`<button class="btn" onClick=${close}>Cancel</button>
      <button class="btn primary" disabled=${!to || busy} onClick=${send}><${Icon} name="transfer" cls="sm" />Send request</button>`}>
    ${!available ? html`<div class="callout warn"><${Icon} name="info" cls="sm" />Nobody is Ready with free room right now.</div>` : null}
    <div class="pick" role="listbox" aria-label="Teammates">
      ${people.map((p) => html`<button type="button" key=${p.id} role="option" aria-selected=${to === p.id}
        class=${to === p.id ? 'on' : ''} disabled=${!!p.why} onClick=${() => setTo(p.id)}>
        <${Avatar} name=${p.full_name} status=${p.status} />
        <span><b>${p.full_name}</b><br /><small class="muted">${p.employee_id}${p.why ? ` · ${p.why}` : p.awaiting ? ` · ${p.awaiting} waiting` : ''}</small></span>
        <span class="pick__load">${p.status === 'offline' ? '—' : html`<span class="num">${p.load}/${p.cap}</span><${Meter} value=${p.load} max=${p.cap} />`}</span>
      </button>`)}
    </div>
    <label class="field"><span>Note for your teammate (optional)</span>
      <input class="input" maxlength="300" placeholder="e.g. Angry about a late delivery, order #48213" value=${note} onInput=${(e) => setNote(e.target.value)} dir="auto" />
    </label>
  <//>`;
}
