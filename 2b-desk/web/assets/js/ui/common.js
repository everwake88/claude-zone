// Small building blocks used across the pages.
import { html, useEffect, useRef, useState } from '../lib/h.js';
import { stopwatch } from '../lib/time.js';
import { CHANNELS, CHANNEL_NAMES, CATEGORIES } from '../state.js';
import { Icon } from './icons.js';

const PALETTE = ['#4f46e5', '#0e7490', '#b45309', '#be185d', '#15803d', '#7c3aed', '#1d4ed8', '#c2410c', '#0f766e', '#9333ea'];

export function initials(name = '') {
  const parts = String(name).trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return '?';
  return (parts[0][0] + (parts.length > 1 ? parts[parts.length - 1][0] : '')).toUpperCase();
}

function colorFor(name = '') {
  let h = 0;
  for (const ch of String(name)) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return PALETTE[h % PALETTE.length];
}

export function Avatar({ name, status, size = '' }) {
  return html`<span class=${`avatar ${size}`} style=${{ background: colorFor(name) }} title=${name}>
    ${initials(name)}${status ? html`<i class=${`dot ${status}`}></i>` : null}
  </span>`;
}

export function Channel({ channel }) {
  return html`<span class=${`ch ${channel}`} title=${CHANNEL_NAMES[channel]}>${CHANNELS[channel] || '?'}</span>`;
}

export function Category({ category, onClick }) {
  if (onClick) {
    return html`<button type="button" class=${`cat ${category}`} onClick=${onClick} title="Change category">
      ${CATEGORIES[category] || category}<${Icon} name="chevronDown" cls="sm" />
    </button>`;
  }
  return html`<span class=${`cat ${category}`}>${CATEGORIES[category] || category}</span>`;
}

export const STATUS_LABEL = { ready: 'Ready', not_ready: 'Not ready', offline: 'Offline' };

// Where a chat stands against the SLA, from the customer's point of view.
export function slaInfo(conv, t, settings) {
  if (!conv.waiting_since) return { kind: 'done' };
  const w = new Date(conv.waiting_since).getTime();
  const left = w + settings.sla_minutes * 60_000 - t;
  const moveIn = conv.hold_until && conv.status === 'assigned' ? new Date(conv.hold_until).getTime() - t : null;
  const waited = t - w;
  if (left <= 0) return { kind: 'late', left, moveIn, waited, label: `Late +${stopwatch(-left)}` };
  const kind = left <= 2 * 60_000 ? 'hot' : left <= 5 * 60_000 ? 'warn' : 'calm';
  // Round time-left up, so "0:00 left" never shows while it is still on time.
  return { kind, left, moveIn, waited, label: `${stopwatch(Math.ceil(left / 1000) * 1000)} left` };
}

export function SlaPill({ conv, t, settings, doneLabel = null }) {
  const s = slaInfo(conv, t, settings);
  if (s.kind === 'done') return doneLabel ? html`<span class="sla done">${doneLabel}</span>` : null;
  return html`<span class=${`sla ${s.kind}`} title="Time left before this chat breaks the ${settings.sla_minutes}-minute rule">
    <${Icon} name=${s.kind === 'late' ? 'alert' : 'clock'} cls="sm" />${s.label}
  </span>`;
}

export function Meter({ value, max }) {
  const pct = max ? Math.min(100, (value / max) * 100) : 0;
  const cls = value >= max ? 'full' : pct >= 80 ? 'warn' : '';
  return html`<div class=${`meter ${cls}`}><i style=${{ width: `${pct}%` }}></i></div>`;
}

export function Empty({ icon = 'inbox', title, children }) {
  return html`<div class="empty">
    <div class="empty__art"><${Icon} name=${icon} /></div>
    <h3>${title}</h3>
    ${children ? html`<p>${children}</p>` : null}
  </div>`;
}

// Closes on Escape and on a click outside.
export function useDismiss(open, onClose) {
  const ref = useRef(null);
  useEffect(() => {
    if (!open) return undefined;
    const key = (e) => e.key === 'Escape' && onClose();
    const click = (e) => ref.current && !ref.current.contains(e.target) && onClose();
    document.addEventListener('keydown', key);
    const id = setTimeout(() => document.addEventListener('pointerdown', click), 0);
    return () => {
      document.removeEventListener('keydown', key);
      document.removeEventListener('pointerdown', click);
      clearTimeout(id);
    };
  }, [open]);
  return ref;
}

export function Popover({ button, children, align = 'right', panelClass = '' }) {
  const [open, setOpen] = useState(false);
  const ref = useDismiss(open, () => setOpen(false));
  return html`<div class="pop" ref=${ref}>
    ${button({ open, toggle: () => setOpen((o) => !o) })}
    ${open ? html`<div class=${`pop__panel ${align === 'left' ? 'left' : ''} ${panelClass}`}>
      ${typeof children === 'function' ? children({ close: () => setOpen(false) }) : children}
    </div>` : null}
  </div>`;
}

export function Modal({ title, subtitle, onClose, children, footer, wide = false }) {
  useEffect(() => {
    const key = (e) => e.key === 'Escape' && onClose();
    document.addEventListener('keydown', key);
    return () => document.removeEventListener('keydown', key);
  }, []);
  return html`<div class="scrim" onPointerDown=${(e) => e.target === e.currentTarget && onClose()}>
    <div class=${`modal ${wide ? 'wide' : ''}`} role="dialog" aria-modal="true" aria-label=${title}>
      <div class="modal__head">
        <div style=${{ flex: 1 }}>
          <h2>${title}</h2>
          ${subtitle ? html`<p>${subtitle}</p>` : null}
        </div>
        <button class="btn ghost icon sm" onClick=${onClose} aria-label="Close"><${Icon} name="x" /></button>
      </div>
      <div class="modal__body">${children}</div>
      ${footer ? html`<div class="modal__foot">${footer}</div>` : null}
    </div>
  </div>`;
}

export function Drawer({ title, onClose, children, actions = null }) {
  useEffect(() => {
    const key = (e) => e.key === 'Escape' && onClose();
    document.addEventListener('keydown', key);
    return () => document.removeEventListener('keydown', key);
  }, []);
  return html`<div>
    <div class="drawer-scrim" onClick=${onClose}></div>
    <aside class="drawer" role="dialog" aria-modal="true" aria-label=${title}>
      <div class="drawer__head">
        <h2>${title}</h2>
        ${actions}
        <button class="btn ghost icon sm" onClick=${onClose} aria-label="Close"><${Icon} name="x" /></button>
      </div>
      <div class="drawer__body">${children}</div>
    </aside>
  </div>`;
}

// 0.995 is not "100%": keep one decimal close to the ends so nothing is hidden.
export function pct(v, digits = null) {
  if (v == null || !Number.isFinite(v)) return '—';
  const d = digits ?? (v > 0.99 && v < 1 ? 1 : v > 0 && v < 0.01 ? 1 : 0);
  return `${(v * 100).toFixed(d)}%`;
}
