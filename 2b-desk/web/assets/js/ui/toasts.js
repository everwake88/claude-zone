import { html } from '../lib/h.js';
import { useStore } from '../lib/store.js';
import { dismissToast } from '../state.js';
import { Icon } from './icons.js';

const ICON = { info: 'bell', warn: 'clock', hot: 'alert', ok: 'checkCircle' };

export function Toasts() {
  const toasts = useStore((s) => s.toasts);
  return html`<div class="toasts" role="status" aria-live="polite">
    ${toasts.map((t) => html`<div class=${`toast ${t.tone}`} key=${t.id}>
      <div class="toast__icon"><${Icon} name=${t.icon || ICON[t.tone] || 'bell'} /></div>
      <div>
        <strong dir="auto">${t.title}</strong>
        ${t.text ? html`<p dir="auto">${t.text}</p>` : null}
        ${t.actions?.length ? html`<div class="toast__actions">
          ${t.actions.map((a) => html`<button class=${`btn sm ${a.primary ? 'primary' : ''}`}
            onClick=${() => { dismissToast(t.id); a.run(); }}>${a.label}</button>`)}
        </div>` : null}
      </div>
      <button class="btn ghost icon sm" onClick=${() => dismissToast(t.id)} aria-label="Dismiss"><${Icon} name="x" cls="sm" /></button>
    </div>`)}
  </div>`;
}
