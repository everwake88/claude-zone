// The "Track" view of one chat: who held it, for how long, how loaded they
// were, what they were doing meanwhile, and how each wait ended.
import { convSummary } from './views.js';
import { verdict, TYPING_IN_WINDOW, KEYS_IN_WINDOW } from './reports.js';

export async function journey(db, convId, { at, s }) {
  const conversation = await convSummary(db, convId);
  if (!conversation) return null;

  const segments = await db.q(
    `WITH seg AS (
       SELECT a.*, COALESCE(a.ended_at, $2::timestamptz) AS until
         FROM desk.assignments a WHERE a.conversation_id = $1
     )
     SELECT seg.id, seg.user_id, u.full_name, u.employee_id, seg.how, seg.started_at, seg.ended_at,
            seg.end_reason, seg.load_at_start, seg.awaiting_at_start, seg.first_reply_at,
            (extract(epoch FROM seg.until - seg.started_at) * 1000)::bigint AS duration_ms,
            -- every chat this agent held at some point while this one sat with them
            (SELECT count(*) FROM desk.assignments b
              WHERE b.user_id = seg.user_id AND b.started_at < seg.until
                AND COALESCE(b.ended_at, $2::timestamptz) > seg.started_at)::int AS chats_during,
            (SELECT count(*) FROM desk.messages m
              WHERE m.user_id = seg.user_id AND m.sender = 'agent' AND m.delivery = 'sent'
                AND m.created_at >= seg.started_at AND m.created_at < seg.until
                AND m.conversation_id <> seg.conversation_id)::int AS other_replies,
            (SELECT count(*) FROM desk.messages m
              WHERE m.user_id = seg.user_id AND m.sender = 'agent' AND m.delivery = 'sent'
                AND m.created_at >= seg.started_at AND m.created_at < seg.until
                AND m.conversation_id = seg.conversation_id)::int AS own_replies,
            ${TYPING_IN_WINDOW('seg.user_id', 'seg.started_at', 'seg.until')} AS typing_ms,
            ${KEYS_IN_WINDOW('seg.user_id', 'seg.started_at', 'seg.until')} AS keystrokes,
            (SELECT COALESCE(sum(GREATEST(0, extract(epoch FROM
                      LEAST(COALESCE(sl.ended_at, $2::timestamptz), seg.until) - GREATEST(sl.started_at, seg.started_at)))), 0) * 1000
               FROM desk.status_log sl
              WHERE sl.user_id = seg.user_id AND sl.status = 'ready'
                AND sl.started_at < seg.until AND COALESCE(sl.ended_at, $2::timestamptz) > seg.started_at)::bigint AS ready_ms,
            (SELECT COALESCE(sum(GREATEST(0, extract(epoch FROM
                      LEAST(COALESCE(sl.ended_at, $2::timestamptz), seg.until) - GREATEST(sl.started_at, seg.started_at)))), 0) * 1000
               FROM desk.status_log sl
              WHERE sl.user_id = seg.user_id AND sl.status = 'not_ready'
                AND sl.started_at < seg.until AND COALESCE(sl.ended_at, $2::timestamptz) > seg.started_at)::bigint AS not_ready_ms,
            (SELECT COALESCE(sum(GREATEST(0, extract(epoch FROM
                      LEAST(COALESCE(sl.ended_at, $2::timestamptz), seg.until) - GREATEST(sl.started_at, seg.started_at)))), 0) * 1000
               FROM desk.status_log sl
              WHERE sl.user_id = seg.user_id AND sl.status = 'offline'
                AND sl.started_at < seg.until AND COALESCE(sl.ended_at, $2::timestamptz) > seg.started_at)::bigint AS offline_ms
       FROM seg JOIN desk.users u ON u.id = seg.user_id
      ORDER BY seg.started_at, seg.id`,
    [convId, at],
  );

  const events = await db.q(
    `SELECT e.id, e.type, e.user_id, u.full_name AS user_name, e.actor_id, ac.full_name AS actor_name,
            e.data, e.created_at
       FROM desk.events e
       LEFT JOIN desk.users u ON u.id = e.user_id
       LEFT JOIN desk.users ac ON ac.id = e.actor_id
      WHERE e.conversation_id = $1
      ORDER BY e.created_at, e.id`,
    [convId],
  );

  // Each "wait": from a customer message to the reply that answered it.
  const waits = events
    .filter((e) => e.type === 'replied')
    .map((e) => ({
      replied_at: e.created_at,
      started_at: new Date(new Date(e.created_at).getTime() - Number(e.data.wait_ms)),
      wait_ms: Number(e.data.wait_ms),
      late_ms: Number(e.data.late_ms),
      first: !!e.data.first,
      by: e.actor_id,
      by_name: e.actor_name,
    }));
  if (conversation.waiting_since) {
    const w = new Date(conversation.waiting_since);
    waits.push({
      replied_at: null,
      started_at: w,
      wait_ms: at - w,
      late_ms: Math.max(0, at - w - s.slaMs),
      first: !conversation.first_reply_at,
      by: null,
      by_name: null,
    });
  }

  const shaped = segments.map((seg) => {
    const replied = seg.own_replies > 0 || !!seg.first_reply_at;
    const ongoing = !seg.ended_at;
    return {
      ...seg,
      ongoing,
      replied,
      verdict: ongoing && !replied ? null : verdict({ ...seg, replied }, s),
      typing_share: seg.duration_ms > 0 ? Math.min(1, seg.typing_ms / seg.duration_ms) : 0,
    };
  });

  return {
    conversation,
    first_response_ms: conversation.first_reply_at
      ? new Date(conversation.first_reply_at) - new Date(conversation.opened_at)
      : null,
    sla_minutes: s.sla_minutes,
    segments: shaped,
    waits,
    events,
    generated_at: at,
  };
}
