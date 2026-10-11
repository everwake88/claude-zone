// The 2B Desk engine: who gets which chat, and what happens when nobody replies.
//
// The rules, in plain words (all numbers live in desk.settings):
//
//   * Only agents who are logged in, connected and pressed READY receive chats.
//   * New chats go to the ready agent with the fewest chats. Nobody ever holds
//     more than max_chats (25). When everyone is full, chats wait in the team
//     queue and are handed out, oldest first, the moment someone has room.
//   * The SLA clock starts when a customer writes and stops when an agent
//     replies. The first agent gets first_hold_minutes (10) to reply, with
//     reminders at reminder_minutes (5 and 8).
//   * No reply by then -> the chat moves to the least-busy ready agent who has
//     not had it yet, for hop_minutes (1). And again, every minute, until
//     somebody replies.
//   * At sla_minutes (15) the chat is marked LATE and keeps hopping. Every hop
//     is recorded so supervisors can see who had it, how busy they were, and
//     whether they were typing.
//
// Every decision that moves a chat runs inside one Postgres transaction holding
// a single advisory lock, so two chats arriving at the same instant can never
// both land on the agent who had one free slot.
import { randomUUID } from 'node:crypto';
import { Effects } from './effects.js';
import { HttpError, badRequest, forbidden, notFound, conflict } from './errors.js';
import { hashPassword, verifyPassword, newToken, hashToken, generatePassword } from './auth.js';
import { convSummaries, convSummary, teamSnapshot, publicUser, agentState } from './views.js';
import { publicSettings } from './settings.js';
import { agentDayStats } from './reports.js';

const ROUTING_LOCK = 727275;
// What each channel accepts in one message.
export const MESSAGE_LIMITS = { whatsapp: 4000, messenger: 2000, instagram: 1000 };
const CHANNEL_LABEL = { whatsapp: 'WhatsApp', messenger: 'Messenger', instagram: 'Instagram' };
const SESSION_MAX_MS = 16 * 3600_000; // a shift, with room to spare
const REPLY_GUARD_MS = 30_000; // a reply on its way protects the chat from moving

const CHANNEL_ALIASES = {
  whatsapp: 'whatsapp', wa: 'whatsapp',
  messenger: 'messenger', facebook: 'messenger', fb: 'messenger',
  instagram: 'instagram', ig: 'instagram',
};
const CATEGORY_ALIASES = {
  inquiry: 'inquiry', enquiry: 'inquiry', question: 'inquiry', general: 'inquiry', browsing: 'inquiry',
  sales: 'sales', sale: 'sales', buying: 'sales', purchase: 'sales', order_new: 'sales',
  complaint: 'complaint', complaints: 'complaint', complain: 'complaint',
  followup: 'followup', follow_up: 'followup', 'follow-up': 'followup', order: 'followup',
  order_followup: 'followup', order_status: 'followup',
};

export const isSupervisor = (u) => !!u && (u.role === 'supervisor' || u.role === 'admin');

function cleanText(v, max) {
  return String(v ?? '').replace(/\u0000/g, '').trim().slice(0, max);
}

function previewOf(text) {
  return cleanText(text, 400).replace(/\s+/g, ' ').slice(0, 160);
}

export function normalizeChannel(v) {
  return CHANNEL_ALIASES[String(v ?? '').toLowerCase().trim()] ?? null;
}

export function normalizeCategory(v) {
  if (v == null || v === '') return null;
  return CATEGORY_ALIASES[String(v).toLowerCase().trim().replace(/[\s-]+/g, '_')] ??
    CATEGORY_ALIASES[String(v).toLowerCase().trim()] ?? null;
}

function parseCustomer(b) {
  const channel = normalizeChannel(b.channel ?? b.platform);
  if (!channel) throw badRequest('channel must be whatsapp, messenger or instagram.');
  const externalId = cleanText(b.external_id ?? b.psid ?? b.wa_jid ?? b.jid, 200);
  if (!externalId) throw badRequest('external_id is required.');
  let phone = cleanText(b.phone, 40) || null;
  if (!phone && channel === 'whatsapp') phone = externalId.split('@')[0].replace(/\D/g, '') || null;
  return {
    channel,
    external_id: externalId,
    customer_ref: cleanText(b.customer_ref ?? b.customer_id, 100) || null,
    name: cleanText(b.customer_name ?? b.name ?? b.push_name, 120) || null,
    phone,
  };
}

// Earlier messages the AI passes along with a hand-off. Times are only trusted
// when they carry a time zone; otherwise order is kept and times are filled in.
function normalizeHistory(items, at) {
  const out = [];
  for (const h of Array.isArray(items) ? items.slice(-60) : []) {
    if (!h) continue;
    const text = cleanText(typeof h === 'string' ? h : h.text ?? h.content ?? h.body, 4000);
    if (!text) continue;
    const role = String(h.role ?? h.sender ?? '').toLowerCase();
    const sender = ['customer', 'user', 'client', 'human'].includes(role) ? 'customer' : 'ai';
    let t = null;
    if (typeof h.at === 'string' && /([zZ]|[+-]\d\d:?\d\d)$/.test(h.at.trim())) {
      t = new Date(h.at);
      if (Number.isNaN(t.getTime()) || t > at || at - t > 30 * 86400_000) t = null;
    }
    out.push({ sender, body: text, at: t });
  }
  let last = null;
  out.forEach((m, i) => {
    if (!m.at) m.at = new Date(at.getTime() - (out.length - i) * 1000);
    if (last && m.at <= last) m.at = new Date(last.getTime() + 1);
    last = m.at;
  });
  return out;
}

export function createDesk({ db, clock, hub = null, outbound, settings, log = console }) {
  const now = () => clock.now();

  const lock = (c) => c.q('SELECT pg_advisory_xact_lock($1)', [ROUTING_LOCK]);

  async function addEvent(c, fx, { conv = null, type, user = null, actor = null, data = {}, at }) {
    const row = await c.one(
      `INSERT INTO desk.events (conversation_id, type, user_id, actor_id, data, created_at)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING id, conversation_id, type, user_id, actor_id, data, created_at`,
      [conv, type, user, actor, data, at],
    );
    if (conv) fx.note(row);
    return row;
  }

  // ---------------------------------------------------------------------------
  // Presence
  // ---------------------------------------------------------------------------

  async function ensureState(c, userId, at) {
    await c.q(
      `INSERT INTO desk.agent_state (user_id, status, status_since) VALUES ($1, 'offline', $2)
       ON CONFLICT (user_id) DO NOTHING`,
      [userId, at],
    );
  }

  async function setStatusTx(c, fx, userId, status, reason, at) {
    await ensureState(c, userId, at);
    const cur = await c.one('SELECT status FROM desk.agent_state WHERE user_id = $1 FOR UPDATE', [userId]);
    if (cur.status === status) return false;
    await c.q('UPDATE desk.status_log SET ended_at = $2 WHERE user_id = $1 AND ended_at IS NULL', [userId, at]);
    await c.q(
      'INSERT INTO desk.status_log (user_id, status, reason, started_at) VALUES ($1, $2, $3, $4)',
      [userId, status, reason, at],
    );
    await c.q(
      'UPDATE desk.agent_state SET status = $2, status_since = $3, status_reason = $4 WHERE user_id = $1',
      [userId, status, at, reason],
    );
    fx.user(userId);
    return true;
  }

  // ---------------------------------------------------------------------------
  // Moving chats
  // ---------------------------------------------------------------------------

  async function endSegment(c, convId, at, reason) {
    await c.q(
      `UPDATE desk.assignments SET ended_at = $2, end_reason = $3
        WHERE conversation_id = $1 AND ended_at IS NULL`,
      [convId, at, reason],
    );
  }

  async function cancelPendingTransfer(c, fx, convId, at) {
    const rows = await c.q(
      `UPDATE desk.transfer_requests SET status = 'cancelled', responded_at = $2
        WHERE conversation_id = $1 AND status = 'pending' RETURNING *`,
      [convId, at],
    );
    for (const r of rows) {
      fx.conv(convId, r.to_user);
      fx.toast(r.to_user, { kind: 'transfer_gone', request_id: r.id, conversation_id: convId });
    }
  }

  async function cancelRequestsTo(c, fx, userId, at) {
    const rows = await c.q(
      `UPDATE desk.transfer_requests SET status = 'cancelled', responded_at = $2
        WHERE to_user = $1 AND status = 'pending' RETURNING *`,
      [userId, at],
    );
    for (const r of rows) {
      fx.conv(r.conversation_id, r.to_user);
      fx.toast(r.from_user, {
        kind: 'transfer_answer', status: 'cancelled', request_id: r.id,
        conversation_id: r.conversation_id, to: r.to_user,
      });
    }
  }

  async function returnToQueue(c, fx, conv, reason, at, actor = null) {
    const prev = conv.assigned_to;
    await endSegment(c, conv.id, at, reason);
    await c.q(
      `UPDATE desk.conversations
          SET status = 'queued', assigned_to = NULL, assigned_at = NULL, hold_until = NULL
        WHERE id = $1`,
      [conv.id],
    );
    await cancelPendingTransfer(c, fx, conv.id, at);
    await addEvent(c, fx, { conv: conv.id, type: 'returned', user: prev, actor, data: { reason }, at });
    fx.conv(conv.id, prev);
    fx.teamChanged();
  }

  async function returnChatsOf(c, fx, userId, reason, at, { onlyAwaiting = false } = {}) {
    const rows = await c.q(
      `SELECT id, assigned_to, waiting_since FROM desk.conversations
        WHERE status = 'assigned' AND assigned_to = $1
          ${onlyAwaiting ? 'AND waiting_since IS NOT NULL' : ''}
        ORDER BY waiting_since NULLS LAST, id
        FOR UPDATE`,
      [userId],
    );
    for (const conv of rows) await returnToQueue(c, fx, conv, reason, at);
    return rows.length;
  }

  // Ready, connected, active agents with their current load.
  async function eligibleAgents(c, at, s) {
    return c.q(
      `SELECT u.id, u.full_name, COALESCE(u.max_chats, $1)::int AS cap, st.last_assigned_at,
              (SELECT count(*) FROM desk.conversations x
                WHERE x.status = 'assigned' AND x.assigned_to = u.id)::int AS load
         FROM desk.users u
         JOIN desk.agent_state st ON st.user_id = u.id
        WHERE u.is_active AND st.status = 'ready' AND st.last_seen_at >= $2`,
      [s.max_chats, new Date(at.getTime() - s.offlineAfterMs)],
    );
  }

  // Least busy first; among equals, whoever got a chat longest ago. For a chat
  // that is hopping, people who already had it in this wait come last.
  function pick(agents, { exclude = null, tried = null } = {}) {
    const open = agents.filter((a) => a.load < a.cap && a.id !== exclude);
    if (!open.length) return null;
    const fresh = tried ? open.filter((a) => !tried.has(a.id)) : open;
    const pool = fresh.length ? fresh : open;
    const t = (d) => (d ? new Date(d).getTime() : 0);
    pool.sort(
      (a, b) =>
        (fresh.length ? 0 : t(tried.get(a.id)) - t(tried.get(b.id))) ||
        a.load - b.load ||
        t(a.last_assigned_at) - t(b.last_assigned_at) ||
        a.id - b.id,
    );
    return pool[0];
  }

  async function triedInCycle(c, convId, since) {
    const rows = await c.q(
      `SELECT user_id, max(started_at) AS at FROM desk.assignments
        WHERE conversation_id = $1 AND (ended_at IS NULL OR ended_at >= $2)
        GROUP BY user_id`,
      [convId, since],
    );
    return new Map(rows.map((r) => [r.user_id, r.at]));
  }

  async function assign(c, fx, conv, agent, how, at, s, { endReason = 'reassigned', actor = null } = {}) {
    const prev = conv.assigned_to ?? null;
    if (prev) await endSegment(c, conv.id, at, endReason);
    const w = conv.waiting_since ? new Date(conv.waiting_since) : null;
    let holdUntil = null;
    let remindersDone = 0;
    if (w) {
      // The first holder keeps it until the 10-minute mark; anyone receiving it
      // later gets one hop (1 minute). Reminders already in the past are skipped.
      holdUntil = new Date(Math.max(w.getTime() + s.firstHoldMs, at.getTime() + s.hopMs));
      remindersDone = s.reminderMs.filter((m) => m <= at - w).length;
    }
    await c.q(
      `INSERT INTO desk.assignments (conversation_id, user_id, how, started_at, load_at_start, awaiting_at_start)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [conv.id, agent.id, how, at, agent.load, !!w],
    );
    await c.q(
      `UPDATE desk.conversations
          SET status = 'assigned', assigned_to = $2, assigned_at = $3, hold_until = $4,
              reminders_sent = GREATEST(reminders_sent, $5),
              transfers = (SELECT count(*) - 1 FROM desk.assignments WHERE conversation_id = $1)
        WHERE id = $1`,
      [conv.id, agent.id, at, holdUntil, remindersDone],
    );
    await c.q('UPDATE desk.agent_state SET last_assigned_at = $2 WHERE user_id = $1', [agent.id, at]);
    await cancelPendingTransfer(c, fx, conv.id, at);
    await addEvent(c, fx, {
      conv: conv.id, type: 'assigned', user: agent.id, actor, at,
      data: { how, from: prev, load: agent.load, waiting_ms: w ? at - w : null, hold_until: holdUntil },
    });
    fx.conv(conv.id, prev);
    fx.teamChanged();
    fx.toast(agent.id, {
      kind: 'assigned', conversation_id: conv.id, how, from: prev,
      urgent: !!w && at - w >= s.firstHoldMs,
      ms_left: w ? w.getTime() + s.slaMs - at.getTime() : null,
    });
    if (prev && prev !== agent.id) {
      fx.toast(prev, { kind: 'removed', conversation_id: conv.id, reason: endReason, to: agent.id });
    }
    agent.load += 1;
    agent.last_assigned_at = at;
  }

  async function extendHold(c, fx, conv, at, s) {
    await c.q('UPDATE desk.conversations SET hold_until = $2 WHERE id = $1', [
      conv.id, new Date(at.getTime() + s.hopMs),
    ]);
    const last = await c.one(
      'SELECT type FROM desk.events WHERE conversation_id = $1 ORDER BY id DESC LIMIT 1', [conv.id],
    );
    if (last?.type !== 'no_target') {
      await addEvent(c, fx, { conv: conv.id, type: 'no_target', user: conv.assigned_to, at });
    }
    fx.conv(conv.id);
  }

  // Hands out queued chats and moves chats whose holder ran out of time, most
  // urgent (longest waiting customer) first.
  async function route(c, fx, at, s, expired = []) {
    const queued = await c.q(
      `SELECT id, assigned_to, waiting_since, opened_at FROM desk.conversations
        WHERE status = 'queued' FOR UPDATE`,
    );
    if (!queued.length && !expired.length) return;
    const agents = await eligibleAgents(c, at, s);
    const items = [
      ...queued.map((r) => ({ ...r, expired: false })),
      ...expired.map((r) => ({ ...r, expired: true })),
    ].sort((a, b) => {
      const wa = a.waiting_since ? +a.waiting_since : Number.MAX_SAFE_INTEGER;
      const wb = b.waiting_since ? +b.waiting_since : Number.MAX_SAFE_INTEGER;
      return wa - wb || +a.opened_at - +b.opened_at || a.id - b.id;
    });
    for (const it of items) {
      if (!it.expired) {
        const agent = pick(agents);
        if (agent) await assign(c, fx, it, agent, 'auto', at, s);
        continue;
      }
      const tried = await triedInCycle(c, it.id, it.waiting_since);
      const agent = pick(agents, { exclude: it.assigned_to, tried });
      if (!agent) {
        await extendHold(c, fx, it, at, s);
        continue;
      }
      const from = agents.find((a) => a.id === it.assigned_to);
      await assign(c, fx, it, agent, 'sla', at, s, { endReason: 'timeout' });
      if (from) from.load -= 1;
    }
  }

  // ---------------------------------------------------------------------------
  // The clock: reminders, late flags, hops, disconnects, expired requests.
  // ---------------------------------------------------------------------------

  async function slaPass(c, fx, at, s) {
    const rows = await c.q(
      `SELECT c.id, c.assigned_to, c.waiting_since, c.hold_until, c.reminders_sent, c.breached_at,
              c.reply_pending_until, c.opened_at, c.customer_name, c.channel, c.category,
              st.status AS holder_status
         FROM desk.conversations c
         JOIN desk.agent_state st ON st.user_id = c.assigned_to
        WHERE c.status = 'assigned' AND c.waiting_since IS NOT NULL
        ORDER BY c.waiting_since
          FOR UPDATE OF c`,
    );
    const expired = [];
    for (const r of rows) {
      const w = new Date(r.waiting_since);
      const elapsed = at - w;
      if (r.holder_status === 'offline') {
        await returnToQueue(c, fx, r, 'offline', at);
        continue;
      }
      const due = s.reminderMs.filter((m) => m <= elapsed).length;
      if (due > r.reminders_sent) {
        if (!r.hold_until || at < r.hold_until) {
          fx.toast(r.assigned_to, {
            kind: 'reminder', conversation_id: r.id, customer_name: r.customer_name,
            channel: r.channel, number: due, waited_ms: elapsed,
            ms_left: w.getTime() + s.slaMs - at.getTime(),
            ms_to_move: r.hold_until ? new Date(r.hold_until) - at : null,
          });
          await addEvent(c, fx, {
            conv: r.id, type: 'reminder', user: r.assigned_to, at, data: { number: due, waited_ms: elapsed },
          });
        }
        await c.q('UPDATE desk.conversations SET reminders_sent = $2 WHERE id = $1', [r.id, due]);
        fx.conv(r.id);
      }
      if (!r.breached_at && elapsed >= s.slaMs) {
        await c.q(
          'UPDATE desk.conversations SET breached_at = $2, late_cycles = late_cycles + 1 WHERE id = $1',
          [r.id, new Date(w.getTime() + s.slaMs)],
        );
        await addEvent(c, fx, { conv: r.id, type: 'late', user: r.assigned_to, at, data: { waited_ms: elapsed } });
        fx.toast(r.assigned_to, { kind: 'late', conversation_id: r.id, customer_name: r.customer_name });
        fx.supervisors({
          kind: 'late', conversation_id: r.id, customer_name: r.customer_name,
          channel: r.channel, holder: r.assigned_to,
        });
        fx.conv(r.id);
      }
      const replying = r.reply_pending_until && at < new Date(r.reply_pending_until);
      if (r.hold_until && at >= new Date(r.hold_until) && !replying) expired.push(r);
    }
    return expired;
  }

  async function sweepPresence(c, fx, at, s) {
    // No heartbeat for offline_after_seconds: the browser closed or the network
    // dropped. Their waiting customers go to someone who can answer.
    const stale = await c.q(
      `SELECT user_id, status_since, last_seen_at FROM desk.agent_state
        WHERE status <> 'offline' AND (last_seen_at IS NULL OR last_seen_at < $1)
          FOR UPDATE`,
      [new Date(at.getTime() - s.offlineAfterMs)],
    );
    for (const st of stale) {
      await setStatusTx(c, fx, st.user_id, 'offline', 'disconnected', at);
      await returnChatsOf(c, fx, st.user_id, 'offline', at, { onlyAwaiting: true });
      await cancelRequestsTo(c, fx, st.user_id, at);
    }
    // Gone for auto_checkout_minutes, or the shift ran past its limit: check out.
    const sessions = await c.q(
      `SELECT id, user_id, last_seen_at, checked_in_at FROM desk.sessions
        WHERE checked_out_at IS NULL AND (last_seen_at < $1 OR checked_in_at < $2)
          FOR UPDATE`,
      [new Date(at.getTime() - s.autoCheckoutMs), new Date(at.getTime() - SESSION_MAX_MS)],
    );
    for (const sess of sessions) {
      const timedOut = new Date(sess.last_seen_at) < new Date(at.getTime() - s.autoCheckoutMs);
      await c.q(
        'UPDATE desk.sessions SET checked_out_at = $2, checkout_reason = $3 WHERE id = $1',
        [sess.id, timedOut ? sess.last_seen_at : at, timedOut ? 'timeout' : 'expired'],
      );
      await setStatusTx(c, fx, sess.user_id, 'offline', 'checked_out', at);
      await returnChatsOf(c, fx, sess.user_id, 'logout', at);
      await cancelRequestsTo(c, fx, sess.user_id, at);
      fx.endSession(sess.id, timedOut ? 'timeout' : 'expired');
    }
  }

  async function expireTransfers(c, fx, at) {
    const rows = await c.q(
      `UPDATE desk.transfer_requests SET status = 'expired', responded_at = $1
        WHERE status = 'pending' AND expires_at <= $1 RETURNING *`,
      [at],
    );
    for (const r of rows) {
      await addEvent(c, fx, {
        conv: r.conversation_id, type: 'transfer_expired', user: r.to_user, at,
        data: { from: r.from_user, to: r.to_user },
      });
      fx.conv(r.conversation_id, r.to_user);
      fx.toast(r.from_user, {
        kind: 'transfer_answer', status: 'expired', request_id: r.id,
        conversation_id: r.conversation_id, to: r.to_user,
      });
      fx.toast(r.to_user, { kind: 'transfer_gone', request_id: r.id, conversation_id: r.conversation_id });
    }
  }

  async function tick() {
    const at = now();
    const s = await settings.get();
    const fx = new Effects();
    await db.tx(async (c) => {
      await lock(c);
      await sweepPresence(c, fx, at, s);
      await expireTransfers(c, fx, at);
      const expired = await slaPass(c, fx, at, s);
      await route(c, fx, at, s, expired);
    });
    await dispatch(fx);
    return fx;
  }

  // ---------------------------------------------------------------------------
  // Telling the dashboards
  // ---------------------------------------------------------------------------

  async function dispatch(fx) {
    if (!hub || fx.empty) return;
    try {
      const s = await settings.get();
      const convs = await convSummaries(db, [...fx.convIds]);
      const byId = new Map(convs.map((x) => [x.id, x]));
      for (const conv of convs) {
        const to = new Set(fx.lostBy.get(conv.id) || []);
        if (conv.assigned_to) to.add(conv.assigned_to);
        if (conv.transfer) to.add(conv.transfer.to);
        hub.conv(conv, to);
      }
      for (const m of fx.messages) hub.message(m, byId.get(Number(m.conversation_id)));
      for (const n of fx.notes) hub.note(n, byId.get(Number(n.conversation_id)));
      if (fx.team) hub.team(await teamSnapshot(db, s));
      for (const uid of fx.users) hub.me(uid, await agentState(db, uid));
      for (const t of fx.toasts) {
        if (t.role) hub.toSupervisors({ t: 'toast', toast: t.payload });
        else hub.toUser(t.userId, { t: 'toast', toast: t.payload });
      }
      for (const e of fx.endSessions) hub.endSession(e.sessionId, e.reason);
    } catch (err) {
      log.error?.('[dispatch]', err);
    }
  }

  // ---------------------------------------------------------------------------
  // Sessions
  // ---------------------------------------------------------------------------

  async function login({ username, password, ip = null, userAgent = null }) {
    const uname = cleanText(username, 80);
    if (!uname || !password) throw badRequest('Enter your username and password.');
    const user = await db.one('SELECT * FROM desk.users WHERE lower(username) = lower($1)', [uname]);
    const ok = await verifyPassword(String(password), user?.password_hash);
    if (!user || !ok) throw new HttpError(401, 'Wrong username or password.');
    if (!user.is_active) throw forbidden('This account is switched off. Ask your supervisor.');
    const token = newToken();
    const at = now();
    const fx = new Effects();
    const session = await db.tx(async (c) => {
      await lock(c);
      const old = await c.q(
        `UPDATE desk.sessions SET checked_out_at = $2, checkout_reason = 'replaced'
          WHERE user_id = $1 AND checked_out_at IS NULL RETURNING id`,
        [user.id, at],
      );
      for (const o of old) fx.endSession(o.id, 'replaced');
      const sess = await c.one(
        `INSERT INTO desk.sessions (id, user_id, token_hash, checked_in_at, last_seen_at, ip, user_agent)
         VALUES ($1, $2, $3, $4, $4, $5, $6) RETURNING id, checked_in_at`,
        [randomUUID(), user.id, hashToken(token), at, cleanText(ip, 64) || null, cleanText(userAgent, 300) || null],
      );
      await ensureState(c, user.id, at);
      await c.q('UPDATE desk.agent_state SET last_seen_at = $2 WHERE user_id = $1', [user.id, at]);
      // Everyone starts Not ready: chats only arrive after pressing Ready.
      const st = await agentState(c, user.id);
      if (st.status === 'offline') await setStatusTx(c, fx, user.id, 'not_ready', 'checked_in', at);
      return sess;
    });
    await dispatch(fx);
    return { token, user: publicUser(user), session };
  }

  async function authenticate(token) {
    if (!token || typeof token !== 'string' || token.length > 200) return null;
    const row = await db.one(
      `SELECT s.id AS session_id, s.checked_in_at, s.checked_out_at, u.*
         FROM desk.sessions s JOIN desk.users u ON u.id = s.user_id
        WHERE s.token_hash = $1`,
      [hashToken(token)],
    );
    if (!row || row.checked_out_at || !row.is_active) return null;
    return { user: row, session: { id: row.session_id, checked_in_at: row.checked_in_at } };
  }

  async function touch(auth) {
    const at = now();
    await db.q('UPDATE desk.sessions SET last_seen_at = $2 WHERE id = $1 AND checked_out_at IS NULL', [
      auth.session.id, at,
    ]);
    await db.q('UPDATE desk.agent_state SET last_seen_at = $2 WHERE user_id = $1', [auth.user.id, at]);
  }

  // A dashboard (re)connected. Someone dropped by the network comes back as
  // Not ready, so chats never land on a person who has not noticed yet.
  async function connected(auth) {
    const at = now();
    const fx = new Effects();
    await db.tx(async (c) => {
      await lock(c);
      await ensureState(c, auth.user.id, at);
      await c.q('UPDATE desk.agent_state SET last_seen_at = $2 WHERE user_id = $1', [auth.user.id, at]);
      await c.q('UPDATE desk.sessions SET last_seen_at = $2 WHERE id = $1', [auth.session.id, at]);
      const st = await agentState(c, auth.user.id);
      if (st.status === 'offline') await setStatusTx(c, fx, auth.user.id, 'not_ready', 'reconnected', at);
    });
    await dispatch(fx);
  }

  async function logout(auth) {
    const at = now();
    const s = await settings.get();
    const fx = new Effects();
    await db.tx(async (c) => {
      await lock(c);
      await c.q(
        `UPDATE desk.sessions SET checked_out_at = $2, checkout_reason = 'logout'
          WHERE id = $1 AND checked_out_at IS NULL`,
        [auth.session.id, at],
      );
      await setStatusTx(c, fx, auth.user.id, 'offline', 'checked_out', at);
      await returnChatsOf(c, fx, auth.user.id, 'logout', at);
      await cancelRequestsTo(c, fx, auth.user.id, at);
      await route(c, fx, at, s);
    });
    fx.endSession(auth.session.id, 'logout');
    await dispatch(fx);
  }

  async function setStatus(auth, status) {
    if (!['ready', 'not_ready'].includes(status)) throw badRequest('Status must be ready or not_ready.');
    const at = now();
    const s = await settings.get();
    const fx = new Effects();
    await db.tx(async (c) => {
      await lock(c);
      await ensureState(c, auth.user.id, at);
      await c.q('UPDATE desk.agent_state SET last_seen_at = $2 WHERE user_id = $1', [auth.user.id, at]);
      await c.q('UPDATE desk.sessions SET last_seen_at = $2 WHERE id = $1', [auth.session.id, at]);
      await setStatusTx(c, fx, auth.user.id, status, 'manual', at);
      if (status === 'ready') await route(c, fx, at, s);
    });
    await dispatch(fx);
    return agentState(db, auth.user.id);
  }

  async function me(auth) {
    const s = await settings.get();
    const at = now();
    const [state, today] = await Promise.all([
      agentState(db, auth.user.id),
      agentDayStats(db, { userIds: [auth.user.id], at, s }),
    ]);
    return {
      user: publicUser(auth.user),
      session: auth.session,
      state,
      today: today[0] ?? null,
      settings: publicSettings(s),
      server_time: at,
    };
  }

  // ---------------------------------------------------------------------------
  // From n8n
  // ---------------------------------------------------------------------------

  async function findOpen(c, p) {
    return c.one(
      `SELECT * FROM desk.conversations
        WHERE status <> 'closed' AND channel = $1
          AND (external_id = $2 OR ($3::text IS NOT NULL AND customer_ref = $3))
        ORDER BY (external_id = $2) DESC, opened_at DESC
        LIMIT 1
          FOR UPDATE`,
      [p.channel, p.external_id, p.customer_ref],
    );
  }

  async function countContact(p, at, s) {
    await db.q(
      `INSERT INTO desk.contacts_daily (day, channel, external_id, first_at)
       VALUES (($1::timestamptz AT TIME ZONE $4)::date, $2, $3, $1)
       ON CONFLICT (day, channel, external_id)
       DO UPDATE SET messages = desk.contacts_daily.messages + 1`,
      [at, p.channel, p.external_id, s.timezone],
    );
  }

  // The AI decided a human should take over (sales, complaint, follow-up...).
  async function ingestHandoff(body) {
    const p = parseCustomer(body || {});
    const category = normalizeCategory(body.category) ?? 'inquiry';
    const summary = cleanText(body.summary, 2000) || null;
    const at = now();
    const s = await settings.get();
    const fx = new Effects();
    const history = normalizeHistory(body.history, at);
    const result = await db.tx(async (c) => {
      await lock(c);
      const existing = await findOpen(c, p);
      if (existing) {
        // Already with the team. Refresh what the AI knows, but never undo a
        // category a human corrected.
        await c.q(
          `UPDATE desk.conversations
              SET summary = COALESCE($2, summary),
                  category = CASE WHEN category = ai_category THEN $3 ELSE category END,
                  ai_category = $3,
                  customer_name = COALESCE(customer_name, $4),
                  customer_phone = COALESCE(customer_phone, $5),
                  customer_ref = COALESCE(customer_ref, $6)
            WHERE id = $1`,
          [existing.id, summary, category, p.name, p.phone, p.customer_ref],
        );
        fx.conv(existing.id);
        return { conversation_id: existing.id, created: false };
      }
      const conv = await c.one(
        `INSERT INTO desk.conversations
           (channel, external_id, customer_ref, customer_name, customer_phone, category, ai_category,
            summary, status, opened_at, waiting_since, last_message_at, last_customer_at, last_preview, unread)
         VALUES ($1, $2, $3, $4, $5, $6, $6, $7, 'queued', $8, $8, $8, $8, $9, 1)
         RETURNING *`,
        [p.channel, p.external_id, p.customer_ref, p.name, p.phone, category, summary, at,
          previewOf(history.at(-1)?.body ?? summary ?? '')],
      );
      for (const h of history) {
        await c.q(
          'INSERT INTO desk.messages (conversation_id, sender, body, created_at) VALUES ($1, $2, $3, $4)',
          [conv.id, h.sender, h.body, h.at],
        );
      }
      let trailing = 0;
      for (let i = history.length - 1; i >= 0 && history[i].sender === 'customer'; i--) trailing++;
      if (trailing > 1) await c.q('UPDATE desk.conversations SET unread = $2 WHERE id = $1', [conv.id, trailing]);
      await addEvent(c, fx, { conv: conv.id, type: 'opened', at, data: { category, summary, by: 'ai' } });
      fx.conv(conv.id);
      await route(c, fx, at, s);
      return { conversation_id: conv.id, created: true };
    });
    await dispatch(fx);
    // Lets the AI tell the customer the truth: "a colleague is with you now",
    // "you are 4th in line", or "the team is back at 10:00".
    const avail = await db.one(
      `SELECT (SELECT count(*) FROM desk.agent_state st JOIN desk.users u ON u.id = st.user_id
                WHERE u.is_active AND st.status = 'ready' AND st.last_seen_at >= $2)::int AS agents_ready,
              (SELECT status FROM desk.conversations WHERE id = $1) AS status,
              (SELECT count(*) FROM desk.conversations q, desk.conversations me
                WHERE me.id = $1 AND q.status = 'queued' AND me.status = 'queued'
                  AND q.waiting_since <= me.waiting_since)::int AS position`,
      [result.conversation_id, new Date(at.getTime() - s.offlineAfterMs)],
    );
    return {
      ok: true,
      human_active: true,
      ...result,
      assigned: avail.status === 'assigned',
      agents_ready: avail.agents_ready,
      queue_position: avail.status === 'queued' ? avail.position : 0,
    };
  }

  // Every customer message n8n receives. If a human has this customer, the
  // message is added to the chat and n8n is told to keep the AI quiet.
  async function ingestMessage(body) {
    const p = parseCustomer(body || {});
    const text = cleanText(body.text ?? body.message, 4000);
    const sender = body.sender === 'ai' ? 'ai' : 'customer';
    const externalMsgId = cleanText(body.external_message_id ?? body.message_id, 200) || null;
    const isComment = body.kind === 'comment';
    const at = now();
    const s = await settings.get();
    if (sender === 'customer') await countContact(p, at, s);
    const fx = new Effects();
    const result = await db.tx(async (c) => {
      await lock(c);
      const conv = await findOpen(c, p);
      if (!conv) return { human_active: false };
      if (!text) return { human_active: true, conversation_id: conv.id };
      const shown = isComment ? `💬 Comment on a post: ${text}` : text;
      const msg = await c.one(
        `INSERT INTO desk.messages (conversation_id, sender, body, external_id, created_at)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (conversation_id, external_id) WHERE external_id IS NOT NULL AND sender = 'customer'
         DO NOTHING RETURNING *`,
        [conv.id, sender, shown, sender === 'customer' ? externalMsgId : null, at],
      );
      if (!msg) return { human_active: true, conversation_id: conv.id, duplicate: true };
      if (sender === 'customer') {
        // A new wait starts only if the last one was answered; otherwise the
        // clock keeps running from the oldest unanswered message.
        await c.q(
          `UPDATE desk.conversations
              SET last_customer_at = $2, last_message_at = $2, last_preview = $3, unread = unread + 1,
                  customer_name = COALESCE(customer_name, $4),
                  reminders_sent = CASE WHEN waiting_since IS NULL THEN 0 ELSE reminders_sent END,
                  breached_at = CASE WHEN waiting_since IS NULL THEN NULL ELSE breached_at END,
                  hold_until = CASE WHEN waiting_since IS NULL AND status = 'assigned' THEN $5 ELSE hold_until END,
                  waiting_since = COALESCE(waiting_since, $2)
            WHERE id = $1`,
          [conv.id, at, previewOf(shown), p.name, new Date(at.getTime() + s.firstHoldMs)],
        );
      } else {
        await c.q('UPDATE desk.conversations SET last_message_at = $2, last_preview = $3 WHERE id = $1', [
          conv.id, at, previewOf(shown),
        ]);
      }
      fx.conv(conv.id);
      fx.message(msg);
      if (conv.status === 'queued' && sender === 'customer') await route(c, fx, at, s);
      return { human_active: true, conversation_id: conv.id };
    });
    await dispatch(fx);
    return { ok: true, ...result };
  }

  // ---------------------------------------------------------------------------
  // Replying
  // ---------------------------------------------------------------------------

  const chains = new Map();
  // Replies to one customer leave in the order they were written.
  function serial(key, fn) {
    const run = (chains.get(key) || Promise.resolve()).then(fn, fn);
    const tail = run.catch(() => {});
    chains.set(key, tail);
    tail.then(() => {
      if (chains.get(key) === tail) chains.delete(key);
    });
    return run;
  }

  async function movedError(c, conv) {
    if (conv.status === 'queued') return conflict('This chat went back to the team queue.', { moved: true });
    const holder = await c.one('SELECT full_name FROM desk.users WHERE id = $1', [conv.assigned_to]);
    return conflict(`This chat is now with ${holder?.full_name ?? 'a teammate'}.`, {
      moved: true, holder: conv.assigned_to,
    });
  }

  async function sendReply(auth, convId, rawText) {
    const text = cleanText(rawText, 4000);
    if (!text) throw badRequest('Type a message first.');
    const at = now();
    const fx = new Effects();
    const { msg, conv } = await db.tx(async (c) => {
      await lock(c);
      const conv = await c.one('SELECT * FROM desk.conversations WHERE id = $1 FOR UPDATE', [convId]);
      if (!conv) throw notFound('This chat no longer exists.');
      if (conv.status === 'closed') throw conflict('This chat is already resolved.');
      if (!isSupervisor(auth.user) && conv.assigned_to !== auth.user.id) throw await movedError(c, conv);
      const limit = MESSAGE_LIMITS[conv.channel];
      if (text.length > limit) {
        throw badRequest(`${CHANNEL_LABEL[conv.channel]} messages can be up to ${limit} characters. Split it into two messages.`);
      }
      const msg = await c.one(
        `INSERT INTO desk.messages (conversation_id, sender, user_id, body, delivery, created_at)
         VALUES ($1, 'agent', $2, $3, 'pending', $4) RETURNING *`,
        [conv.id, auth.user.id, text, at],
      );
      await c.q(
        `UPDATE desk.conversations SET reply_pending_until = $2, last_message_at = $3, last_preview = $4
          WHERE id = $1`,
        [conv.id, new Date(at.getTime() + REPLY_GUARD_MS), at, previewOf(text)],
      );
      fx.conv(conv.id);
      fx.message({ ...msg, author_name: auth.user.full_name });
      return { msg, conv };
    });
    await dispatch(fx);
    const delivery = serial(conv.id, () => deliver(msg, conv, auth.user));
    delivery.catch((err) => log.error?.('[deliver]', err));
    return { message: { ...msg, author_name: auth.user.full_name }, delivery };
  }

  async function retryMessage(auth, msgId) {
    const at = now();
    const fx = new Effects();
    const { msg, conv } = await db.tx(async (c) => {
      await lock(c);
      const msg = await c.one(`SELECT * FROM desk.messages WHERE id = $1 FOR UPDATE`, [msgId]);
      if (!msg || msg.sender !== 'agent') throw notFound('Message not found.');
      if (msg.delivery !== 'failed') throw conflict('This message is not failed.');
      const conv = await c.one('SELECT * FROM desk.conversations WHERE id = $1 FOR UPDATE', [msg.conversation_id]);
      if (conv.status === 'closed') throw conflict('This chat is already resolved.');
      if (!isSupervisor(auth.user) && conv.assigned_to !== auth.user.id) throw await movedError(c, conv);
      // A retry is a new attempt at a new moment; the SLA counts from now.
      const fresh = await c.one(
        `UPDATE desk.messages SET delivery = 'pending', error = NULL, created_at = $2, user_id = $3
          WHERE id = $1 RETURNING *`,
        [msg.id, at, auth.user.id],
      );
      await c.q('UPDATE desk.conversations SET reply_pending_until = $2 WHERE id = $1', [
        conv.id, new Date(at.getTime() + REPLY_GUARD_MS),
      ]);
      fx.conv(conv.id);
      fx.message(fresh);
      return { msg: fresh, conv };
    });
    await dispatch(fx);
    const delivery = serial(conv.id, () => deliver(msg, conv, auth.user));
    delivery.catch((err) => log.error?.('[deliver]', err));
    return { message: msg, delivery };
  }

  async function deliver(msg, conv, user) {
    let res;
    try {
      res = await outbound.send({
        message_id: msg.id,
        conversation_id: conv.id,
        channel: conv.channel,
        external_id: conv.external_id,
        phone: conv.customer_phone,
        customer_ref: conv.customer_ref,
        customer_name: conv.customer_name,
        text: msg.body,
        agent: { id: user.id, name: user.full_name, employee_id: user.employee_id },
      });
    } catch (err) {
      res = { ok: false, error: err.message };
    }
    await applyDelivery(msg.id, res);
    return res;
  }

  async function applyDelivery(msgId, res) {
    const s = await settings.get();
    const fx = new Effects();
    await db.tx(async (c) => {
      await lock(c);
      const m = await c.one(
        `UPDATE desk.messages
            SET delivery = $2, external_id = COALESCE($3, external_id), error = $4
          WHERE id = $1 AND delivery = 'pending' RETURNING *`,
        [
          msgId,
          res.ok ? 'sent' : 'failed',
          res.ok ? cleanText(res.external_id, 200) || null : null,
          res.ok ? null : cleanText(res.error, 300) || 'Not delivered',
        ],
      );
      if (!m) return;
      const conv = await c.one('SELECT * FROM desk.conversations WHERE id = $1 FOR UPDATE', [m.conversation_id]);
      const stillPending = await c.one(
        `SELECT 1 AS x FROM desk.messages WHERE conversation_id = $1 AND delivery = 'pending' LIMIT 1`,
        [conv.id],
      );
      if (!stillPending) {
        await c.q('UPDATE desk.conversations SET reply_pending_until = NULL WHERE id = $1', [conv.id]);
      }
      if (res.ok) {
        await applyReply(c, fx, conv, m, s);
      } else {
        await addEvent(c, fx, {
          conv: conv.id, type: 'send_failed', user: m.user_id, at: now(), data: { message_id: m.id, error: m.error },
        });
        fx.toast(m.user_id, { kind: 'send_failed', conversation_id: conv.id, message_id: m.id, error: m.error });
      }
      fx.conv(conv.id);
      fx.message(m);
    });
    await dispatch(fx);
  }

  // A reply reached the customer. The SLA is measured to the moment the agent
  // pressed Send, not to when WhatsApp or Meta confirmed it.
  async function applyReply(c, fx, conv, m, s) {
    const at = new Date(m.created_at);
    if (conv.waiting_since && new Date(conv.waiting_since) <= at) {
      const waitMs = at - new Date(conv.waiting_since);
      await addEvent(c, fx, {
        conv: conv.id, type: 'replied', user: m.user_id, actor: m.user_id, at,
        data: {
          wait_ms: waitMs, late_ms: Math.max(0, waitMs - s.slaMs), first: !conv.first_reply_at,
          holder: conv.assigned_to, message_id: m.id,
        },
      });
      // A reply that lands past the SLA between two engine ticks is still a late wait.
      const lateUncounted = waitMs > s.slaMs && !conv.breached_at;
      await c.q(
        `UPDATE desk.conversations
            SET waiting_since = NULL, hold_until = NULL, reminders_sent = 0, breached_at = NULL,
                late_cycles = late_cycles + $2
          WHERE id = $1`,
        [conv.id, lateUncounted ? 1 : 0],
      );
    }
    await c.q(
      `UPDATE desk.assignments SET first_reply_at = COALESCE(first_reply_at, $2)
        WHERE conversation_id = $1 AND ended_at IS NULL AND user_id = $3`,
      [conv.id, at, m.user_id],
    );
    await c.q(
      `UPDATE desk.conversations
          SET last_agent_at = GREATEST(COALESCE(last_agent_at, $2), $2),
              first_reply_at = COALESCE(first_reply_at, $2),
              first_reply_by = COALESCE(first_reply_by, $3),
              unread = CASE WHEN assigned_to = $3 THEN 0 ELSE unread END
        WHERE id = $1`,
      [conv.id, at, m.user_id],
    );
    fx.teamChanged();
  }

  // ---------------------------------------------------------------------------
  // Working a chat
  // ---------------------------------------------------------------------------

  // The chat, locked, if this person may act on it: its holder or a supervisor.
  async function lockedConv(c, auth, convId) {
    const conv = await c.one('SELECT * FROM desk.conversations WHERE id = $1 FOR UPDATE', [convId]);
    if (!conv) throw notFound('This chat no longer exists.');
    if (isSupervisor(auth.user) || conv.assigned_to === auth.user.id) return conv;
    if (conv.status === 'closed') throw forbidden('This chat is resolved.');
    throw await movedError(c, conv);
  }

  async function markRead(auth, convId) {
    const row = await db.one(
      `UPDATE desk.conversations SET unread = 0
        WHERE id = $1 AND assigned_to = $2 AND unread > 0 RETURNING id`,
      [convId, auth.user.id],
    );
    if (row) {
      const fx = new Effects();
      fx.conv(convId);
      await dispatch(fx);
    }
  }

  async function setCategory(auth, convId, category) {
    const cat = normalizeCategory(category);
    if (!cat) throw badRequest('Category must be inquiry, sales, complaint or followup.');
    const at = now();
    const fx = new Effects();
    await db.tx(async (c) => {
      await lock(c);
      const conv = await lockedConv(c, auth, convId);
      if (conv.category === cat) return;
      await c.q('UPDATE desk.conversations SET category = $2 WHERE id = $1', [conv.id, cat]);
      await addEvent(c, fx, {
        conv: conv.id, type: 'category', actor: auth.user.id, at, data: { from: conv.category, to: cat },
      });
      fx.conv(conv.id);
    });
    await dispatch(fx);
  }

  async function close(auth, convId, note) {
    const at = now();
    const s = await settings.get();
    const fx = new Effects();
    await db.tx(async (c) => {
      await lock(c);
      const conv = await lockedConv(c, auth, convId);
      if (conv.status === 'closed') return;
      await endSegment(c, conv.id, at, 'closed');
      await cancelPendingTransfer(c, fx, conv.id, at);
      await c.q(
        `UPDATE desk.conversations
            SET status = 'closed', closed_at = $2, closed_by = $3, close_note = $4,
                hold_until = NULL, waiting_since = NULL, reply_pending_until = NULL, unread = 0
          WHERE id = $1`,
        [conv.id, at, auth.user.id, cleanText(note, 500) || null],
      );
      await addEvent(c, fx, {
        conv: conv.id, type: 'closed', user: conv.assigned_to, actor: auth.user.id, at,
        data: { unanswered: !!conv.waiting_since, note: cleanText(note, 500) || null },
      });
      fx.conv(conv.id, conv.assigned_to);
      fx.teamChanged();
      await route(c, fx, at, s);
    });
    await dispatch(fx);
  }

  // ---------------------------------------------------------------------------
  // Asking a teammate for help
  // ---------------------------------------------------------------------------

  async function requestTransfer(auth, convId, toUserId, note) {
    const at = now();
    const s = await settings.get();
    const fx = new Effects();
    const req = await db.tx(async (c) => {
      await lock(c);
      const conv = await c.one('SELECT * FROM desk.conversations WHERE id = $1 FOR UPDATE', [convId]);
      if (!conv || conv.status === 'closed') throw notFound('This chat is not open any more.');
      if (conv.assigned_to !== auth.user.id) throw await movedError(c, conv);
      const target = Number(toUserId);
      if (!Number.isInteger(target)) throw badRequest('Pick a teammate.');
      if (target === auth.user.id) throw badRequest('Pick a teammate, not yourself.');
      const t = await c.one(
        `SELECT u.id, u.full_name, u.is_active, COALESCE(u.max_chats, $2)::int AS cap,
                st.status, st.last_seen_at,
                (SELECT count(*) FROM desk.conversations x
                  WHERE x.status = 'assigned' AND x.assigned_to = u.id)::int AS load
           FROM desk.users u LEFT JOIN desk.agent_state st ON st.user_id = u.id
          WHERE u.id = $1`,
        [target, s.max_chats],
      );
      if (!t || !t.is_active) throw notFound('That teammate was not found.');
      const online = t.last_seen_at && at - new Date(t.last_seen_at) <= s.offlineAfterMs;
      if (t.status !== 'ready' || !online) throw conflict(`${t.full_name} is not Ready right now.`);
      if (t.load >= t.cap) throw conflict(`${t.full_name} is full (${t.load}/${t.cap}).`);
      const pending = await c.one(
        `SELECT u.full_name FROM desk.transfer_requests tr JOIN desk.users u ON u.id = tr.to_user
          WHERE tr.conversation_id = $1 AND tr.status = 'pending'`,
        [conv.id],
      );
      if (pending) throw conflict(`Still waiting for ${pending.full_name} to answer.`);
      const req = await c.one(
        `INSERT INTO desk.transfer_requests (conversation_id, from_user, to_user, note, created_at, expires_at)
         VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
        [conv.id, auth.user.id, target, cleanText(note, 300) || null, at, new Date(at.getTime() + s.transferTimeoutMs)],
      );
      await addEvent(c, fx, {
        conv: conv.id, type: 'transfer_requested', user: target, actor: auth.user.id, at,
        data: { to: target, note: req.note },
      });
      fx.conv(conv.id);
      fx.toast(target, {
        kind: 'transfer_request', request_id: req.id, conversation_id: conv.id,
        from: auth.user.id, from_name: auth.user.full_name, note: req.note, expires_at: req.expires_at,
      });
      return req;
    });
    await dispatch(fx);
    return req;
  }

  async function respondTransfer(auth, reqId, accept) {
    const at = now();
    const s = await settings.get();
    const fx = new Effects();
    const outcome = await db.tx(async (c) => {
      await lock(c);
      const r = await c.one('SELECT * FROM desk.transfer_requests WHERE id = $1 FOR UPDATE', [reqId]);
      if (!r || r.to_user !== auth.user.id) throw notFound('This request was not found.');
      if (r.status !== 'pending') return { gone: r.status };
      if (new Date(r.expires_at) <= at) {
        await c.q(`UPDATE desk.transfer_requests SET status = 'expired', responded_at = $2 WHERE id = $1`, [r.id, at]);
        await addEvent(c, fx, {
          conv: r.conversation_id, type: 'transfer_expired', user: r.to_user, at, data: { from: r.from_user, to: r.to_user },
        });
        fx.conv(r.conversation_id, r.to_user);
        fx.toast(r.from_user, {
          kind: 'transfer_answer', status: 'expired', request_id: r.id, conversation_id: r.conversation_id, to: r.to_user,
        });
        return { gone: 'expired' };
      }
      const conv = await c.one('SELECT * FROM desk.conversations WHERE id = $1 FOR UPDATE', [r.conversation_id]);
      if (conv.status !== 'assigned' || conv.assigned_to !== r.from_user) {
        await c.q(`UPDATE desk.transfer_requests SET status = 'cancelled', responded_at = $2 WHERE id = $1`, [r.id, at]);
        fx.conv(conv.id, r.to_user);
        return { gone: 'moved' };
      }
      if (!accept) {
        await c.q(`UPDATE desk.transfer_requests SET status = 'declined', responded_at = $2 WHERE id = $1`, [r.id, at]);
        await addEvent(c, fx, {
          conv: conv.id, type: 'transfer_declined', user: r.to_user, actor: auth.user.id, at,
          data: { from: r.from_user, to: r.to_user },
        });
        fx.conv(conv.id, r.to_user);
        fx.toast(r.from_user, {
          kind: 'transfer_answer', status: 'declined', request_id: r.id, conversation_id: conv.id,
          to: r.to_user, to_name: auth.user.full_name,
        });
        return { status: 'declined' };
      }
      const mine = await c.one(
        `SELECT COALESCE(u.max_chats, $2)::int AS cap,
                (SELECT count(*) FROM desk.conversations x WHERE x.status = 'assigned' AND x.assigned_to = u.id)::int AS load
           FROM desk.users u WHERE u.id = $1`,
        [auth.user.id, s.max_chats],
      );
      if (mine.load >= mine.cap) throw conflict(`You already have ${mine.load}/${mine.cap} chats.`);
      await c.q(`UPDATE desk.transfer_requests SET status = 'accepted', responded_at = $2 WHERE id = $1`, [r.id, at]);
      await assign(c, fx, conv, { id: auth.user.id, load: mine.load }, 'transfer', at, s, {
        endReason: 'transferred', actor: auth.user.id,
      });
      await addEvent(c, fx, {
        conv: conv.id, type: 'transfer_accepted', user: r.to_user, actor: auth.user.id, at,
        data: { from: r.from_user, to: r.to_user },
      });
      fx.toast(r.from_user, {
        kind: 'transfer_answer', status: 'accepted', request_id: r.id, conversation_id: conv.id,
        to: r.to_user, to_name: auth.user.full_name,
      });
      return { status: 'accepted', conversation_id: conv.id };
    });
    await dispatch(fx);
    if (outcome.gone === 'expired') throw conflict('This request expired.');
    if (outcome.gone === 'moved') throw conflict('That chat has already moved on.');
    if (outcome.gone) throw conflict('This request was already answered or withdrawn.');
    return outcome;
  }

  async function cancelTransfer(auth, reqId) {
    const at = now();
    const fx = new Effects();
    await db.tx(async (c) => {
      await lock(c);
      const r = await c.one('SELECT * FROM desk.transfer_requests WHERE id = $1 FOR UPDATE', [reqId]);
      if (!r || (r.from_user !== auth.user.id && !isSupervisor(auth.user))) throw notFound('Request not found.');
      if (r.status !== 'pending') return;
      await c.q(`UPDATE desk.transfer_requests SET status = 'cancelled', responded_at = $2 WHERE id = $1`, [r.id, at]);
      await addEvent(c, fx, {
        conv: r.conversation_id, type: 'transfer_cancelled', user: r.to_user, actor: auth.user.id, at,
        data: { from: r.from_user, to: r.to_user },
      });
      fx.conv(r.conversation_id, r.to_user);
      fx.toast(r.to_user, { kind: 'transfer_gone', request_id: r.id, conversation_id: r.conversation_id });
    });
    await dispatch(fx);
  }

  // ---------------------------------------------------------------------------
  // Supervisor actions
  // ---------------------------------------------------------------------------

  async function supervisorAssign(auth, convId, toUserId) {
    if (!isSupervisor(auth.user)) throw forbidden();
    const at = now();
    const s = await settings.get();
    const fx = new Effects();
    await db.tx(async (c) => {
      await lock(c);
      const conv = await c.one('SELECT * FROM desk.conversations WHERE id = $1 FOR UPDATE', [convId]);
      if (!conv || conv.status === 'closed') throw notFound('This chat is not open.');
      const t = await c.one(
        `SELECT u.id, u.full_name, u.is_active, COALESCE(u.max_chats, $2)::int AS cap, st.status,
                (SELECT count(*) FROM desk.conversations x
                  WHERE x.status = 'assigned' AND x.assigned_to = u.id)::int AS load
           FROM desk.users u LEFT JOIN desk.agent_state st ON st.user_id = u.id WHERE u.id = $1`,
        [Number(toUserId), s.max_chats],
      );
      if (!t || !t.is_active) throw notFound('That agent was not found.');
      if (conv.assigned_to === t.id) return;
      if (!t.status || t.status === 'offline') throw conflict(`${t.full_name} is offline.`);
      if (t.load >= t.cap) throw conflict(`${t.full_name} is full (${t.load}/${t.cap}).`);
      await assign(c, fx, conv, t, 'manual', at, s, { endReason: 'reassigned', actor: auth.user.id });
    });
    await dispatch(fx);
  }

  async function supervisorRequeue(auth, convId) {
    if (!isSupervisor(auth.user)) throw forbidden();
    const at = now();
    const s = await settings.get();
    const fx = new Effects();
    await db.tx(async (c) => {
      await lock(c);
      const conv = await c.one('SELECT * FROM desk.conversations WHERE id = $1 FOR UPDATE', [convId]);
      if (!conv || conv.status !== 'assigned') throw conflict('Only a chat with an agent can be sent back.');
      await returnToQueue(c, fx, conv, 'supervisor', at, auth.user.id);
      await route(c, fx, at, s);
    });
    await dispatch(fx);
  }

  async function supervisorSetStatus(auth, userId, status) {
    if (!isSupervisor(auth.user)) throw forbidden();
    if (status !== 'not_ready') throw badRequest('A supervisor can only set someone to Not ready.');
    const at = now();
    const fx = new Effects();
    await db.tx(async (c) => {
      await lock(c);
      const st = await agentState(c, Number(userId));
      if (!st || st.status !== 'ready') return;
      await setStatusTx(c, fx, Number(userId), 'not_ready', `set by ${auth.user.full_name}`, at);
    });
    await dispatch(fx);
  }

  // ---------------------------------------------------------------------------
  // Typing activity — the dashboard reports it every few seconds.
  // ---------------------------------------------------------------------------

  async function recordActivity(auth, keystrokes, typingMs) {
    const k = Math.max(0, Math.min(3000, Math.round(Number(keystrokes) || 0)));
    const ms = Math.max(0, Math.min(60000, Math.round(Number(typingMs) || 0)));
    if (!k && !ms) return;
    const at = now();
    const minute = new Date(Math.floor(at.getTime() / 60000) * 60000);
    await db.q(
      `INSERT INTO desk.activity (user_id, minute, keystrokes, typing_ms) VALUES ($1, $2, $3, $4)
       ON CONFLICT (user_id, minute) DO UPDATE
         SET keystrokes = desk.activity.keystrokes + EXCLUDED.keystrokes,
             typing_ms = LEAST(60000, desk.activity.typing_ms + EXCLUDED.typing_ms)`,
      [auth.user.id, minute, k, ms],
    );
  }

  // ---------------------------------------------------------------------------
  // People
  // ---------------------------------------------------------------------------

  const ROLES = ['agent', 'supervisor', 'admin'];

  function canManage(actor, role) {
    if (actor.role === 'admin') return true;
    return actor.role === 'supervisor' && role === 'agent';
  }

  function validateUser(data, { partial = false } = {}) {
    const out = {};
    if (!partial || data.full_name !== undefined) {
      out.full_name = cleanText(data.full_name, 80);
      if (out.full_name.length < 2) throw badRequest('Enter the full name.');
    }
    if (!partial || data.username !== undefined) {
      out.username = cleanText(data.username, 40).toLowerCase();
      if (!/^[a-z0-9._-]{3,40}$/.test(out.username)) {
        throw badRequest('Username: 3–40 characters, letters, numbers, dot, dash or underscore.');
      }
    }
    if (!partial || data.employee_id !== undefined) {
      out.employee_id = cleanText(data.employee_id, 30);
      if (!out.employee_id) throw badRequest('Enter the employee ID.');
    }
    if (!partial || data.role !== undefined) {
      out.role = data.role ?? 'agent';
      if (!ROLES.includes(out.role)) throw badRequest('Role must be agent, supervisor or admin.');
    }
    if (data.max_chats !== undefined) {
      if (data.max_chats === null || data.max_chats === '') out.max_chats = null;
      else {
        const n = Number(data.max_chats);
        if (!Number.isInteger(n) || n < 1 || n > 200) throw badRequest('Max chats must be 1–200, or empty for the default.');
        out.max_chats = n;
      }
    }
    if (data.is_active !== undefined) out.is_active = !!data.is_active;
    return out;
  }

  function uniqueViolation(err) {
    if (err.code !== '23505') return err;
    if (String(err.constraint).includes('employee')) return conflict('That employee ID is already used.');
    return conflict('That username is already taken.');
  }

  async function createUser(auth, data) {
    const u = validateUser(data || {});
    if (!canManage(auth.user, u.role)) throw forbidden('Only an admin can create supervisors and admins.');
    let password = data.password ? String(data.password) : '';
    const generated = !password;
    if (generated) password = generatePassword();
    if (password.length < 8) throw badRequest('Passwords need at least 8 characters.');
    try {
      const row = await db.one(
        `INSERT INTO desk.users (employee_id, username, full_name, role, password_hash, max_chats)
         VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
        [u.employee_id, u.username, u.full_name, u.role, await hashPassword(password), u.max_chats ?? null],
      );
      await db.q(
        `INSERT INTO desk.agent_state (user_id, status, status_since) VALUES ($1, 'offline', $2)
         ON CONFLICT DO NOTHING`,
        [row.id, now()],
      );
      const fx = new Effects();
      fx.teamChanged();
      await dispatch(fx);
      return { user: publicUser(row), password: generated ? password : undefined };
    } catch (err) {
      throw uniqueViolation(err);
    }
  }

  async function updateUser(auth, userId, data) {
    const target = await db.one('SELECT * FROM desk.users WHERE id = $1', [userId]);
    if (!target) throw notFound('User not found.');
    const patch = validateUser(data || {}, { partial: true });
    if (!canManage(auth.user, target.role) || (patch.role && !canManage(auth.user, patch.role))) {
      throw forbidden('Only an admin can change supervisors and admins.');
    }
    if (target.id === auth.user.id && (patch.is_active === false || (patch.role && patch.role !== target.role))) {
      throw badRequest('You cannot switch off or demote your own account.');
    }
    let password;
    if (data.reset_password) password = data.password ? String(data.password) : generatePassword();
    if (password !== undefined && password.length < 8) throw badRequest('Passwords need at least 8 characters.');
    const sets = [];
    const vals = [target.id];
    for (const [k, v] of Object.entries(patch)) {
      vals.push(v);
      sets.push(`${k} = $${vals.length}`);
    }
    if (password !== undefined) {
      vals.push(await hashPassword(password));
      sets.push(`password_hash = $${vals.length}`);
    }
    if (!sets.length) return { user: publicUser(target) };
    sets.push('updated_at = now()');
    let row;
    try {
      row = await db.one(`UPDATE desk.users SET ${sets.join(', ')} WHERE id = $1 RETURNING *`, vals);
    } catch (err) {
      throw uniqueViolation(err);
    }
    // Switched off or password reset: end their session; their chats go back.
    if (patch.is_active === false || password !== undefined) {
      const at = now();
      const s = await settings.get();
      const fx = new Effects();
      await db.tx(async (c) => {
        await lock(c);
        const open = await c.q(
          `UPDATE desk.sessions SET checked_out_at = $2, checkout_reason = 'disabled'
            WHERE user_id = $1 AND checked_out_at IS NULL RETURNING id`,
          [target.id, at],
        );
        for (const o of open) fx.endSession(o.id, patch.is_active === false ? 'disabled' : 'password_reset');
        if (open.length || patch.is_active === false) {
          await setStatusTx(c, fx, target.id, 'offline', 'checked_out', at);
          await returnChatsOf(c, fx, target.id, 'logout', at);
          await cancelRequestsTo(c, fx, target.id, at);
          await route(c, fx, at, s);
        }
      });
      fx.teamChanged();
      await dispatch(fx);
    } else {
      const fx = new Effects();
      fx.teamChanged();
      await dispatch(fx);
    }
    return { user: publicUser(row), password: data.reset_password ? password : undefined };
  }

  async function changeOwnPassword(auth, current, next) {
    const row = await db.one('SELECT password_hash FROM desk.users WHERE id = $1', [auth.user.id]);
    if (!(await verifyPassword(String(current || ''), row.password_hash))) {
      throw badRequest('Your current password is not right.');
    }
    if (String(next || '').length < 8) throw badRequest('Passwords need at least 8 characters.');
    await db.q('UPDATE desk.users SET password_hash = $2, updated_at = now() WHERE id = $1', [
      auth.user.id, await hashPassword(String(next)),
    ]);
  }

  // ---------------------------------------------------------------------------

  let timer = null;
  let ticking = false;
  function start(intervalMs) {
    if (timer) return;
    timer = setInterval(async () => {
      if (ticking) return;
      ticking = true;
      try {
        await tick();
      } catch (err) {
        log.error?.('[tick]', err);
      } finally {
        ticking = false;
      }
    }, intervalMs);
    timer.unref?.();
  }
  function stop() {
    clearInterval(timer);
    timer = null;
  }

  return {
    // engine
    tick, start, stop, dispatch,
    // sessions
    login, authenticate, touch, connected, logout, setStatus, me,
    // n8n
    ingestHandoff, ingestMessage,
    // chats
    sendReply, retryMessage, markRead, setCategory, close,
    requestTransfer, respondTransfer, cancelTransfer,
    supervisorAssign, supervisorRequeue, supervisorSetStatus,
    recordActivity,
    // people
    createUser, updateUser, changeOwnPassword,
    convSummary: (id) => convSummary(db, id),
  };
}
