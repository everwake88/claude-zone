// 2B Desk — the dashboard.
import { html, render, useEffect } from './lib/h.js';
import { useStore } from './lib/store.js';
import { boot, isSup, refreshMe } from './state.js';
import { Login } from './ui/login.js';
import { Topbar } from './ui/topbar.js';
import { Inbox } from './ui/inbox.js';
import { Live } from './ui/live.js';
import { Reports } from './ui/reports.js';
import { Team } from './ui/team.js';
import { Settings } from './ui/settings.js';
import { Toasts } from './ui/toasts.js';
import { TransferModal } from './ui/transfer.js';
import { JourneyDrawer } from './ui/journey.js';

function Shell() {
  const { route, me, transferFor, journeyId } = useStore((s) => ({
    route: s.route, me: s.me, transferFor: s.transferFor, journeyId: s.journeyId,
  }));
  // "My day" numbers in the menu and the queue footer.
  useEffect(() => {
    const id = setInterval(refreshMe, 60_000);
    return () => clearInterval(id);
  }, []);
  const sup = isSup(me);
  const page = sup ? route.page : 'inbox';
  return html`<div class=${`shell ${sup ? 'has-nav' : ''}`}>
    <${Topbar} />
    ${page === 'live' ? html`<${Live} />`
      : page === 'reports' ? html`<${Reports} />`
      : page === 'team' ? html`<${Team} />`
      : page === 'settings' ? html`<${Settings} />`
      : html`<${Inbox} />`}
    <${Toasts} />
    ${transferFor ? html`<${TransferModal} convId=${transferFor} />` : null}
    ${journeyId && sup ? html`<${JourneyDrawer} id=${journeyId} />` : null}
  </div>`;
}

function App() {
  const phase = useStore((s) => s.phase);
  if (phase === 'boot') return html`<div class="boot"><div class="boot__logo">2B</div></div>`;
  if (phase === 'login') return html`<${Login} />`;
  return html`<${Shell} />`;
}

render(html`<${App} />`, document.getElementById('app'));
boot();
