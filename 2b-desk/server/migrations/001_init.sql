-- 2B Desk — initial schema.
-- Everything lives in its own "desk" schema so it can share the Postgres
-- database the 2B AI agent already uses (schema "agent") without touching it.
--
-- Times are always written by the server from its own clock, so the defaults
-- below are only a safety net.

CREATE SCHEMA IF NOT EXISTS desk;

-- ---------------------------------------------------------------------------
-- Settings — the numbers that drive routing and the SLA. Editable from the
-- dashboard (Settings page); the engine re-reads them every few seconds.
-- ---------------------------------------------------------------------------
CREATE TABLE desk.settings (
  key        text PRIMARY KEY,
  value      jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

INSERT INTO desk.settings (key, value) VALUES
  ('max_chats',                '25'),            -- per agent, never exceeded
  ('sla_minutes',              '15'),            -- a reply later than this is a violation
  ('first_hold_minutes',       '10'),            -- first agent keeps an unanswered chat this long
  ('hop_minutes',              '1'),             -- then it hops to the next agent every N minutes
  ('reminder_minutes',         '[5, 8]'),        -- reminders to the holder, minutes after the customer wrote
  ('transfer_timeout_seconds', '60'),            -- a teammate must accept a transfer within this
  ('offline_after_seconds',    '90'),            -- no heartbeat for this long = disconnected
  ('auto_checkout_minutes',    '30'),            -- disconnected this long = checked out
  ('timezone',                 '"Africa/Cairo"'),-- the working day for reports
  ('busy_replies_per_minute',  '0.5'),           -- journey verdict: "Busy" thresholds
  ('busy_typing_share',        '0.25'),
  ('idle_typing_share',        '0.05');          -- below this with no replies = "Idle"

-- ---------------------------------------------------------------------------
-- People
-- ---------------------------------------------------------------------------
CREATE TABLE desk.users (
  id            serial PRIMARY KEY,
  employee_id   text NOT NULL,                  -- the 2B staff ID shown everywhere, e.g. 2B-014
  username      text NOT NULL,
  full_name     text NOT NULL,
  role          text NOT NULL DEFAULT 'agent' CHECK (role IN ('agent', 'supervisor', 'admin')),
  password_hash text NOT NULL,
  max_chats     int CHECK (max_chats IS NULL OR max_chats BETWEEN 1 AND 200), -- NULL = the default
  is_active     boolean NOT NULL DEFAULT true,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX users_username_uniq ON desk.users (lower(username));
CREATE UNIQUE INDEX users_employee_uniq ON desk.users (lower(employee_id));

-- One row per login. checked_in_at / checked_out_at are the attendance record.
CREATE TABLE desk.sessions (
  id              uuid PRIMARY KEY,
  user_id         int NOT NULL REFERENCES desk.users(id),
  token_hash      text NOT NULL UNIQUE,
  checked_in_at   timestamptz NOT NULL,
  last_seen_at    timestamptz NOT NULL,
  checked_out_at  timestamptz,
  checkout_reason text,                         -- logout | timeout | replaced | disabled
  ip              text,
  user_agent      text
);
CREATE INDEX sessions_user_idx ON desk.sessions (user_id, checked_in_at);
CREATE UNIQUE INDEX sessions_one_open ON desk.sessions (user_id) WHERE checked_out_at IS NULL;

-- Live presence. "ready" agents receive chats; "not_ready" agents keep the
-- chats they have but get nothing new; "offline" agents have nothing.
CREATE TABLE desk.agent_state (
  user_id          int PRIMARY KEY REFERENCES desk.users(id),
  status           text NOT NULL DEFAULT 'offline' CHECK (status IN ('offline', 'not_ready', 'ready')),
  status_since     timestamptz NOT NULL DEFAULT now(),
  status_reason    text,
  last_seen_at     timestamptz,
  last_assigned_at timestamptz
);

-- Every status period, so Ready / Not ready time can be added up for any day.
CREATE TABLE desk.status_log (
  id         bigserial PRIMARY KEY,
  user_id    int NOT NULL REFERENCES desk.users(id),
  status     text NOT NULL CHECK (status IN ('offline', 'not_ready', 'ready')),
  reason     text,
  started_at timestamptz NOT NULL,
  ended_at   timestamptz
);
CREATE INDEX status_log_user_idx ON desk.status_log (user_id, started_at);
CREATE UNIQUE INDEX status_log_one_open ON desk.status_log (user_id) WHERE ended_at IS NULL;

-- ---------------------------------------------------------------------------
-- Conversations handed to humans
-- ---------------------------------------------------------------------------
CREATE TABLE desk.conversations (
  id               bigserial PRIMARY KEY,
  channel          text NOT NULL CHECK (channel IN ('whatsapp', 'messenger', 'instagram')),
  external_id      text NOT NULL,               -- WhatsApp JID / Messenger PSID / Instagram IGSID
  customer_ref     text,                        -- agent.customers id, passed back to n8n
  customer_name    text,
  customer_phone   text,
  category         text NOT NULL DEFAULT 'inquiry'
                   CHECK (category IN ('inquiry', 'sales', 'complaint', 'followup')),
  ai_category      text,                        -- what the AI said, kept if a human re-labels it
  summary          text,                        -- the AI's hand-off note
  status           text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'assigned', 'closed')),
  assigned_to      int REFERENCES desk.users(id),
  assigned_at      timestamptz,
  hold_until       timestamptz,                 -- when the current holder loses an unanswered chat
  waiting_since    timestamptz,                 -- oldest unanswered customer message; NULL = answered
  reminders_sent   int NOT NULL DEFAULT 0,
  breached_at      timestamptz,                 -- this wait crossed the SLA
  reply_pending_until timestamptz,              -- a reply is on its way to the customer; don't move the chat
  opened_at        timestamptz NOT NULL,
  first_reply_at   timestamptz,
  first_reply_by   int REFERENCES desk.users(id),
  last_customer_at timestamptz,
  last_agent_at    timestamptz,
  last_message_at  timestamptz,
  last_preview     text,
  unread           int NOT NULL DEFAULT 0,
  transfers        int NOT NULL DEFAULT 0,
  late_cycles      int NOT NULL DEFAULT 0,
  closed_at        timestamptz,
  closed_by        int REFERENCES desk.users(id),
  close_note       text,
  CHECK (status <> 'assigned' OR assigned_to IS NOT NULL),
  CHECK (status <> 'queued' OR assigned_to IS NULL)
);
CREATE UNIQUE INDEX conversations_open_uniq ON desk.conversations (channel, external_id) WHERE status <> 'closed';
CREATE INDEX conversations_holder_idx ON desk.conversations (assigned_to) WHERE status = 'assigned';
CREATE INDEX conversations_open_idx ON desk.conversations (status) WHERE status <> 'closed';
CREATE INDEX conversations_ref_idx ON desk.conversations (customer_ref) WHERE status <> 'closed';
CREATE INDEX conversations_opened_idx ON desk.conversations (opened_at);
CREATE INDEX conversations_closed_idx ON desk.conversations (closed_at);
CREATE INDEX conversations_customer_idx ON desk.conversations (channel, external_id, opened_at);

CREATE TABLE desk.messages (
  id                  bigserial PRIMARY KEY,
  conversation_id     bigint NOT NULL REFERENCES desk.conversations(id) ON DELETE CASCADE,
  sender              text NOT NULL CHECK (sender IN ('customer', 'ai', 'agent')),
  user_id             int REFERENCES desk.users(id),
  body                text NOT NULL,
  external_id         text,
  delivery            text CHECK (delivery IN ('pending', 'sent', 'failed')),
  error               text,
  answered_wait_since timestamptz,              -- the wait this reply closed; restored if it fails
  created_at          timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX messages_conv_idx ON desk.messages (conversation_id, id);
CREATE INDEX messages_agent_idx ON desk.messages (user_id, created_at) WHERE sender = 'agent';
CREATE INDEX messages_created_idx ON desk.messages (created_at);
-- n8n may retry a webhook; the same inbound message must never appear twice.
CREATE UNIQUE INDEX messages_inbound_uniq ON desk.messages (conversation_id, external_id)
  WHERE external_id IS NOT NULL AND sender = 'customer';

-- Who held a chat, from when to when. The journey ("Track") view and the
-- busy / idle verdicts are computed from these.
CREATE TABLE desk.assignments (
  id                bigserial PRIMARY KEY,
  conversation_id   bigint NOT NULL REFERENCES desk.conversations(id) ON DELETE CASCADE,
  user_id           int NOT NULL REFERENCES desk.users(id),
  how               text NOT NULL,              -- auto | sla | transfer | manual
  started_at        timestamptz NOT NULL,
  ended_at          timestamptz,
  end_reason        text,                       -- timeout | transferred | reassigned | offline | logout | closed
  load_at_start     int NOT NULL DEFAULT 0,     -- chats the agent already had when this one arrived
  awaiting_at_start boolean NOT NULL DEFAULT false,
  first_reply_at    timestamptz
);
CREATE UNIQUE INDEX assignments_one_open ON desk.assignments (conversation_id) WHERE ended_at IS NULL;
CREATE INDEX assignments_conv_idx ON desk.assignments (conversation_id, started_at);
CREATE INDEX assignments_user_idx ON desk.assignments (user_id, started_at);

-- Agent-to-agent "please take this chat" requests.
CREATE TABLE desk.transfer_requests (
  id              bigserial PRIMARY KEY,
  conversation_id bigint NOT NULL REFERENCES desk.conversations(id) ON DELETE CASCADE,
  from_user       int NOT NULL REFERENCES desk.users(id),
  to_user         int NOT NULL REFERENCES desk.users(id),
  note            text,
  status          text NOT NULL DEFAULT 'pending'
                  CHECK (status IN ('pending', 'accepted', 'declined', 'expired', 'cancelled')),
  created_at      timestamptz NOT NULL,
  expires_at      timestamptz NOT NULL,
  responded_at    timestamptz
);
CREATE UNIQUE INDEX transfer_one_pending ON desk.transfer_requests (conversation_id) WHERE status = 'pending';
CREATE INDEX transfer_to_idx ON desk.transfer_requests (to_user) WHERE status = 'pending';

-- Timeline of everything that happened to a conversation.
CREATE TABLE desk.events (
  id              bigserial PRIMARY KEY,
  conversation_id bigint REFERENCES desk.conversations(id) ON DELETE CASCADE,
  type            text NOT NULL,
  user_id         int REFERENCES desk.users(id),  -- the agent it concerns
  actor_id        int REFERENCES desk.users(id),  -- who caused it; NULL = the system
  data            jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX events_conv_idx ON desk.events (conversation_id, id);
CREATE INDEX events_type_idx ON desk.events (type, created_at);
CREATE INDEX events_user_idx ON desk.events (user_id, created_at);

-- Typing activity, one row per agent per minute.
CREATE TABLE desk.activity (
  user_id    int NOT NULL REFERENCES desk.users(id),
  minute     timestamptz NOT NULL,
  keystrokes int NOT NULL DEFAULT 0,
  typing_ms  int NOT NULL DEFAULT 0 CHECK (typing_ms BETWEEN 0 AND 60000),
  PRIMARY KEY (user_id, minute)
);

-- Every customer who wrote to the AI on a given day, so reports can compare
-- "everyone who wrote" with "handed to the team".
CREATE TABLE desk.contacts_daily (
  day         date NOT NULL,
  channel     text NOT NULL,
  external_id text NOT NULL,
  messages    int NOT NULL DEFAULT 1,
  first_at    timestamptz NOT NULL,
  PRIMARY KEY (day, channel, external_id)
);
