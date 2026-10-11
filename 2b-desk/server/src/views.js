// Read-side queries shared by the API, the realtime hub and the engine.

export const CONV_FIELDS = `
  c.id, c.channel, c.external_id, c.customer_ref, c.customer_name, c.customer_phone,
  c.category, c.ai_category, c.summary, c.status,
  c.assigned_to, hu.full_name AS assigned_name, hu.employee_id AS assigned_employee_id, c.assigned_at,
  c.hold_until, c.waiting_since, c.reminders_sent, c.breached_at, c.reply_pending_until,
  c.opened_at, c.first_reply_at, c.first_reply_by, c.last_customer_at, c.last_agent_at,
  c.last_message_at, c.last_preview, c.unread, c.transfers, c.late_cycles,
  c.closed_at, c.closed_by, cu.full_name AS closed_by_name, c.close_note,
  CASE WHEN tr.id IS NULL THEN NULL ELSE json_build_object(
    'id', tr.id, 'from', tr.from_user, 'from_name', fu.full_name,
    'to', tr.to_user, 'to_name', tu.full_name, 'note', tr.note,
    'created_at', tr.created_at, 'expires_at', tr.expires_at) END AS transfer`;

export const CONV_FROM = `
  FROM desk.conversations c
  LEFT JOIN desk.users hu ON hu.id = c.assigned_to
  LEFT JOIN desk.users cu ON cu.id = c.closed_by
  LEFT JOIN desk.transfer_requests tr ON tr.conversation_id = c.id AND tr.status = 'pending'
  LEFT JOIN desk.users fu ON fu.id = tr.from_user
  LEFT JOIN desk.users tu ON tu.id = tr.to_user`;

export async function convSummaries(runner, ids) {
  if (!ids.length) return [];
  return runner.q(`SELECT ${CONV_FIELDS} ${CONV_FROM} WHERE c.id = ANY($1::bigint[])`, [ids]);
}

export async function convSummary(runner, id) {
  return runner.one(`SELECT ${CONV_FIELDS} ${CONV_FROM} WHERE c.id = $1`, [id]);
}

// Everyone on the team with their live status and how full their queue is.
export async function teamSnapshot(runner, s) {
  return runner.q(
    `SELECT u.id, u.employee_id, u.full_name, u.role,
            COALESCE(u.max_chats, $1)::int AS cap,
            COALESCE(st.status, 'offline') AS status, st.status_since, st.last_seen_at,
            COALESCE(l.load, 0)::int AS load,
            COALESCE(l.awaiting, 0)::int AS awaiting,
            COALESCE(l.late, 0)::int AS late
       FROM desk.users u
       LEFT JOIN desk.agent_state st ON st.user_id = u.id
       LEFT JOIN (
         SELECT assigned_to,
                count(*) AS load,
                count(*) FILTER (WHERE waiting_since IS NOT NULL) AS awaiting,
                count(*) FILTER (WHERE breached_at IS NOT NULL) AS late
           FROM desk.conversations
          WHERE status = 'assigned'
          GROUP BY assigned_to
       ) l ON l.assigned_to = u.id
      WHERE u.is_active
      ORDER BY CASE COALESCE(st.status, 'offline') WHEN 'ready' THEN 0 WHEN 'not_ready' THEN 1 ELSE 2 END,
               u.full_name`,
    [s.max_chats],
  );
}

export function publicUser(u) {
  if (!u) return null;
  return {
    id: u.id,
    employee_id: u.employee_id,
    username: u.username,
    full_name: u.full_name,
    role: u.role,
    max_chats: u.max_chats,
    is_active: u.is_active,
  };
}

export async function agentState(runner, userId) {
  return runner.one(
    `SELECT status, status_since, status_reason, last_seen_at FROM desk.agent_state WHERE user_id = $1`,
    [userId],
  );
}

// Start of the working day containing `at`, in the configured time zone.
export async function dayWindow(runner, at, tz, dateStr = null) {
  const row = dateStr
    ? await runner.one(
        `SELECT ($1::date::timestamp AT TIME ZONE $2) AS start,
                (($1::date + 1)::timestamp AT TIME ZONE $2) AS "end"`,
        [dateStr, tz],
      )
    : await runner.one(
        `SELECT (date_trunc('day', $1::timestamptz AT TIME ZONE $2) AT TIME ZONE $2) AS start,
                ((date_trunc('day', $1::timestamptz AT TIME ZONE $2) + interval '1 day') AT TIME ZONE $2) AS "end",
                to_char($1::timestamptz AT TIME ZONE $2, 'YYYY-MM-DD') AS date`,
        [at, tz],
      );
  if (dateStr) row.date = dateStr;
  return row;
}
