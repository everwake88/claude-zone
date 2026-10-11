// Realtime: one WebSocket per open dashboard.
//
// The browser authenticates with its first message ({t:'auth', token}), then
// sends a heartbeat every ~20s (that is how the server knows an agent is still
// there) and its typing activity. The server pushes every change that matters
// to that person: their queue, new messages, reminders, transfer requests, the
// team's load. Supervisors additionally receive every chat update.
import { WebSocketServer } from 'ws';

const isSupervisorRole = (role) => role === 'supervisor' || role === 'admin';

export function createHub({ log = console } = {}) {
  const sockets = new Map(); // ws -> { auth, watching:Set<number>, alive }
  const byUser = new Map(); // userId -> Set<ws>
  let wss = null;
  let pinger = null;

  function send(ws, payload) {
    if (ws.readyState === 1) ws.send(JSON.stringify(payload));
  }

  function toUser(userId, payload) {
    for (const ws of byUser.get(Number(userId)) || []) send(ws, payload);
  }

  function toSupervisors(payload) {
    for (const [ws, st] of sockets) if (st.auth && isSupervisorRole(st.auth.user.role)) send(ws, payload);
  }

  function toAll(payload) {
    for (const [ws, st] of sockets) if (st.auth) send(ws, payload);
  }

  function recipients(convId, users, { supervisors }) {
    const out = new Set();
    for (const [ws, st] of sockets) {
      if (!st.auth) continue;
      if (
        users.has(st.auth.user.id) ||
        st.watching.has(convId) ||
        (supervisors && isSupervisorRole(st.auth.user.role))
      ) {
        out.add(ws);
      }
    }
    return out;
  }

  const hub = {
    conv(conv, users) {
      const payload = { t: 'conv', conv };
      for (const ws of recipients(conv.id, users, { supervisors: true })) send(ws, payload);
    },
    message(msg, conv) {
      const users = new Set();
      if (conv?.assigned_to) users.add(conv.assigned_to);
      if (conv?.transfer) users.add(conv.transfer.to);
      for (const ws of recipients(Number(msg.conversation_id), users, { supervisors: false })) {
        send(ws, { t: 'msg', msg });
      }
    },
    note(note, conv) {
      const users = new Set();
      if (conv?.assigned_to) users.add(conv.assigned_to);
      for (const ws of recipients(Number(note.conversation_id), users, { supervisors: false })) {
        send(ws, { t: 'note', note });
      }
    },
    team(team) {
      toAll({ t: 'team', team });
    },
    me(userId, state) {
      toUser(userId, { t: 'me', state });
    },
    toUser,
    toSupervisors,
    toAll,
    endSession(sessionId, reason) {
      for (const [ws, st] of sockets) {
        if (st.auth?.session.id === sessionId) {
          send(ws, { t: 'bye', reason });
          setTimeout(() => ws.close(4000, reason), 50);
        }
      }
    },
    connectedUserIds() {
      return [...byUser.keys()];
    },

    attach(server, { desk, canView, allowedOrigins = [], path = '/ws', clock }) {
      wss = new WebSocketServer({ noServer: true, maxPayload: 32 * 1024 });

      server.on('upgrade', (req, socket, head) => {
        let pathname;
        try {
          pathname = new URL(req.url, 'http://localhost').pathname;
        } catch {
          pathname = '';
        }
        if (pathname !== path) {
          socket.destroy();
          return;
        }
        const origin = req.headers.origin;
        if (origin) {
          let ok = allowedOrigins.includes(origin.replace(/\/+$/, ''));
          try {
            ok = ok || new URL(origin).host === req.headers.host;
          } catch {
            /* malformed origin */
          }
          if (!ok) {
            socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
            socket.destroy();
            return;
          }
        }
        wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
      });

      wss.on('connection', (ws) => {
        const st = { auth: null, watching: new Set(), alive: true };
        sockets.set(ws, st);
        const authTimer = setTimeout(() => {
          if (!st.auth) ws.close(4001, 'auth timeout');
        }, 10_000);

        ws.on('pong', () => {
          st.alive = true;
        });

        ws.on('message', async (raw) => {
          let msg;
          try {
            msg = JSON.parse(String(raw));
          } catch {
            return;
          }
          try {
            if (!st.auth) {
              if (msg.t !== 'auth') return;
              const auth = await desk.authenticate(msg.token);
              if (!auth) {
                send(ws, { t: 'bye', reason: 'unauthorized' });
                ws.close(4001, 'unauthorized');
                return;
              }
              st.auth = auth;
              clearTimeout(authTimer);
              if (!byUser.has(auth.user.id)) byUser.set(auth.user.id, new Set());
              byUser.get(auth.user.id).add(ws);
              await desk.connected(auth);
              send(ws, { t: 'hello', server_time: clock.now() });
              return;
            }
            switch (msg.t) {
              case 'hb':
                await desk.touch(st.auth);
                send(ws, { t: 'hb', server_time: clock.now() });
                break;
              case 'activity':
                await desk.recordActivity(st.auth, msg.k, msg.ms);
                break;
              case 'watch': {
                const id = Number(msg.id);
                if (Number.isInteger(id) && (await canView(st.auth, id))) st.watching.add(id);
                break;
              }
              case 'unwatch':
                st.watching.delete(Number(msg.id));
                break;
              default:
                break;
            }
          } catch (err) {
            log.error?.('[ws]', err);
          }
        });

        ws.on('close', () => {
          clearTimeout(authTimer);
          sockets.delete(ws);
          if (st.auth) {
            const set = byUser.get(st.auth.user.id);
            set?.delete(ws);
            if (set && !set.size) byUser.delete(st.auth.user.id);
          }
        });
        ws.on('error', () => {});
      });

      // Drop sockets that stopped answering pings (sleeping laptop, dead Wi-Fi).
      pinger = setInterval(() => {
        for (const [ws, st] of sockets) {
          if (!st.alive) {
            ws.terminate();
            continue;
          }
          st.alive = false;
          try {
            ws.ping();
          } catch {
            /* closing */
          }
        }
      }, 30_000);
      pinger.unref?.();
    },

    close() {
      clearInterval(pinger);
      for (const ws of sockets.keys()) ws.terminate();
      wss?.close();
    },
  };
  return hub;
}
