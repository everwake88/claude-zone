import { html, useState } from '../lib/h.js';
import { useStore } from '../lib/store.js';
import { login } from '../state.js';
import { Icon } from './icons.js';

const CFG = window.DESK_CONFIG || {};

export function Login() {
  const { loginError, loginNote } = useStore((s) => ({ loginError: s.loginError, loginNote: s.loginNote }));
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [show, setShow] = useState(false);
  const [busy, setBusy] = useState(false);

  async function submit(e) {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    await login(username.trim(), password);
    setBusy(false);
  }

  return html`<div class="login">
    <section class="login__art">
      <div class="brand"><span class="brand__mark">2B</span><span>${CFG.brandName || '2B Desk'}</span></div>
      <div style=${{ position: 'relative', zIndex: 1 }}>
        <h1>Every customer answered within 15 minutes.</h1>
        <p>WhatsApp, Messenger and Instagram in one calm inbox. The AI handles the questions; you handle the people.</p>
        <div class="login__points">
          <div><span><${Icon} name="zap" /></span>Press Ready and chats come to you, never more than your share.</div>
          <div><span><${Icon} name="clock" /></span>Reminders before a customer waits too long.</div>
          <div><span><${Icon} name="transfer" /></span>Busy? Ask a teammate to take a chat in one click.</div>
        </div>
      </div>
      <div style=${{ opacity: 0.7, fontSize: '12px', position: 'relative', zIndex: 1 }}>${CFG.poweredBy || ''}</div>
    </section>
    <section class="login__panel">
      <form class="login__card" onSubmit=${submit}>
        <div class="brand only-sm"><span class="brand__mark">2B</span><span>${CFG.brandName || '2B Desk'}</span></div>
        <div>
          <h2>Sign in to start your shift</h2>
          <p>Your check-in time is recorded when you sign in.</p>
        </div>
        ${loginNote ? html`<div class="login__note">${loginNote}</div>` : null}
        ${loginError ? html`<div class="login__error" role="alert">${loginError}</div>` : null}
        <label class="field">
          <span>Username</span>
          <input class="input" autocomplete="username" autocapitalize="none" spellcheck="false" required
            value=${username} onInput=${(e) => setUsername(e.target.value)} autofocus />
        </label>
        <label class="field">
          <span>Password</span>
          <div class="pw">
            <input class="input" type=${show ? 'text' : 'password'} autocomplete="current-password" required
              value=${password} onInput=${(e) => setPassword(e.target.value)} />
            <button type="button" class="btn ghost icon" onClick=${() => setShow(!show)} aria-label=${show ? 'Hide password' : 'Show password'}>
              <${Icon} name=${show ? 'eyeOff' : 'eye'} />
            </button>
          </div>
        </label>
        <button class="btn primary" style=${{ height: '44px' }} disabled=${busy}>${busy ? 'Signing in…' : 'Sign in'}</button>
        <div class="login__foot">Forgot your password? Your supervisor can reset it.</div>
      </form>
    </section>
  </div>`;
}
