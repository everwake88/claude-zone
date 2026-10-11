// Every HTTP endpoint the dashboard and n8n use.
import { Router, readJson, sendJson, securityHeaders, applyCors, clientIp, createLimiter, createStatic } from './http.js';
import { HttpError, badRequest, forbidden, notFound } from './errors.js';
import { safeEqual } from './auth.js';
import { isSupervisor } from './desk.js';
import { CONV_FIELDS, CONV_FROM, teamSnapshot, publicUser, dayWindow } from './views.js';
import { publicSettings } from './settings.js';
import { dayReport, agentsCsv } from './reports.js';
import { journey } from './journey.js';

const THREAD_NOTES = [
  'opened', 'assigned', 'returned', 'transfer_requested', 'transfer_accepted', 'transfer_declined',
  'transfer_expired', 'transfer_cancelled', 'late', 'category', 'closed', 'no_target', 'send_failed',
];

export function createApi({ db, desk, settings, clock, config, hub = null, log = console }) {
  const router = new Router();
  const loginLimiter = createLimiter({ windowMs: 15 * 60_000, max: 10 });
  const ipLimiter = createLimiter({ windowMs: 15 * 60_000, max: 60 });
  setInterval(() => {
    loginLimiter.sweep();
    ipLimiter.sweep();
  }, 60_000).unref();

  // ---- who may see what ----------------------------------------------------

  async function canView(auth, convId) {
    if (isSupervisor(auth.user)) return true;
    const row = await db.one(
      `SELECT c.id FROM desk.conversations c
        WHERE c.id = $1 AND (
          (c.status = 'assigned' AND c.assigned_to = $2)
          OR EXISTS (SELECT 1 FROM desk.transfer_requests tr
                      WHERE tr.conversation_id = c.id AND tr.to_user = $2 AND tr.status = 'pending')
          OR (c.status = 'closed' AND (c.closed_by = $2 OR c.assigned_to = $2))
          -- earlier chats with a customer you are serving right now
          OR EXISTS (SELECT 1 FROM desk.conversations o
                      WHERE o.channel = c.channel AND o.external_id = c.external_id
                        AND o.status = 'assigned' AND o.assigned_to = $2)
        )`,
      [convId, auth.user.id],
    );
    return !!row;
  }

  const requireSupervisor = (auth) => {
    if (!isSupervisor(auth.user)) throw forbidden('Supervisors only.');
  };
  const requireAdmin = (auth) => {
    if (auth.user.role !== 'admin') throw forbidden('Admins only.');
  };
  const id = (v) => {
    const n = Number(v);
    if (!Number.isSafeInteger(n) || n <= 0) throw notFound();
    return n;
  };

  // ---- public ----------------------------------------------------------------

  router.add('GET', '/api/health', async () => ({ ok: true, time: clock.now() }), { public: true });

  router.add(
    'POST',
    '/api/auth/login',
    async ({ req, body }) => {
      const ip = clientIp(req, config.trustProxy);
      const key = `${ip}|${String(body.username || '').toLowerCase()}`;
      if (!ipLimiter.hit(ip) || !loginLimiter.hit(key)) {
        throw new HttpError(429, 'Too many attempts. Wait 15 minutes, or ask your supervisor to reset your password.');
      }
      const result = await desk.login({
        username: body.username, password: body.password, ip, userAgent: req.headers['user-agent'],
      });
      loginLimiter.clear(key);
      return result;
    },
    { public: true },
  );

  // ---- from n8n --------------------------------------------------------------

  router.add('GET', '/api/ingest/ping', async () => ({ ok: true, desk: '2B Desk' }), { ingest: true });
  router.add('POST', '/api/ingest/handoff', async ({ body }) => desk.ingestHandoff(body), {
    ingest: true, limit: 512 * 1024,
  });
  router.add('POST', '/api/ingest/message', async ({ body }) => desk.ingestMessage(body), { ingest: true });

  // ---- me --------------------------------------------------------------------

  router.add('POST', '/api/auth/logout', async ({ auth }) => {
    await desk.logout(auth);
    return { ok: true };
  });
  router.add('GET', '/api/me', async ({ auth }) => desk.me(auth));
  router.add('POST', '/api/me/status', async ({ auth, body }) => ({ state: await desk.setStatus(auth, body.status) }));
  router.add('POST', '/api/me/heartbeat', async ({ auth }) => {
    await desk.touch(auth);
    return { ok: true, server_time: clock.now() };
  });
  router.add('POST', '/api/me/activity', async ({ auth, body }) => {
    await desk.recordActivity(auth, body.k, body.ms);
    return { ok: true };
  });
  router.add('POST', '/api/me/password', async ({ auth, body }) => {
    await desk.changeOwnPassword(auth, body.current, body.next);
    return { ok: true };
  });

  router.add('GET', '/api/team', async () => ({ team: await teamSnapshot(db, await settings.get()) }));
  router.add('GET', '/api/settings', async () => ({ settings: publicSettings(await settings.get()) }));
  router.add('PUT', '/api/settings', async ({ auth, body }) => {
    requireAdmin(auth);
    const next = publicSettings(await settings.update(body));
    hub?.toAll({ t: 'settings', settings: next }); // every open dashboard redraws its countdowns
    return { settings: next };
  });

  // ---- conversations -------------------------------------------------------

  router.add('GET', '/api/conversations', async ({ auth, query }) => {
    const scope = query.get('scope') || 'mine';
    const s = await settings.get();
    const where = [];
    const params = [];
    const p = (v) => {
      params.push(v);
      return `$${params.length}`;
    };
    if (scope === 'mine') {
      where.push(`c.status = 'assigned' AND c.assigned_to = ${p(auth.user.id)}`);
    } else if (scope === 'incoming') {
      where.push(
        `EXISTS (SELECT 1 FROM desk.transfer_requests x WHERE x.conversation_id = c.id
                  AND x.to_user = ${p(auth.user.id)} AND x.status = 'pending')`,
      );
    } else {
      requireSupervisor(auth);
      if (scope === 'open') where.push(`c.status <> 'closed'`);
      else if (scope === 'queue') where.push(`c.status = 'queued'`);
      else if (scope === 'late') where.push(`c.status <> 'closed' AND c.breached_at IS NOT NULL`);
      else if (scope === 'day') {
        const win = await dayWindow(db, clock.now(), s.timezone, query.get('date') || null);
        where.push(`c.opened_at >= ${p(win.start)} AND c.opened_at < ${p(win.end)}`);
      } else throw badRequest('Unknown scope.');
      const agent = query.get('agent');
      if (agent) where.push(`c.assigned_to = ${p(id(agent))}`);
      const q = (query.get('q') || '').trim();
      if (q) {
        const like = p(`%${q.replace(/[\\%_]/g, (m) => '\\' + m)}%`);
        where.push(`(c.customer_name ILIKE ${like} OR c.customer_phone ILIKE ${like} OR c.external_id ILIKE ${like})`);
      }
    }
    const rows = await db.q(
      `SELECT ${CONV_FIELDS} ${CONV_FROM}
        WHERE ${where.join(' AND ')}
        ORDER BY c.waiting_since ASC NULLS LAST, c.last_message_at DESC NULLS LAST, c.id DESC
        LIMIT 1000`,
      params,
    );
    return { conversations: rows, server_time: clock.now() };
  });

  router.add('GET', '/api/conversations/:id', async ({ auth, params }) => {
    const convId = id(params.id);
    if (!(await canView(auth, convId))) throw forbidden('This chat is not in your queue.');
    const [conversation, messages, notes] = await Promise.all([
      db.one(`SELECT ${CONV_FIELDS} ${CONV_FROM} WHERE c.id = $1`, [convId]),
      db.q(
        `SELECT * FROM (
           SELECT m.id, m.conversation_id, m.sender, m.user_id, u.full_name AS author_name,
                  m.body, m.delivery, m.error, m.created_at
             FROM desk.messages m LEFT JOIN desk.users u ON u.id = m.user_id
            WHERE m.conversation_id = $1
            ORDER BY m.created_at DESC, m.id DESC
            LIMIT 400) x
          ORDER BY created_at, id`,
        [convId],
      ),
      db.q(
        `SELECT id, conversation_id, type, user_id, actor_id, data, created_at
           FROM desk.events WHERE conversation_id = $1 AND type = ANY($2) ORDER BY id`,
        [convId, THREAD_NOTES],
      ),
    ]);
    if (!conversation) throw notFound();
    const previous = await db.q(
      `SELECT c.id, c.category, c.opened_at, c.closed_at, u.full_name AS closed_by_name, c.last_preview
         FROM desk.conversations c LEFT JOIN desk.users u ON u.id = c.closed_by
        WHERE c.channel = $1 AND c.external_id = $2 AND c.id <> $3 AND c.opened_at < $4
        ORDER BY c.opened_at DESC LIMIT 10`,
      [conversation.channel, conversation.external_id, convId, conversation.opened_at],
    );
    return { conversation, messages, notes, previous, server_time: clock.now() };
  });

  router.add('GET', '/api/conversations/:id/journey', async ({ auth, params }) => {
    requireSupervisor(auth);
    const j = await journey(db, id(params.id), { at: clock.now(), s: await settings.get() });
    if (!j) throw notFound();
    return j;
  });

  router.add('POST', '/api/conversations/:id/messages', async ({ auth, params, body }) => {
    const { message } = await desk.sendReply(auth, id(params.id), body.text);
    return { message };
  });
  router.add('POST', '/api/messages/:id/retry', async ({ auth, params }) => {
    const { message } = await desk.retryMessage(auth, id(params.id));
    return { message };
  });
  router.add('POST', '/api/conversations/:id/read', async ({ auth, params }) => {
    await desk.markRead(auth, id(params.id));
    return { ok: true };
  });
  router.add('POST', '/api/conversations/:id/category', async ({ auth, params, body }) => {
    await desk.setCategory(auth, id(params.id), body.category);
    return { ok: true };
  });
  router.add('POST', '/api/conversations/:id/close', async ({ auth, params, body }) => {
    await desk.close(auth, id(params.id), body.note);
    return { ok: true };
  });
  router.add('POST', '/api/conversations/:id/transfer', async ({ auth, params, body }) => ({
    request: await desk.requestTransfer(auth, id(params.id), body.to, body.note),
  }));
  router.add('POST', '/api/conversations/:id/assign', async ({ auth, params, body }) => {
    await desk.supervisorAssign(auth, id(params.id), body.to);
    return { ok: true };
  });
  router.add('POST', '/api/conversations/:id/requeue', async ({ auth, params }) => {
    await desk.supervisorRequeue(auth, id(params.id));
    return { ok: true };
  });

  router.add('POST', '/api/transfers/:id/accept', async ({ auth, params }) =>
    desk.respondTransfer(auth, id(params.id), true),
  );
  router.add('POST', '/api/transfers/:id/decline', async ({ auth, params }) =>
    desk.respondTransfer(auth, id(params.id), false),
  );
  router.add('POST', '/api/transfers/:id/cancel', async ({ auth, params }) => {
    await desk.cancelTransfer(auth, id(params.id));
    return { ok: true };
  });

  // ---- supervisors ---------------------------------------------------------

  router.add('GET', '/api/board', async ({ auth }) => {
    requireSupervisor(auth);
    const s = await settings.get();
    const at = clock.now();
    const win = await dayWindow(db, at, s.timezone);
    const [team, conversations, today] = await Promise.all([
      teamSnapshot(db, s),
      db.q(
        `SELECT ${CONV_FIELDS} ${CONV_FROM} WHERE c.status <> 'closed'
          ORDER BY c.waiting_since ASC NULLS LAST, c.last_message_at DESC NULLS LAST LIMIT 2000`,
      ),
      db.one(
        `SELECT
           (SELECT count(*) FROM desk.conversations WHERE opened_at >= $1 AND opened_at < $2)::int AS new_chats,
           (SELECT count(DISTINCT conversation_id) FROM desk.messages
             WHERE sender = 'agent' AND delivery = 'sent' AND created_at >= $1 AND created_at < $2)::int AS handled,
           (SELECT count(*) FROM desk.conversations WHERE closed_at >= $1 AND closed_at < $2)::int AS resolved,
           (SELECT count(*) FROM desk.events WHERE type = 'replied' AND created_at >= $1 AND created_at < $2)::int AS answered,
           (SELECT count(*) FROM desk.events WHERE type = 'replied' AND created_at >= $1 AND created_at < $2
               AND (data->>'late_ms')::numeric > 0)::int AS late_replies,
           (SELECT avg((data->>'wait_ms')::numeric)::bigint FROM desk.events
             WHERE type = 'replied' AND created_at >= $1 AND created_at < $2) AS avg_wait_ms`,
        [win.start, win.end],
      ),
    ]);
    return { team, conversations, today, server_time: at, settings: publicSettings(s) };
  });

  router.add('POST', '/api/agents/:id/not-ready', async ({ auth, params }) => {
    await desk.supervisorSetStatus(auth, id(params.id), 'not_ready');
    return { ok: true };
  });

  router.add('GET', '/api/reports/day', async ({ auth, query }) => {
    requireSupervisor(auth);
    const date = query.get('date');
    if (date && !/^\d{4}-\d{2}-\d{2}$/.test(date)) throw badRequest('Date must look like 2026-10-11.');
    return dayReport(db, { at: clock.now(), s: await settings.get(), date });
  });

  router.add(
    'GET',
    '/api/reports/day.csv',
    async ({ auth, query, res }) => {
      requireSupervisor(auth);
      const date = query.get('date');
      if (date && !/^\d{4}-\d{2}-\d{2}$/.test(date)) throw badRequest('Date must look like 2026-10-11.');
      const s = await settings.get();
      const report = await dayReport(db, { at: clock.now(), s, date });
      res.writeHead(200, {
        'content-type': 'text/csv; charset=utf-8',
        'content-disposition': `attachment; filename="2b-desk-agents-${report.date}.csv"`,
        'cache-control': 'no-store',
      });
      res.end(agentsCsv(report, s.timezone));
    },
    { raw: true },
  );

  router.add('GET', '/api/users', async ({ auth }) => {
    requireSupervisor(auth);
    const rows = await db.q(
      `SELECT u.*, (SELECT max(checked_in_at) FROM desk.sessions s WHERE s.user_id = u.id) AS last_login
         FROM desk.users u ORDER BY u.is_active DESC, u.full_name`,
    );
    return { users: rows.map((u) => ({ ...publicUser(u), last_login: u.last_login, created_at: u.created_at })) };
  });
  router.add('POST', '/api/users', async ({ auth, body }) => {
    requireSupervisor(auth);
    return desk.createUser(auth, body);
  });
  router.add('PATCH', '/api/users/:id', async ({ auth, params, body }) => {
    requireSupervisor(auth);
    return desk.updateUser(auth, id(params.id), body);
  });

  // ---- request handling --------------------------------------------------------

  const serveStatic = config.serveWeb
    ? createStatic(config.webDir, {
        csp: (req) => {
          const host = req.headers.host;
          const ws = host ? ` wss://${host} ws://${host}` : '';
          return [
            "default-src 'self'",
            "script-src 'self'",
            "style-src 'self'",
            "img-src 'self' data:",
            `connect-src 'self'${ws}`,
            "font-src 'self'",
            "object-src 'none'",
            "base-uri 'self'",
            "form-action 'self'",
            "frame-ancestors 'none'",
          ].join('; ');
        },
      })
    : null;

  async function handle(req, res) {
    securityHeaders(res);
    let url;
    try {
      url = new URL(req.url, 'http://localhost');
    } catch {
      return sendJson(res, 400, { error: 'Bad URL.' });
    }
    const pathname = url.pathname;

    if (pathname.startsWith('/api/')) {
      applyCors(req, res, config.corsOrigins);
      if (req.method === 'OPTIONS') {
        res.writeHead(204);
        return res.end();
      }
      try {
        const found = router.match(req.method, pathname);
        if (!found) throw notFound('No such endpoint.');
        if (found.methodNotAllowed) throw new HttpError(405, 'Method not allowed.');
        const { route, params } = found;
        let auth = null;
        if (route.opts.ingest) {
          if (!config.ingestSecret) {
            throw new HttpError(503, 'Set DESK_INGEST_SECRET on the server to accept data from n8n.');
          }
          const given = req.headers['x-desk-secret'] || '';
          if (!safeEqual(given, config.ingestSecret)) throw new HttpError(401, 'Wrong or missing X-Desk-Secret.');
        } else if (!route.opts.public) {
          const header = String(req.headers.authorization || '');
          const token = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
          auth = await desk.authenticate(token);
          if (!auth) throw new HttpError(401, 'Your session ended. Please sign in again.', { signed_out: true });
        }
        const body =
          req.method === 'GET' || req.method === 'HEAD' ? {} : await readJson(req, route.opts.limit || 64 * 1024);
        const result = await route.handler({ req, res, params, query: url.searchParams, body, auth });
        if (route.opts.raw) return;
        return sendJson(res, 200, result);
      } catch (err) {
        if (err instanceof HttpError) return sendJson(res, err.status, { error: err.message, ...err.extra });
        log.error?.('[api]', req.method, pathname, err);
        return sendJson(res, 500, { error: 'Something went wrong on the server. Try again in a moment.' });
      }
    }

    if (serveStatic && (await serveStatic(req, res, pathname))) return;
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('Not found');
  }

  return { handle, canView };
}
