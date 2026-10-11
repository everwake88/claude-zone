// Analytics: the day report, each agent's numbers, and the busy / idle verdict
// used when a chat timed out with someone.
import { dayWindow } from './views.js';

const CATEGORIES = ['inquiry', 'sales', 'complaint', 'followup'];
const CHANNELS = ['whatsapp', 'messenger', 'instagram'];

// Was the agent busy or idle while this chat sat with them unanswered?
//   busy  — replying in other chats, or typing for a good share of the time
//   idle  — no replies anywhere and next to no typing
//   some  — in between
export function verdict(seg, s) {
  if (seg.replied) return 'replied';
  const durMs = Math.max(1000, seg.duration_ms);
  if (seg.offline_ms != null && seg.offline_ms > durMs / 2) return 'offline';
  const minutes = Math.max(1, durMs / 60000);
  const perMinute = seg.other_replies / minutes;
  const typingShare = seg.typing_ms / durMs;
  if (perMinute >= s.busy_replies_per_minute || typingShare >= s.busy_typing_share) return 'busy';
  if (seg.other_replies === 0 && typingShare < s.idle_typing_share) return 'idle';
  return 'some';
}

// The agent's typing inside [start, end), pro-rated from per-minute buckets.
export const TYPING_IN_WINDOW = (userCol, startCol, endCol) => `
  (SELECT COALESCE(sum(x.typing_ms * GREATEST(0, extract(epoch FROM
            LEAST(x.minute + interval '1 minute', ${endCol}) - GREATEST(x.minute, ${startCol}))) / 60.0), 0)
     FROM desk.activity x
    WHERE x.user_id = ${userCol}
      AND x.minute > ${startCol} - interval '1 minute' AND x.minute < ${endCol})::bigint`;

export const KEYS_IN_WINDOW = (userCol, startCol, endCol) => `
  (SELECT COALESCE(sum(x.keystrokes * GREATEST(0, extract(epoch FROM
            LEAST(x.minute + interval '1 minute', ${endCol}) - GREATEST(x.minute, ${startCol}))) / 60.0), 0)
     FROM desk.activity x
    WHERE x.user_id = ${userCol}
      AND x.minute > ${startCol} - interval '1 minute' AND x.minute < ${endCol})::bigint`;

function byUser(rows, key = 'user_id') {
  const m = new Map();
  for (const r of rows) m.set(r[key], r);
  return m;
}

// Per-agent numbers for a working day. `userIds` null = everyone.
export async function agentDayStats(db, { userIds = null, at, s, date = null, window = null }) {
  const win = window ?? (await dayWindow(db, at, s.timezone, date));
  const start = win.start;
  const end = win.end;
  const until = at < end ? at : end;
  const ids = userIds && userIds.length ? userIds : null;

  const [users, sessions, statuses, replies, waits, segs, resolved, typing, timeouts] = await Promise.all([
    db.q(
      `SELECT id, employee_id, full_name, role, is_active FROM desk.users
        WHERE ($1::int[] IS NULL OR id = ANY($1)) ORDER BY full_name`,
      [ids],
    ),
    db.q(
      `SELECT user_id,
              min(checked_in_at) AS first_in,
              max(checked_out_at) AS last_out,
              bool_or(checked_out_at IS NULL) AS still_in,
              (COALESCE(sum(GREATEST(0, extract(epoch FROM
                 LEAST(COALESCE(checked_out_at, $3), $2) - GREATEST(checked_in_at, $1)))), 0) * 1000)::bigint AS logged_ms
         FROM desk.sessions
        WHERE checked_in_at < $2 AND COALESCE(checked_out_at, $3) > $1
          AND ($4::int[] IS NULL OR user_id = ANY($4))
        GROUP BY user_id`,
      [start, end, until, ids],
    ),
    db.q(
      `SELECT user_id, status,
              (sum(GREATEST(0, extract(epoch FROM
                 LEAST(COALESCE(ended_at, $3), $2) - GREATEST(started_at, $1)))) * 1000)::bigint AS ms
         FROM desk.status_log
        WHERE started_at < $2 AND COALESCE(ended_at, $3) > $1 AND status <> 'offline'
          AND ($4::int[] IS NULL OR user_id = ANY($4))
        GROUP BY user_id, status`,
      [start, end, until, ids],
    ),
    db.q(
      `SELECT user_id, count(*)::int AS replies, count(DISTINCT conversation_id)::int AS handled,
              COALESCE(sum(length(body)), 0)::int AS chars
         FROM desk.messages
        WHERE sender = 'agent' AND delivery = 'sent' AND created_at >= $1 AND created_at < $2
          AND ($3::int[] IS NULL OR user_id = ANY($3))
        GROUP BY user_id`,
      [start, end, ids],
    ),
    db.q(
      `SELECT actor_id AS user_id, count(*)::int AS answered,
              avg((data->>'wait_ms')::numeric)::bigint AS avg_wait_ms,
              count(*) FILTER (WHERE (data->>'late_ms')::numeric > 0)::int AS late_replies,
              count(*) FILTER (WHERE (data->>'first')::boolean)::int AS first_replies,
              avg((data->>'wait_ms')::numeric) FILTER (WHERE (data->>'first')::boolean)::bigint AS avg_first_ms
         FROM desk.events
        WHERE type = 'replied' AND created_at >= $1 AND created_at < $2
          AND ($3::int[] IS NULL OR actor_id = ANY($3))
        GROUP BY actor_id`,
      [start, end, ids],
    ),
    db.q(
      `SELECT user_id,
              count(*) FILTER (WHERE started_at >= $1 AND started_at < $2)::int AS received,
              count(*) FILTER (WHERE how = 'sla' AND started_at >= $1 AND started_at < $2)::int AS rescues,
              count(*) FILTER (WHERE how = 'transfer' AND started_at >= $1 AND started_at < $2)::int AS accepted_transfers
         FROM desk.assignments
        WHERE started_at >= $1 AND started_at < $2
          AND ($3::int[] IS NULL OR user_id = ANY($3))
        GROUP BY user_id`,
      [start, end, ids],
    ),
    db.q(
      `SELECT closed_by AS user_id, count(*)::int AS resolved
         FROM desk.conversations
        WHERE closed_at >= $1 AND closed_at < $2 AND closed_by IS NOT NULL
          AND ($3::int[] IS NULL OR closed_by = ANY($3))
        GROUP BY closed_by`,
      [start, end, ids],
    ),
    db.q(
      `SELECT user_id, COALESCE(sum(typing_ms), 0)::bigint AS typing_ms,
              COALESCE(sum(keystrokes), 0)::bigint AS keystrokes
         FROM desk.activity
        WHERE minute >= $1 AND minute < $2
          AND ($3::int[] IS NULL OR user_id = ANY($3))
        GROUP BY user_id`,
      [start, end, ids],
    ),
    timeoutSegments(db, { start, end, ids }),
  ]);

  const sess = byUser(sessions);
  const rep = byUser(replies);
  const wt = byUser(waits);
  const sg = byUser(segs);
  const res = byUser(resolved);
  const ty = byUser(typing);
  const st = new Map();
  for (const r of statuses) {
    if (!st.has(r.user_id)) st.set(r.user_id, {});
    st.get(r.user_id)[r.status] = r.ms;
  }
  const to = new Map();
  for (const t of timeouts) {
    const v = verdict(t, s);
    if (!to.has(t.user_id)) to.set(t.user_id, { total: 0, busy: 0, idle: 0, some: 0, offline: 0 });
    const agg = to.get(t.user_id);
    agg.total += 1;
    agg[v] = (agg[v] ?? 0) + 1;
  }

  return users.map((u) => {
    const ss = sess.get(u.id);
    const sst = st.get(u.id) || {};
    const r = rep.get(u.id);
    const w = wt.get(u.id);
    const g = sg.get(u.id);
    const t = ty.get(u.id);
    const readyMs = sst.ready ?? 0;
    return {
      user_id: u.id,
      employee_id: u.employee_id,
      full_name: u.full_name,
      role: u.role,
      is_active: u.is_active,
      checked_in_at: ss?.first_in ?? null,
      checked_out_at: ss && !ss.still_in ? ss.last_out : null,
      online: !!ss?.still_in && until === at,
      logged_ms: ss?.logged_ms ?? 0,
      ready_ms: readyMs,
      not_ready_ms: sst.not_ready ?? 0,
      received: g?.received ?? 0,
      rescues: g?.rescues ?? 0,
      accepted_transfers: g?.accepted_transfers ?? 0,
      handled: r?.handled ?? 0,
      replies: r?.replies ?? 0,
      chars: r?.chars ?? 0,
      answered: w?.answered ?? 0,
      avg_wait_ms: w?.avg_wait_ms ?? null,
      avg_first_ms: w?.avg_first_ms ?? null,
      late_replies: w?.late_replies ?? 0,
      resolved: res.get(u.id)?.resolved ?? 0,
      typing_ms: t?.typing_ms ?? 0,
      keystrokes: t?.keystrokes ?? 0,
      typing_share: readyMs > 0 ? Math.min(1, (t?.typing_ms ?? 0) / readyMs) : null,
      timeouts: to.get(u.id) ?? { total: 0, busy: 0, idle: 0, some: 0, offline: 0 },
    };
  });
}

async function timeoutSegments(db, { start, end, ids }) {
  const rows = await db.q(
    `SELECT a.user_id, a.conversation_id, a.started_at, a.ended_at, a.load_at_start,
            (extract(epoch FROM a.ended_at - a.started_at) * 1000)::bigint AS duration_ms,
            (SELECT count(*) FROM desk.messages m
              WHERE m.user_id = a.user_id AND m.sender = 'agent' AND m.delivery = 'sent'
                AND m.created_at >= a.started_at AND m.created_at < a.ended_at
                AND m.conversation_id <> a.conversation_id)::int AS other_replies,
            ${TYPING_IN_WINDOW('a.user_id', 'a.started_at', 'a.ended_at')} AS typing_ms
       FROM desk.assignments a
      WHERE a.end_reason = 'timeout' AND a.ended_at >= $1 AND a.ended_at < $2
        AND ($3::int[] IS NULL OR a.user_id = ANY($3))`,
    [start, end, ids],
  );
  return rows.map((r) => ({ ...r, replied: false }));
}

// The status bar per agent: Ready / Not ready periods across the day.
async function statusTimeline(db, { start, end, until }) {
  const rows = await db.q(
    `SELECT user_id, status, GREATEST(started_at, $1) AS from_at, LEAST(COALESCE(ended_at, $3), $2) AS to_at
       FROM desk.status_log
      WHERE started_at < $2 AND COALESCE(ended_at, $3) > $1 AND status <> 'offline'
      ORDER BY user_id, started_at`,
    [start, end, until],
  );
  const m = new Map();
  for (const r of rows) {
    if (r.to_at <= r.from_at) continue;
    if (!m.has(r.user_id)) m.set(r.user_id, []);
    m.get(r.user_id).push({ status: r.status, from: r.from_at, to: r.to_at });
  }
  return m;
}

export async function dayReport(db, { at, s, date = null }) {
  const win = await dayWindow(db, at, s.timezone, date);
  const { start, end } = win;
  const live = at >= start && at < end;
  const until = live ? at : end;

  const [opened, handled, resolvedRow, contacts, waits, firsts, hourlyOpened, hourlyReplies, lateList, liveNow] =
    await Promise.all([
      db.q(
        `SELECT category, channel, count(*)::int AS n FROM desk.conversations
          WHERE opened_at >= $1 AND opened_at < $2 GROUP BY category, channel`,
        [start, end],
      ),
      db.q(
        `SELECT c.category, c.channel, count(DISTINCT c.id)::int AS n
           FROM desk.messages m JOIN desk.conversations c ON c.id = m.conversation_id
          WHERE m.sender = 'agent' AND m.delivery = 'sent' AND m.created_at >= $1 AND m.created_at < $2
          GROUP BY c.category, c.channel`,
        [start, end],
      ),
      db.one(
        `SELECT count(*)::int AS resolved,
                count(*) FILTER (WHERE first_reply_at IS NULL)::int AS resolved_without_reply
           FROM desk.conversations WHERE closed_at >= $1 AND closed_at < $2`,
        [start, end],
      ),
      db.q(
        `SELECT channel, count(*)::int AS customers, COALESCE(sum(messages), 0)::int AS messages
           FROM desk.contacts_daily WHERE day = $1::date GROUP BY channel`,
        [win.date],
      ),
      db.one(
        `SELECT count(*)::int AS answered,
                count(*) FILTER (WHERE (data->>'late_ms')::numeric > 0)::int AS late,
                avg((data->>'wait_ms')::numeric)::bigint AS avg_ms,
                (percentile_cont(0.5) WITHIN GROUP (ORDER BY (data->>'wait_ms')::numeric))::bigint AS median_ms,
                max((data->>'wait_ms')::numeric)::bigint AS max_ms
           FROM desk.events WHERE type = 'replied' AND created_at >= $1 AND created_at < $2`,
        [start, end],
      ),
      db.one(
        `SELECT count(*)::int AS n,
                (avg(extract(epoch FROM first_reply_at - opened_at)) * 1000)::bigint AS avg_ms,
                (percentile_cont(0.5) WITHIN GROUP (ORDER BY extract(epoch FROM first_reply_at - opened_at)) * 1000)::bigint AS median_ms,
                count(*) FILTER (WHERE first_reply_at - opened_at > $3::float8 * interval '1 minute')::int AS late
           FROM desk.conversations WHERE first_reply_at >= $1 AND first_reply_at < $2`,
        [start, end, s.sla_minutes],
      ),
      db.q(
        `SELECT extract(hour FROM opened_at AT TIME ZONE $3)::int AS hour, count(*)::int AS n
           FROM desk.conversations WHERE opened_at >= $1 AND opened_at < $2 GROUP BY 1`,
        [start, end, s.timezone],
      ),
      db.q(
        `SELECT extract(hour FROM created_at AT TIME ZONE $3)::int AS hour, count(*)::int AS n
           FROM desk.messages
          WHERE sender = 'agent' AND delivery = 'sent' AND created_at >= $1 AND created_at < $2 GROUP BY 1`,
        [start, end, s.timezone],
      ),
      db.q(
        `SELECT e.conversation_id AS id, c.customer_name, c.channel, c.category, c.status,
                e.created_at AS replied_at, (e.data->>'wait_ms')::bigint AS wait_ms,
                (e.data->>'late_ms')::bigint AS late_ms, e.actor_id AS replied_by, u.full_name AS replied_by_name,
                (SELECT count(*) FROM desk.assignments a
                  WHERE a.conversation_id = e.conversation_id
                    AND a.started_at <= e.created_at
                    AND COALESCE(a.ended_at, e.created_at) >= e.created_at - ((e.data->>'wait_ms')::float8 * interval '1 millisecond')
                )::int AS holders
           FROM desk.events e
           JOIN desk.conversations c ON c.id = e.conversation_id
           LEFT JOIN desk.users u ON u.id = e.actor_id
          WHERE e.type = 'replied' AND (e.data->>'late_ms')::numeric > 0
            AND e.created_at >= $1 AND e.created_at < $2
          ORDER BY (e.data->>'late_ms')::numeric DESC
          LIMIT 200`,
        [start, end],
      ),
      live
        ? db.one(
            `SELECT count(*) FILTER (WHERE status = 'queued')::int AS queued,
                    count(*) FILTER (WHERE status = 'assigned')::int AS with_agents,
                    count(*) FILTER (WHERE waiting_since IS NOT NULL)::int AS awaiting,
                    count(*) FILTER (WHERE breached_at IS NOT NULL)::int AS late_now
               FROM desk.conversations WHERE status <> 'closed'`,
          )
        : null,
    ]);

  const agents = await agentDayStats(db, { at, s, window: win });
  const timeline = await statusTimeline(db, { start, end, until });
  for (const a of agents) a.timeline = timeline.get(a.user_id) ?? [];

  const sumBy = (rows, key, value) => {
    const m = Object.fromEntries(value.map((v) => [v, 0]));
    for (const r of rows) m[r[key]] = (m[r[key]] ?? 0) + r.n;
    return m;
  };
  const openedByCat = sumBy(opened, 'category', CATEGORIES);
  const openedByCh = sumBy(opened, 'channel', CHANNELS);
  const handledByCat = sumBy(handled, 'category', CATEGORIES);
  const handledByCh = sumBy(handled, 'channel', CHANNELS);
  const contactsByCh = Object.fromEntries(CHANNELS.map((c) => [c, 0]));
  for (const r of contacts) contactsByCh[r.channel] = r.customers;

  const newChats = opened.reduce((a, r) => a + r.n, 0);
  const handledTotal = handled.reduce((a, r) => a + r.n, 0);
  const contactsTotal = contacts.reduce((a, r) => a + r.customers, 0);
  const lateNowRows = live
    ? await db.q(
        `SELECT c.id, c.customer_name, c.channel, c.category, c.waiting_since, c.assigned_to,
                u.full_name AS holder_name, c.transfers
           FROM desk.conversations c LEFT JOIN desk.users u ON u.id = c.assigned_to
          WHERE c.status <> 'closed' AND c.breached_at IS NOT NULL
          ORDER BY c.waiting_since`,
      )
    : [];

  const hours = Array.from({ length: 24 }, (_, h) => ({ hour: h, opened: 0, replies: 0 }));
  for (const r of hourlyOpened) hours[r.hour].opened = r.n;
  for (const r of hourlyReplies) hours[r.hour].replies = r.n;

  const replies = agents.reduce((a, r) => a + r.replies, 0);

  return {
    date: win.date,
    start,
    end,
    live,
    timezone: s.timezone,
    generated_at: at,
    sla_minutes: s.sla_minutes,
    totals: {
      new_chats: newChats,
      handled: handledTotal,
      resolved: resolvedRow.resolved,
      resolved_without_reply: resolvedRow.resolved_without_reply,
      replies,
      contacts: contactsTotal,
      handoff_share: contactsTotal ? Math.min(1, newChats / contactsTotal) : null,
    },
    by_category: CATEGORIES.map((k) => ({ key: k, opened: openedByCat[k] ?? 0, handled: handledByCat[k] ?? 0 })),
    by_channel: CHANNELS.map((k) => ({
      key: k, opened: openedByCh[k] ?? 0, handled: handledByCh[k] ?? 0, contacts: contactsByCh[k] ?? 0,
    })),
    first_response: {
      count: firsts.n,
      avg_ms: firsts.avg_ms,
      median_ms: firsts.median_ms,
      late: firsts.late,
    },
    waits: {
      answered: waits.answered,
      on_time: waits.answered - waits.late,
      late: waits.late,
      avg_ms: waits.avg_ms,
      median_ms: waits.median_ms,
      max_ms: waits.max_ms,
      on_time_share: waits.answered ? (waits.answered - waits.late) / waits.answered : null,
    },
    hourly: hours,
    agents,
    late_chats: lateList,
    late_now: lateNowRows,
    live_now: liveNow,
  };
}

const CSV_COLUMNS = [
  ['employee_id', 'Employee ID'],
  ['full_name', 'Name'],
  ['role', 'Role'],
  ['checked_in_at', 'Check-in'],
  ['checked_out_at', 'Check-out'],
  ['logged_ms', 'Logged in (min)'],
  ['ready_ms', 'Ready (min)'],
  ['not_ready_ms', 'Not ready (min)'],
  ['received', 'Chats received'],
  ['handled', 'Chats handled'],
  ['replies', 'Replies sent'],
  ['resolved', 'Resolved'],
  ['avg_wait_ms', 'Avg reply time (s)'],
  ['late_replies', 'Late replies'],
  ['timeouts', 'Chats moved for no reply'],
  ['timeouts_idle', '...of which idle'],
  ['typing_ms', 'Typing (min)'],
  ['keystrokes', 'Keystrokes'],
];

function csvCell(v) {
  if (v == null) return '';
  const s = String(v);
  // Neutralise spreadsheet formulas in names typed by people.
  const safe = /^[=+\-@\t\r]/.test(s) ? `'${s}` : s;
  return /[",\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}

export function agentsCsv(report, tz) {
  const fmt = (d) =>
    d ? new Date(d).toLocaleString('en-GB', { timeZone: tz, hour12: false }).replace(',', '') : '';
  const min = (ms) => (ms == null ? '' : Math.round(ms / 600) / 100);
  const lines = [CSV_COLUMNS.map((c) => c[1]).join(',')];
  for (const a of report.agents.filter((x) => x.is_active || x.logged_ms || x.replies)) {
    const row = {
      ...a,
      checked_in_at: fmt(a.checked_in_at),
      checked_out_at: a.checked_out_at ? fmt(a.checked_out_at) : a.online ? 'online' : '',
      logged_ms: min(a.logged_ms),
      ready_ms: min(a.ready_ms),
      not_ready_ms: min(a.not_ready_ms),
      typing_ms: min(a.typing_ms),
      avg_wait_ms: a.avg_wait_ms == null ? '' : Math.round(a.avg_wait_ms / 1000),
      timeouts: a.timeouts.total,
      timeouts_idle: a.timeouts.idle,
    };
    lines.push(CSV_COLUMNS.map(([k]) => csvCell(row[k])).join(','));
  }
  return '﻿' + lines.join('\r\n') + '\r\n';
}
