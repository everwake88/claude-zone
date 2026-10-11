// The live connection. Reconnects on its own; while it is down the page keeps
// working by polling, and heartbeats go over plain HTTP so the agent is never
// marked offline just because a proxy blocks WebSockets.
import { api, getToken, wsUrl } from './api.js';
import { syncServerTime } from './time.js';
import * as typing from './typing.js';

export function connect({ onEvent, onStatus }) {
  let ws = null;
  let closed = false;
  let retry = 0;
  let retryTimer = null;
  let pollTimer = null;
  let hbSentAt = 0;
  const watching = new Set();

  const send = (m) => {
    if (ws && ws.readyState === 1) {
      ws.send(JSON.stringify(m));
      return true;
    }
    return false;
  };

  function startPolling() {
    if (pollTimer) return;
    pollTimer = setInterval(() => onEvent({ t: 'poll' }), 8000);
  }
  function stopPolling() {
    clearInterval(pollTimer);
    pollTimer = null;
  }

  function open() {
    if (closed) return;
    onStatus(retry ? 'reconnecting' : 'connecting');
    try {
      ws = new WebSocket(wsUrl());
    } catch {
      scheduleRetry();
      return;
    }
    ws.onopen = () => send({ t: 'auth', token: getToken() });
    ws.onmessage = (e) => {
      let m;
      try {
        m = JSON.parse(e.data);
      } catch {
        return;
      }
      if (m.t === 'hello') {
        syncServerTime(m.server_time);
        const wasRetry = retry > 0;
        retry = 0;
        stopPolling();
        onStatus('online');
        for (const id of watching) send({ t: 'watch', id });
        if (wasRetry) onEvent({ t: 'resync' });
        return;
      }
      if (m.t === 'hb') {
        syncServerTime(m.server_time, hbSentAt);
        return;
      }
      onEvent(m);
    };
    ws.onclose = (e) => {
      ws = null;
      if (closed) return;
      if (e.code === 4001) {
        onEvent({ t: 'bye', reason: 'unauthorized' });
        return;
      }
      onStatus('offline');
      startPolling();
      scheduleRetry();
    };
    ws.onerror = () => {};
  }

  function scheduleRetry() {
    clearTimeout(retryTimer);
    const delay = Math.min(15_000, 800 * 2 ** retry) + Math.random() * 400;
    retry += 1;
    retryTimer = setTimeout(open, delay);
  }

  const beat = setInterval(() => {
    const act = typing.take();
    hbSentAt = Date.now();
    if (send({ t: 'hb' })) {
      if (act.k || act.ms) send({ t: 'activity', ...act });
    } else {
      api('POST', '/api/me/heartbeat').catch(() => {});
      if (act.k || act.ms) api('POST', '/api/me/activity', act).catch(() => {});
    }
  }, 20_000);

  // Laptop woke up or the tab came back: check in straight away.
  const onVisible = () => {
    if (document.visibilityState !== 'visible' || closed) return;
    if (!ws) {
      clearTimeout(retryTimer);
      open();
    } else {
      hbSentAt = Date.now();
      send({ t: 'hb' });
    }
  };
  document.addEventListener('visibilitychange', onVisible);
  window.addEventListener('online', onVisible);

  open();

  return {
    watch(id) {
      watching.add(id);
      send({ t: 'watch', id });
    },
    unwatch(id) {
      watching.delete(id);
      send({ t: 'unwatch', id });
    },
    flushActivity() {
      const act = typing.take();
      if (!act.k && !act.ms) return Promise.resolve();
      if (send({ t: 'activity', ...act })) return Promise.resolve();
      return api('POST', '/api/me/activity', act).catch(() => {});
    },
    close() {
      closed = true;
      clearInterval(beat);
      clearTimeout(retryTimer);
      stopPolling();
      document.removeEventListener('visibilitychange', onVisible);
      window.removeEventListener('online', onVisible);
      try {
        ws?.close(1000, 'bye');
      } catch {
        /* ignore */
      }
    },
  };
}
