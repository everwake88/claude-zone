-- =====================================================================
-- Everwake Salary · 001 · the tables
--
-- Everything lives in the "salary" schema, so it can sit in a database
-- that already holds other things. Plain PostgreSQL 13+: no extensions.
--
--   settings            what the agent asks before it shares anything (the HR checkboxes)
--   channel             the WhatsApp line (Evolution API now, WhatsApp Cloud later)
--   hr_users            who can sign in to the dashboard
--   payroll_sheets      one uploaded Excel sheet = one payroll month
--   payroll_rows        its rows, every cell kept under its column (cells jsonb)
--   conversations       one per WhatsApp number: who they proved they are, and until when
--   messages            every message in and out (the agent's memory, the dashboard's view)
--   identity_attempts   every identity check, with the values masked
--   disputes            "this deduction is wrong" — passed to HR from the chat
-- =====================================================================
create schema if not exists salary;

-- ---- what the agent must collect, and how strictly -----------------------------------
create table if not exists salary.settings (
  id                      boolean primary key default true check (id),
  company_name            text    not null default 'الشركة',
  agent_name              text    not null default 'نور',
  -- the HR checkboxes: what the employee is asked for before any salary detail
  ask_full_name           boolean not null default true,
  ask_national_id         boolean not null default true,
  ask_work_id             boolean not null default true,
  ask_phone               boolean not null default false,
  -- the phone on the payroll row must be the WhatsApp number the employee writes from
  phone_must_match_sender boolean not null default true,
  -- formats
  name_min_words          int     not null default 3 check (name_min_words between 1 and 6),
  work_id_digits_only     boolean not null default false,
  work_id_min_length      int     not null default 1 check (work_id_min_length between 1 and 30),
  work_id_max_length      int     not null default 20 check (work_id_max_length between 1 and 40),
  -- a verified chat is trusted for this long, then the employee is asked again (0 = never)
  verified_hours          int     not null default 24 check (verified_hours between 0 and 720),
  -- what the agent tells people for anything it can't handle (an extension, an email, an office)
  hr_contact              text    not null default '',
  agent_enabled           boolean not null default true,
  updated_at              timestamptz not null default now(),
  updated_by              uuid,
  -- a name alone (or a name and a phone) proves too little: one unique number is always asked
  constraint one_unique_id check (ask_national_id or ask_work_id),
  constraint work_id_lengths check (work_id_min_length <= work_id_max_length)
);
insert into salary.settings (id) values (true) on conflict do nothing;

-- ---- the WhatsApp line ---------------------------------------------------------------------
create table if not exists salary.channel (
  id            boolean primary key default true check (id),
  provider      text not null default 'evolution' check (provider in ('evolution', 'cloud')),
  base_url      text not null default '',          -- Evolution: https://evo.example.com
  instance      text not null default '',          -- Evolution instance name
  api_key       text not null default '',          -- Evolution API key (or the Cloud API token later)
  phone_number_id text not null default '',        -- WhatsApp Cloud only, later
  -- the webhook must carry ?token=<this>: proof the message came from our Evolution
  webhook_token text not null default replace(gen_random_uuid()::text, '-', ''),
  updated_at    timestamptz not null default now()
);
insert into salary.channel (id) values (true) on conflict do nothing;

-- ---- dashboard users ------------------------------------------------------------------------
create table if not exists salary.hr_users (
  id            uuid primary key default gen_random_uuid(),
  email         text not null,
  name          text not null default '',
  password_hash text not null,
  role          text not null default 'hr' check (role in ('admin', 'hr')),
  active        boolean not null default true,
  created_at    timestamptz not null default now(),
  last_login_at timestamptz
);
create unique index if not exists hr_users_email on salary.hr_users (lower(email));

-- ---- payroll: one sheet per month, its rows and columns as uploaded -------------------------
create table if not exists salary.payroll_sheets (
  id            uuid primary key default gen_random_uuid(),
  period        date not null check (extract(day from period) = 1),   -- the payroll month (its first day)
  title         text not null default '',
  file_name     text not null default '',
  sheet_name    text not null default '',
  -- the columns in their order: [{"key":"c1","header":"الاسم","visible":true}, …]
  columns       jsonb not null default '[]',
  -- which column holds each identity field: {"full_name":"c1","national_id":"c3","work_id":"c2","phone":"c5"}
  identity      jsonb not null default '{}',
  status        text not null default 'draft' check (status in ('draft', 'published')),
  row_count     int  not null default 0,
  problem_count int  not null default 0,
  uploaded_by   uuid references salary.hr_users (id) on delete set null,
  uploaded_at   timestamptz not null default now(),
  published_at  timestamptz
);
-- one published sheet per month (a new upload for the month replaces it on publish)
create unique index if not exists payroll_sheets_one_per_month on salary.payroll_sheets (period) where status = 'published';

create table if not exists salary.payroll_rows (
  id           bigserial primary key,
  sheet_id     uuid not null references salary.payroll_sheets (id) on delete cascade,
  row_no       int  not null,                 -- the row number in the Excel sheet
  cells        jsonb not null,                -- {"c1": "أحمد محمد علي", "c2": 1023, …}
  -- the identity fields, normalised for the exact match (filled by salary.index_sheet)
  name_norm    text,
  national_id  text,
  work_id      text,
  phone        text,
  person_key   text,                          -- the same person across months: national id, else work id
  problems     text[] not null default '{}'
);
create index if not exists payroll_rows_sheet on salary.payroll_rows (sheet_id, row_no);
create index if not exists payroll_rows_nid on salary.payroll_rows (national_id) where national_id is not null;
create index if not exists payroll_rows_wid on salary.payroll_rows (work_id) where work_id is not null;
create index if not exists payroll_rows_person on salary.payroll_rows (person_key) where person_key is not null;

-- ---- the chats ------------------------------------------------------------------------------
create table if not exists salary.conversations (
  id              uuid primary key default gen_random_uuid(),
  wa_id           text not null unique,        -- the sender: their number, or WhatsApp's private id
  reply_to        text not null default '',    -- where replies go (a number, or a full …@lid jid)
  phone           text,                        -- their number, 01xxxxxxxxx (null while WhatsApp hides it)
  push_name       text,
  provider        text not null default 'evolution',
  -- what they have given so far while proving who they are (valid values only)
  collected       jsonb not null default '{}',
  -- who they proved to be
  person_key      text,
  employee_name   text,
  verified_row    bigint references salary.payroll_rows (id) on delete set null,
  verified_at     timestamptz,
  failed_attempts int not null default 0,
  -- the turn in progress: the newest message it answers (the debounce)
  turn_message_id bigint,
  last_inbound_at  timestamptz,
  last_outbound_at timestamptz,
  created_at      timestamptz not null default now()
);

create table if not exists salary.messages (
  id              bigserial primary key,
  conversation_id uuid not null references salary.conversations (id) on delete cascade,
  direction       text not null check (direction in ('in', 'out')),
  author          text not null check (author in ('employee', 'agent', 'hr')),
  kind            text not null default 'text',   -- text, voice, image, document, sticker, …
  text            text not null default '',
  external_id     text,
  answered        boolean not null default false, -- an inbound message the agent has replied to
  send_error      text,
  hr_user_id      uuid references salary.hr_users (id) on delete set null,
  created_at      timestamptz not null default now()
);
create unique index if not exists messages_external on salary.messages (external_id) where external_id is not null;
create index if not exists messages_conv on salary.messages (conversation_id, id);

create table if not exists salary.identity_attempts (
  id              bigserial primary key,
  conversation_id uuid not null references salary.conversations (id) on delete cascade,
  given           jsonb not null,                 -- masked: "•••••••••••4567"
  result          text  not null,                 -- verified, no_match, ambiguous, sender_hidden, phone_mismatch
  matched_row     bigint references salary.payroll_rows (id) on delete set null,
  created_at      timestamptz not null default now()
);
create index if not exists identity_attempts_conv on salary.identity_attempts (conversation_id, id);

create table if not exists salary.disputes (
  id              uuid primary key default gen_random_uuid(),
  ticket_no       serial unique,
  conversation_id uuid not null references salary.conversations (id) on delete cascade,
  person_key      text,
  employee_name   text,
  period          date,
  item            text not null default '',       -- the column it is about ("خصم التأخير")
  details         text not null default '',       -- the employee's words
  status          text not null default 'open' check (status in ('open', 'resolved')),
  hr_note         text not null default '',
  resolved_by     uuid references salary.hr_users (id) on delete set null,
  resolved_at     timestamptz,
  created_at      timestamptz not null default now()
);
create index if not exists disputes_status on salary.disputes (status, created_at desc);
