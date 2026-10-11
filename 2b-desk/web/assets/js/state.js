// App state and every action the dashboard can take.
import { api, get, post, setToken, getToken, onSignedOut, ApiError } from './lib/api.js';
import { getState, setState, initState } from './lib/store.js';
import { syncServerTime, setTimeZone, human, stopwatch, now } from './lib/time.js';
import { connect } from './lib/socket.js';
import { chime, desktop, setTitleCount, unlockAudio } from './lib/alerts.js';

export const isSup = (me) => !!me && (me.user.role === 'supervisor' || me.user.role === 'admin');
export const CHANNELS = { whatsapp: 'WA', messenger: 'FB', instagram: 'IG' };
export const CHANNEL_NAMES = { whatsapp: 'WhatsApp', messenger: 'Messenger', instagram: 'Instagram' };
export const CATEGORIES = {
  inquiry: 'Inquiry',
  sales: 'Sales',
  complaint: 'Complaint',
  followup: 'Follow-up',
};

initState({
  phase: 'boot',
  loginError: null,
  loginNote: null,
  me: null,
  conn: 'connecting',
  convs: {},
  threads: {},
  team: [],
  today: null,
  route: parseRoute(),
  toasts: [],
  journeyId: null,
  transferFor: null,
  detailsOpen: false,
});

let socket = null;
const known = new Map(); // conversation id -> { name, channel } for toasts after it left

export function customerName(c) {
  if (!c) return 'A customer';
  if (c.customer_name) return c.customer_name;
  const tail = String(c.customer_phone || c.external_id || '').replace(/@.*/, '').slice(-4);
  return `${CHANNEL_NAMES[c.channel] || 'Customer'} ·${tail}`;
}

// ---------------------------------------------------------------- routing

function parseRoute() {
  const parts = location.hash.replace(/^#\/?/, '').split('/').filter(Boolean);
  const page = ['inbox', 'live', 'reports', 'team', 'settings'].includes(parts[0]) ? parts[0] : 'inbox';
  return {
    page,
    id: page === 'inbox' && parts[1] ? Number(parts[1]) : null,
    date: page === 'reports' && /^\d{4}-\d{2}-\d{2}$/.test(parts[1] || '') ? parts[1] : null,
  };
}

export function go(path) {
  if (location.hash !== `#/${path}`) location.hash = `#/${path}`;
}

window.addEventListener('hashchange', () => {
  const prev = getState().route;
  const route = parseRoute();
  setState({ route, detailsOpen: false });
  if (route.page === 'inbox' && route.id && route.id !== prev.id) openConversation(route.id);
  if (prev.id && prev.id !== route.id && isSup(getState().me)) socket?.unwatch(prev.id);
});

// ---------------------------------------------------------------- toasts

let toastSeq = 0;
export function toast(t) {
  const id = ++toastSeq;
  const item = { id, tone: 'info', timeout: 7000, ...t };
  setState((s) => ({
    toasts: [...s.toasts.filter((x) => !item.key || x.key !== item.key), item].slice(-5),
  }));
  if (item.timeout) setTimeout(() => dismissToast(id), item.timeout);
  return id;
}
export function dismissToast(id) {
  setState((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) }));
}
export const dismissToastKey = (key) => setState((s) => ({ toasts: s.toasts.filter((t) => t.key !== key) }));

function fail(err) {
  toast({ tone: 'hot', title: 'That did not work', text: err?.message || String(err) });
}

// ---------------------------------------------------------------- boot & session

onSignedOut((message) => {
  if (getState().phase !== 'app') return;
  endSession(message || 'Your session ended. Please sign in again.');
});

function endSession(note = null) {
  socket?.close();
  socket = null;
  setToken(null);
  setTitleCount(0);
  setState({ phase: 'login', me: null, convs: {}, threads: {}, team: [], toasts: [], loginNote: note });
}

export async function boot() {
  if (!getToken()) {
    setState({ phase: 'login' });
    return;
  }
  try {
    await startApp();
  } catch (err) {
    if (err instanceof ApiError && err.status === 401) endSession();
    else setState({ phase: 'login', loginError: err.message });
  }
}

export async function login(username, password) {
  unlockAudio();
  setState({ loginError: null, loginNote: null });
  try {
    const res = await post('/api/auth/login', { username, password });
    setToken(res.token);
    await startApp();
  } catch (err) {
    setState({ loginError: err.message });
  }
}

export async function logout() {
  try {
    await socket?.flushActivity();
    await post('/api/auth/logout');
  } catch {
    /* signing out locally anyway */
  }
  endSession('You are checked out. See you next shift.');
}

async function startApp() {
  const t0 = Date.now();
  const me = await get('/api/me');
  syncServerTime(me.server_time, t0);
  setTimeZone(me.settings.timezone);
  setState({ me: { ...me, fetched_at: now() }, phase: 'app', loginError: null });
  socket = connect({ onEvent: handleEvent, onStatus: (conn) => setState({ conn }) });
  await reloadData();
  const r = getState().route;
  if (r.page === 'inbox' && r.id) openConversation(r.id);
  document.addEventListener('pointerdown', unlockAudio, { once: true });
}

async function reloadData() {
  const me = getState().me;
  if (!me) return;
  const sup = isSup(me);
  const [mine, incoming, team, board] = await Promise.all([
    get('/api/conversations?scope=mine'),
    get('/api/conversations?scope=incoming'),
    get('/api/team'),
    sup ? get('/api/board') : null,
  ]);
  const convs = {};
  for (const c of [...(board?.conversations || []), ...mine.conversations, ...incoming.conversations]) {
    convs[c.id] = c;
    known.set(c.id, c);
  }
  setState({ convs, team: team.team, today: board?.today ?? getState().today });
  updateTitle();
  const active = getState().route.id;
  if (active) loadThread(active, { quiet: true });
}

export async function refreshMe() {
  try {
    const me = await get('/api/me');
    setState({ me: { ...me, fetched_at: now() } });
  } catch {
    /* next refresh */
  }
}

export async function refreshBoard() {
  if (!isSup(getState().me)) return;
  try {
    const board = await get('/api/board');
    const convs = { ...getState().convs };
    // Replace open chats wholesale, keep my own (they are in the board too).
    for (const id of Object.keys(convs)) if (convs[id].status !== 'closed') delete convs[id];
    for (const c of board.conversations) {
      convs[c.id] = c;
      known.set(c.id, c);
    }
    setState({ convs, team: board.team, today: board.today });
  } catch {
    /* next refresh */
  }
}

// ---------------------------------------------------------------- live events

function keepConv(conv, me) {
  if (conv.status === 'closed') return false;
  if (isSup(me)) return true;
  return conv.assigned_to === me.user.id || conv.transfer?.to === me.user.id;
}

function upsertConv(conv) {
  const s = getState();
  known.set(conv.id, conv);
  const convs = { ...s.convs };
  if (keepConv(conv, s.me)) convs[conv.id] = conv;
  else delete convs[conv.id];
  setState({ convs });
  updateTitle();
}

function updateTitle() {
  const { convs, me } = getState();
  if (!me) return;
  let waiting = 0;
  for (const c of Object.values(convs)) {
    if (c.assigned_to === me.user.id && c.waiting_since) waiting += 1;
    else if (c.transfer?.to === me.user.id) waiting += 1;
  }
  setTitleCount(waiting);
}

function upsertMessage(m) {
  const s = getState();
  const th = s.threads[m.conversation_id];
  if (!th) return;
  const messages = th.messages.slice();
  const i = messages.findIndex((x) => x.id === m.id);
  if (i >= 0) messages[i] = { ...messages[i], ...m };
  else messages.push(m);
  messages.sort((a, b) => new Date(a.created_at) - new Date(b.created_at) || a.id - b.id);
  setState({ threads: { ...s.threads, [m.conversation_id]: { ...th, messages } } });
  if (m.sender === 'customer' && s.route.id === m.conversation_id && document.visibilityState === 'visible') {
    markReadSoon(m.conversation_id);
  }
}

function addNote(n) {
  const s = getState();
  const th = s.threads[n.conversation_id];
  if (!th || th.notes.some((x) => x.id === n.id)) return;
  setState({ threads: { ...s.threads, [n.conversation_id]: { ...th, notes: [...th.notes, n] } } });
}

function handleEvent(m) {
  switch (m.t) {
    case 'conv':
      upsertConv(m.conv);
      break;
    case 'msg':
      upsertMessage(m.msg);
      break;
    case 'note':
      addNote(m.note);
      break;
    case 'team':
      setState({ team: m.team });
      break;
    case 'settings':
      setTimeZone(m.settings.timezone);
      setState((s) => ({ me: { ...s.me, settings: m.settings } }));
      break;
    case 'me':
      setState((s) => ({ me: { ...s.me, state: m.state } }));
      if (m.state.status === 'not_ready' && m.state.status_reason?.startsWith('set by')) {
        toast({ tone: 'warn', title: 'You were set to Not ready', text: `${m.state.status_reason}. Press Ready when you are back.` });
      }
      break;
    case 'toast':
      onServerToast(m.toast);
      break;
    case 'bye':
      endSession(
        {
          replaced: 'You signed in somewhere else, so this window was signed out.',
          timeout: 'You were offline for a while and have been checked out.',
          disabled: 'Your account was switched off. Ask your supervisor.',
          password_reset: 'Your password was reset. Sign in with the new one.',
          logout: null,
        }[m.reason] ?? 'Please sign in again.',
      );
      break;
    case 'poll':
    case 'resync':
      reloadData().catch(() => {});
      break;
    default:
      break;
  }
}

function onServerToast(t) {
  const s = getState();
  const conv = s.convs[t.conversation_id] || known.get(t.conversation_id);
  const name = t.customer_name || customerName(conv);
  const open = () => go(`inbox/${t.conversation_id}`);
  const teamName = (id) => s.team.find((x) => x.id === id)?.full_name || 'a teammate';

  switch (t.kind) {
    case 'assigned': {
      const urgent = t.urgent || (t.ms_left != null && t.ms_left < 5 * 60_000);
      const how = t.how === 'sla' ? 'Rescue: nobody answered it yet' : t.how === 'transfer' ? 'Transferred to you' : 'New chat';
      if (!urgent && t.how === 'auto') {
        // Several chats arriving together become one calm notice.
        const recent = s.toasts.find((x) => x.key === 'new-chats');
        const n = (recent?.count || 0) + 1;
        toast({
          key: 'new-chats', count: n, tone: 'info', icon: 'inbox', timeout: 6000,
          title: n > 1 ? `${n} new chats` : `New chat — ${name}`,
          text: n > 1 ? 'They are at the top of your queue.' : 'It is at the top of your queue.',
          actions: n > 1 ? [] : [{ label: 'Open', primary: true, run: open }],
        });
        chime('new');
        desktop(n > 1 ? `${n} new chats` : `New chat: ${name}`, 'Open 2B Desk to reply.', open);
        break;
      }
      toast({
        key: `c${t.conversation_id}`,
        tone: urgent ? 'hot' : 'info',
        icon: 'inbox',
        title: `${how} — ${name}`,
        text: t.ms_left != null
          ? t.ms_left > 0
            ? `${stopwatch(t.ms_left)} left before it is late.`
            : `Already late by ${human(-t.ms_left)}. Reply first.`
          : 'Open it to continue the conversation.',
        actions: [{ label: 'Open', primary: true, run: open }],
      });
      chime(urgent ? 'reminder' : 'new');
      desktop(`${how}: ${name}`, 'Open 2B Desk to reply.', open);
      break;
    }
    case 'reminder':
      toast({
        key: `c${t.conversation_id}`,
        tone: 'warn',
        icon: 'clock',
        title: `Reply to ${name}`,
        text: `Waiting ${human(t.waited_ms)}. ${t.ms_to_move > 0 ? `Moves to a teammate in ${stopwatch(t.ms_to_move)}.` : ''}`,
        actions: [{ label: 'Reply now', primary: true, run: open }],
        timeout: 15000,
      });
      chime('reminder');
      desktop(`Reply to ${name}`, `${stopwatch(Math.max(0, t.ms_left))} left before it is late.`, open);
      break;
    case 'late':
      if (t.holder != null && t.holder !== s.me.user.id) {
        toast({
          tone: 'hot', icon: 'alert', title: `Late chat — ${name}`,
          text: `With ${teamName(t.holder)}. Over ${s.me.settings.sla_minutes} minutes without a reply.`,
          actions: [{ label: 'Open', run: open }],
        });
      } else {
        toast({
          key: `c${t.conversation_id}`, tone: 'hot', icon: 'alert', title: `${name} is now late`,
          text: 'Over the SLA without a reply. Answer it first.',
          actions: [{ label: 'Reply now', primary: true, run: open }], timeout: 15000,
        });
      }
      chime('late');
      break;
    case 'removed': {
      const why = {
        timeout: `no reply in time — it went to ${teamName(t.to)}`,
        transferred: `${teamName(t.to)} took it over`,
        reassigned: `a supervisor gave it to ${teamName(t.to)}`,
        offline: 'you were disconnected',
        supervisor: 'a supervisor sent it back to the team',
      }[t.reason] || 'it was moved';
      if (s.route.id === t.conversation_id && !isSup(s.me)) go('inbox');
      toast({ tone: t.reason === 'timeout' ? 'warn' : 'info', icon: 'transfer', title: `Chat with ${name} moved`, text: `Because ${why}.` });
      break;
    }
    case 'transfer_request':
      toast({
        key: `tr${t.request_id}`,
        tone: 'info',
        icon: 'transfer',
        title: `${t.from_name} asks you to take a chat`,
        text: `${name}${t.note ? ` — “${t.note}”` : ''}`,
        timeout: 0,
        actions: [
          { label: 'Accept', primary: true, run: () => respondTransfer(t.request_id, true) },
          { label: 'No availability', run: () => respondTransfer(t.request_id, false) },
        ],
      });
      chime('transfer');
      desktop(`${t.from_name} needs help`, `Take the chat with ${name}?`, () => go('inbox'));
      break;
    case 'transfer_gone':
      dismissToastKey(`tr${t.request_id}`);
      break;
    case 'transfer_answer': {
      const who = t.to_name || teamName(t.to);
      const text = {
        accepted: `${who} took the chat with ${name}.`,
        declined: `${who} has no availability. Try someone else.`,
        expired: `${who} did not answer in time.`,
        cancelled: `${who} went offline.`,
      }[t.status];
      toast({ tone: t.status === 'accepted' ? 'ok' : 'warn', icon: 'transfer', title: 'Transfer request', text });
      break;
    }
    case 'send_failed':
      toast({
        tone: 'hot', icon: 'alert', title: 'Message not delivered',
        text: `${name}: ${t.error || 'the channel refused it'}. Open the chat to retry.`,
        actions: [{ label: 'Open', run: open }],
      });
      break;
    default:
      break;
  }
}

// ---------------------------------------------------------------- conversations

export async function loadThread(id, { quiet = false } = {}) {
  const s = getState();
  if (!quiet) {
    setState({ threads: { ...s.threads, [id]: { ...(s.threads[id] || { messages: [], notes: [], previous: [] }), loading: true, error: null } } });
  }
  try {
    const d = await get(`/api/conversations/${id}`);
    known.set(id, d.conversation);
    const convs = { ...getState().convs };
    if (keepConv(d.conversation, getState().me)) convs[id] = d.conversation;
    setState({
      convs,
      threads: {
        ...getState().threads,
        [id]: { messages: d.messages, notes: d.notes, previous: d.previous, conv: d.conversation, loading: false, error: null },
      },
    });
  } catch (err) {
    setState({
      threads: { ...getState().threads, [id]: { messages: [], notes: [], previous: [], loading: false, error: err.message } },
    });
  }
}

export function openConversation(id) {
  const s = getState();
  loadThread(id);
  if (isSup(s.me)) socket?.watch(id);
  const c = s.convs[id];
  if (c && c.assigned_to === s.me.user.id && c.unread > 0) markReadSoon(id);
  dismissToastKey(`c${id}`);
}

const readTimers = new Map();
function markReadSoon(id) {
  clearTimeout(readTimers.get(id));
  readTimers.set(id, setTimeout(() => post(`/api/conversations/${id}/read`).catch(() => {}), 600));
}

let meTimer = null;
function refreshMeSoon() {
  clearTimeout(meTimer);
  meTimer = setTimeout(refreshMe, 4000);
}

export async function sendReply(id, text) {
  try {
    const res = await post(`/api/conversations/${id}/messages`, { text });
    upsertMessage(res.message);
    refreshMeSoon();
    return true;
  } catch (err) {
    fail(err);
    if (err.data?.moved) loadThread(id, { quiet: true });
    return false;
  }
}

export const retryMessage = (msgId) => post(`/api/messages/${msgId}/retry`).catch(fail);
export const setCategory = (id, category) => post(`/api/conversations/${id}/category`, { category }).catch(fail);

export async function resolve(id, note) {
  try {
    await post(`/api/conversations/${id}/close`, { note });
    toast({ tone: 'ok', icon: 'check', title: 'Resolved', text: 'The customer goes back to the AI agent.' });
    if (getState().route.id === id) go('inbox');
  } catch (err) {
    fail(err);
  }
}

export async function requestTransfer(id, to, note) {
  try {
    await post(`/api/conversations/${id}/transfer`, { to, note });
    return true;
  } catch (err) {
    fail(err);
    return false;
  }
}

export async function respondTransfer(requestId, accept) {
  dismissToastKey(`tr${requestId}`);
  try {
    const res = await post(`/api/transfers/${requestId}/${accept ? 'accept' : 'decline'}`);
    if (accept && res.conversation_id) go(`inbox/${res.conversation_id}`);
  } catch (err) {
    fail(err);
  }
}

export const cancelTransfer = (requestId) => post(`/api/transfers/${requestId}/cancel`).catch(fail);

export async function reassign(id, to) {
  try {
    await post(`/api/conversations/${id}/assign`, { to });
    toast({ tone: 'ok', icon: 'transfer', title: 'Reassigned' });
  } catch (err) {
    fail(err);
  }
}

export const requeue = (id) => post(`/api/conversations/${id}/requeue`).catch(fail);
export const forceNotReady = (userId) => post(`/api/agents/${userId}/not-ready`).catch(fail);

export async function setStatus(status) {
  unlockAudio();
  const prev = getState().me.state;
  setState((s) => ({ me: { ...s.me, state: { ...s.me.state, status, status_since: new Date(now()).toISOString() } } }));
  try {
    const res = await post('/api/me/status', { status });
    setState((s) => ({ me: { ...s.me, state: res.state } }));
  } catch (err) {
    setState((s) => ({ me: { ...s.me, state: prev } }));
    fail(err);
  }
}

export { api, get, post };
