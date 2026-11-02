-- =====================================================================
-- Everwake Clinic · 003 · WhatsApp: numbers, people who write, chats,
-- the outbox, and the engine's turn plumbing
--
-- The Everwake Orders engine (EVERWAKE-ORDERS/database/migrations 004,
-- 005, 014, 015), adapted:
--   · a customer is a `contact`: the WhatsApp person who writes. One
--     contact can book for several patients (a mother for her children);
--     004 links them.
--   · intake() finds the clinic from the Evolution instance (and its
--     token), the contact by any identity (number or private id), logs
--     the message once, and routes it: agent · human · paused · not_live
--     · staff (a team member's own number: the doctor's commands, e.g.
--     "هتأخر 20 دقيقة") · team_answer · from_me · duplicate · ignore
--   · claim_window() debounces (only the run holding the newest message
--     answers, and it bundles them), persist_turn() saves memory, asks
--     the team, raises alerts, unlocks; a reply is dropped when the
--     patient wrote again meanwhile, unless the turn did something final
--   · everything the clinic sends (reminders, delay notices, staff
--     replies…) goes through `outbox`, spaced with not_before
-- =====================================================================

create table clinic.whatsapp_channels (
  id                    uuid primary key default gen_random_uuid(),
  tenant_id             uuid not null references clinic.tenants(id) on delete cascade,
  provider              text not null default 'evolution' check (provider in ('evolution', 'cloud_api')),
  label                 text,
  phone_number          text,
  instance_name         text,
  base_url              text,
  api_key               text,             -- secret: never readable from the dashboard
  cloud_phone_number_id text,
  cloud_access_token    text,             -- secret
  webhook_token         text not null default clinic.random_token(),
  status                text not null default 'pending' check (status in ('pending', 'connected', 'disconnected')),
  is_active             boolean not null default true,
  last_inbound_at       timestamptz,
  connected_at          timestamptz,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now()
);
create unique index whatsapp_channels_instance_uidx on clinic.whatsapp_channels (instance_name)
  where provider = 'evolution' and instance_name is not null;
create unique index whatsapp_channels_cloud_uidx on clinic.whatsapp_channels (cloud_phone_number_id)
  where provider = 'cloud_api' and cloud_phone_number_id is not null;

create table clinic.contacts (
  id            bigint generated always as identity primary key,
  tenant_id     uuid not null references clinic.tenants(id) on delete cascade,
  wa_id         text not null,          -- the conversation key: real number, else the lid digits
  reply_to      text,                   -- where replies go (number, or the full "…@lid")
  phone         text,
  lid           text,
  phone_hidden  boolean not null default false,
  display_name  text,                   -- WhatsApp profile name
  full_name     text,
  language      text,
  notes         text,
  tags          text[] not null default '{}',
  is_blocked    boolean not null default false,
  first_seen_at timestamptz not null default now(),
  last_seen_at  timestamptz not null default now(),
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  unique (tenant_id, wa_id)
);
create index contacts_phone_idx on clinic.contacts (tenant_id, phone) where phone is not null;

create table clinic.contact_identities (
  tenant_id  uuid not null references clinic.tenants(id) on delete cascade,
  kind       text not null check (kind in ('phone', 'lid')),
  value      text not null,
  contact_id bigint not null references clinic.contacts(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (tenant_id, kind, value)
);
create index contact_identities_contact_idx on clinic.contact_identities (contact_id);

create table clinic.conversations (
  id                     bigint generated always as identity primary key,
  tenant_id              uuid not null references clinic.tenants(id) on delete cascade,
  contact_id             bigint references clinic.contacts(id) on delete set null,
  wa_id                  text not null,
  kind                   text not null default 'patient' check (kind in ('patient', 'staff')),
  -- the engine's working memory (contact, patient, last offered slots, pending reminder, ledger, notes)
  state                  jsonb not null default '{}'::jsonb,
  mode                   text not null default 'agent' check (mode in ('agent', 'human')),
  assigned_user_id       uuid,
  human_since            timestamptz,
  human_last_activity_at timestamptz,
  human_reason           text,
  needs_attention        boolean not null default false,
  attention_reason       text,
  attention_at           timestamptz,
  urgency                text check (urgency in ('emergency', 'urgent')),   -- the last red flag, until resolved
  questions_open         int not null default 0,
  unread_count           int not null default 0,
  last_message_at        timestamptz,
  last_inbound_at        timestamptz,
  last_outbound_at       timestamptz,
  last_message_preview   text,
  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now(),
  unique (tenant_id, wa_id)
);
create index conversations_inbox_idx on clinic.conversations (tenant_id, last_message_at desc);

create table clinic.messages (
  id              bigint generated always as identity primary key,
  tenant_id       uuid not null references clinic.tenants(id) on delete cascade,
  conversation_id bigint references clinic.conversations(id) on delete cascade,
  wa_id           text not null,
  direction       text not null check (direction in ('inbound', 'outbound')),
  sender          text not null check (sender in ('patient', 'agent', 'staff', 'system')),
  staff_user_id   uuid,
  kind            text not null default 'text',
  body            text,
  media_url       text,
  media_mime      text,
  external_id     text,
  status          text not null default 'received'
                  check (status in ('received', 'queued', 'sending', 'sent', 'delivered', 'read', 'failed', 'cancelled')),
  error           text,
  run_id          text,
  meta            jsonb not null default '{}'::jsonb,
  raw_payload     jsonb,
  created_at      timestamptz not null default now(),
  sent_at         timestamptz
);
create unique index messages_external_uidx on clinic.messages (tenant_id, external_id) where external_id is not null;
create index messages_thread_idx on clinic.messages (tenant_id, wa_id, created_at desc);
create index messages_conversation_idx on clinic.messages (conversation_id, created_at desc);

create table clinic.outbox (
  id           bigint generated always as identity primary key,
  tenant_id    uuid not null references clinic.tenants(id) on delete cascade,
  channel_id   uuid references clinic.whatsapp_channels(id) on delete set null,
  to_jid       text not null,
  wa_id        text,
  message_id   bigint references clinic.messages(id) on delete set null,
  purpose      text not null check (purpose ~ '^[a-z_]{2,40}$'),
  template_key text,                     -- the approved template it maps to on the Cloud API
  kind         text not null default 'text' check (kind in ('text', 'image', 'document', 'location')),
  body         text,
  media_url    text,
  media_mime   text,
  file_name    text,
  meta         jsonb not null default '{}'::jsonb,
  status       text not null default 'queued' check (status in ('queued', 'sending', 'sent', 'failed', 'cancelled')),
  attempts     int not null default 0,
  last_error   text,
  not_before   timestamptz not null default now(),
  claimed_at   timestamptz,
  claimed_by   text,
  sent_at      timestamptz,
  external_id  text,
  created_by   uuid,
  created_at   timestamptz not null default now()
);
create index outbox_pending_idx on clinic.outbox (not_before) where status in ('queued', 'sending');
create index outbox_tenant_idx on clinic.outbox (tenant_id, created_at desc);

create table clinic.inbound_buffer (
  id                bigint generated always as identity primary key,
  tenant_id         uuid not null references clinic.tenants(id) on delete cascade,
  wa_id             text not null,
  message_text      text,
  has_location      boolean not null default false,
  location          jsonb,
  media_pending     boolean not null default false,
  received_at       timestamptz not null default now(),
  claimed_by_run_id text
);
create index inbound_buffer_wa_idx on clinic.inbound_buffer (tenant_id, wa_id, claimed_by_run_id);

create table clinic.conversation_locks (
  tenant_id  uuid not null references clinic.tenants(id) on delete cascade,
  wa_id      text not null,
  run_id     text not null,
  locked_at  timestamptz not null default now(),
  expires_at timestamptz not null,
  primary key (tenant_id, wa_id)
);

create table clinic.team_questions (
  id               bigint generated always as identity primary key,
  tenant_id        uuid not null references clinic.tenants(id) on delete cascade,
  conversation_id  bigint not null references clinic.conversations(id) on delete cascade,
  wa_id            text not null,
  question         text not null,
  run_id           text,
  asked_at         timestamptz not null default now(),
  status           text not null default 'open' check (status in ('open', 'answered', 'dismissed')),
  answer_kind      text check (answer_kind in ('yes', 'no', 'text')),
  answer           text,
  answered_by      uuid,
  answered_by_name text,
  answered_at      timestamptz,
  told_at          timestamptz
);
create index team_questions_chat_idx on clinic.team_questions (tenant_id, wa_id, asked_at desc);
create index team_questions_open_idx on clinic.team_questions (tenant_id, status) where status = 'open';

create table clinic.agent_pauses (
  id               bigint generated always as identity primary key,
  tenant_id        uuid not null references clinic.tenants(id) on delete cascade,
  started_at       timestamptz not null default now(),
  ended_at         timestamptz,
  started_by       uuid,
  ended_by         uuid,
  reason           text,
  notify_on_resume boolean not null default true,
  contacts_count   int not null default 0,
  notified_count   int not null default 0
);
alter table clinic.tenants add constraint tenants_current_pause_fk foreign key (current_pause_id)
  references clinic.agent_pauses(id) on delete set null;

create table clinic.pause_contacts (
  pause_id           bigint not null references clinic.agent_pauses(id) on delete cascade,
  tenant_id          uuid not null references clinic.tenants(id) on delete cascade,
  wa_id              text not null,
  reply_to           text,
  channel_id         uuid references clinic.whatsapp_channels(id) on delete set null,
  contact_id         bigint references clinic.contacts(id) on delete set null,
  first_message_at   timestamptz not null default now(),
  last_message_at    timestamptz not null default now(),
  messages_count     int not null default 1,
  apologized_at      timestamptz,
  resume_notified_at timestamptz,
  primary key (pause_id, wa_id)
);

create table clinic.agent_events (
  id                bigint generated always as identity primary key,
  tenant_id         uuid not null references clinic.tenants(id) on delete cascade,
  wa_id             text,
  run_id            text,
  stage             text,
  booking_stage     text,
  tool_action       text,
  qa_passed         boolean,
  repair_used       boolean,
  llm_calls         int,
  duration_total_ms int,
  duration_llm_ms   int,
  prompt_tokens     int,
  completion_tokens int,
  cached_tokens     int,
  input             jsonb,
  output            jsonb,
  created_at        timestamptz not null default now()
);
create index agent_events_tenant_idx on clinic.agent_events (tenant_id, created_at desc);

do $$
declare t text;
begin
  foreach t in array array['whatsapp_channels', 'contacts', 'conversations'] loop
    execute format('create trigger %I before update on clinic.%I for each row execute function clinic.touch_updated_at()', t || '_touch', t);
  end loop;
  execute 'create trigger whatsapp_channels_audit after insert or update or delete on clinic.whatsapp_channels
             for each row execute function clinic.audit_change()';
end $$;

-- ---------------------------------------------------------------------
-- Helpers
-- ---------------------------------------------------------------------
create or replace function clinic.contact_language(p_tenant uuid, p_wa text)
returns text language sql stable as $$
  select coalesce(nullif(c.state ->> 'last_language', ''), co.language, t.default_language, 'ar')
    from clinic.tenants t
    left join clinic.conversations c on c.tenant_id = t.id and c.wa_id = p_wa
    left join clinic.contacts co on co.id = c.contact_id
   where t.id = p_tenant
$$;

-- the Test Runner's pretend numbers: 200000000001 … 200000000099
create or replace function clinic.is_test_number(p_wa text)
returns boolean language sql immutable as $$
  select coalesce(p_wa ~ '^20000000000[0-9]$|^2000000000[1-9][0-9]$', false)
$$;

-- a contact the clinic can write to (also one added from the dashboard by phone)
create or replace function clinic.ensure_contact(p_tenant uuid, p_phone text, p_name text default null)
returns clinic.contacts language plpgsql as $$
declare
  v_phone text := clinic.wa_phone(p_phone, (select country from clinic.tenants where id = p_tenant));
  v_id    bigint;
  c       clinic.contacts%rowtype;
begin
  if v_phone is null then return null; end if;
  select ci.contact_id into v_id from clinic.contact_identities ci
   where ci.tenant_id = p_tenant and ci.kind = 'phone' and ci.value = v_phone;
  if v_id is null then
    insert into clinic.contacts (tenant_id, wa_id, reply_to, phone, full_name)
    values (p_tenant, v_phone, v_phone, v_phone, nullif(btrim(coalesce(p_name, '')), ''))
    on conflict (tenant_id, wa_id) do update set last_seen_at = clinic.contacts.last_seen_at
    returning id into v_id;
    insert into clinic.contact_identities (tenant_id, kind, value, contact_id)
    values (p_tenant, 'phone', v_phone, v_id) on conflict do nothing;
  end if;
  select * into c from clinic.contacts where id = v_id;
  return c;
end $$;

create or replace function clinic.ensure_conversation(p_tenant uuid, p_wa text)
returns clinic.conversations language plpgsql as $$
declare
  conv clinic.conversations%rowtype;
  co   clinic.contacts%rowtype;
begin
  select * into conv from clinic.conversations where tenant_id = p_tenant and wa_id = p_wa;
  if found then return conv; end if;
  select * into co from clinic.contacts where tenant_id = p_tenant and wa_id = p_wa;
  if not found then return null; end if;
  insert into clinic.conversations (tenant_id, contact_id, wa_id, state)
  values (p_tenant, co.id, co.wa_id, jsonb_build_object('contact', jsonb_build_object('reply_to', co.reply_to, 'phone_hidden', co.phone_hidden)))
  on conflict (tenant_id, wa_id) do update set updated_at = now()
  returning * into conv;
  return conv;
end $$;

-- ---------------------------------------------------------------------
-- The outbox
-- ---------------------------------------------------------------------
create or replace function clinic.queue_message(
  p_tenant uuid, p_wa text, p_purpose text, p_body text,
  p_kind text default 'text', p_media_url text default null, p_media_mime text default null,
  p_file_name text default null, p_sender text default 'system', p_user uuid default null,
  p_not_before timestamptz default now(), p_template text default null, p_meta jsonb default '{}'::jsonb)
returns jsonb language plpgsql as $$
declare
  conv  clinic.conversations%rowtype;
  co    clinic.contacts%rowtype;
  v_ch  uuid;
  v_to  text;
  v_msg bigint;
  v_out bigint;
begin
  conv := clinic.ensure_conversation(p_tenant, p_wa);
  if conv.id is null then
    return jsonb_build_object('skipped', true, 'reason', 'no_contact');
  end if;
  select * into co from clinic.contacts where id = conv.contact_id;
  if coalesce(co.is_blocked, false) then return jsonb_build_object('skipped', true, 'reason', 'blocked'); end if;
  select ch.id into v_ch
    from clinic.whatsapp_channels ch
   where ch.tenant_id = p_tenant and ch.is_active
   order by (ch.id::text = conv.state -> 'contact' ->> 'channel_id') desc, ch.created_at
   limit 1;
  v_to := coalesce(nullif(conv.state -> 'contact' ->> 'reply_to', ''), co.reply_to, p_wa);

  insert into clinic.messages (tenant_id, conversation_id, wa_id, direction, sender, staff_user_id, kind, body,
                               media_url, media_mime, status, meta)
  values (p_tenant, conv.id, p_wa, 'outbound', p_sender, p_user, p_kind, p_body, p_media_url, p_media_mime, 'queued',
          jsonb_build_object('purpose', p_purpose) || coalesce(p_meta, '{}'::jsonb))
  returning id into v_msg;

  insert into clinic.outbox (tenant_id, channel_id, to_jid, wa_id, message_id, purpose, template_key, kind, body, media_url,
                             media_mime, file_name, meta, not_before, created_by)
  values (p_tenant, v_ch, v_to, p_wa, v_msg, p_purpose, p_template, p_kind, p_body, p_media_url, p_media_mime, p_file_name,
          coalesce(p_meta, '{}'::jsonb), p_not_before, p_user)
  returning id into v_out;

  update clinic.conversations
     set last_message_at = greatest(coalesce(last_message_at, now()), now()),
         last_message_preview = left(coalesce(p_body, '[' || p_kind || ']'), 160)
   where id = conv.id;
  return jsonb_build_object('outbox_id', v_out, 'message_id', v_msg);
end $$;

-- a message to a team member's own WhatsApp (an emergency, a doctor's alert) — not a chat
create or replace function clinic.queue_ops_message(p_tenant uuid, p_phone text, p_purpose text, p_body text)
returns boolean language plpgsql as $$
declare
  v_ch uuid;
  v_to text := clinic.wa_phone(p_phone, (select country from clinic.tenants where id = p_tenant));
begin
  if v_to is null or coalesce(btrim(p_body), '') = '' then return false; end if;
  select id into v_ch from clinic.whatsapp_channels where tenant_id = p_tenant and is_active order by created_at limit 1;
  insert into clinic.outbox (tenant_id, channel_id, to_jid, purpose, body) values (p_tenant, v_ch, v_to, p_purpose, p_body);
  return true;
end $$;

create or replace function clinic.outbox_claim(p_limit int default 20, p_worker text default 'n8n')
returns jsonb language plpgsql as $$
declare v jsonb;
begin
  update clinic.outbox o
     set status = 'failed', last_error = 'No WhatsApp number is connected for this clinic.'
   where o.status = 'queued' and o.not_before <= now()
     and not exists (select 1 from clinic.whatsapp_channels ch where ch.id = o.channel_id and ch.is_active);
  update clinic.messages m set status = 'failed', error = 'No WhatsApp number is connected.'
    from clinic.outbox o
   where o.message_id = m.id and o.status = 'failed' and m.status = 'queued';

  with c as (
    select o.id from clinic.outbox o
     where o.status = 'queued' and o.not_before <= now()
     order by o.not_before, o.id
     for update skip locked
     limit greatest(1, least(p_limit, 100))
  ), u as (
    update clinic.outbox o
       set status = 'sending', claimed_at = now(), claimed_by = p_worker, attempts = o.attempts + 1
      from c where o.id = c.id
    returning o.*
  )
  select coalesce(jsonb_agg(jsonb_build_object(
           'id', u.id, 'tenant_id', u.tenant_id, 'wa_id', u.wa_id, 'to', u.to_jid, 'purpose', u.purpose,
           'kind', u.kind, 'body', u.body, 'media_url', u.media_url, 'media_mime', u.media_mime,
           'file_name', u.file_name, 'meta', u.meta, 'attempts', u.attempts,
           'channel', jsonb_build_object('id', ch.id, 'provider', ch.provider, 'base_url', rtrim(ch.base_url, '/'),
                                         'instance', ch.instance_name, 'api_key', ch.api_key))
         order by u.id), '[]'::jsonb)
    into v
    from u join clinic.whatsapp_channels ch on ch.id = u.channel_id;

  update clinic.messages m set status = 'sending'
    from clinic.outbox o
   where o.message_id = m.id and o.status = 'sending' and m.status = 'queued';
  return v;
end $$;

create or replace function clinic.outbox_result(p jsonb)
returns jsonb language plpgsql as $$
declare
  o     clinic.outbox%rowtype;
  v_ok  boolean := coalesce((p ->> 'ok')::boolean, false);
  v_fin boolean;
begin
  select * into o from clinic.outbox where id = (p ->> 'id')::bigint for update;
  if not found then return jsonb_build_object('updated', false); end if;
  v_fin := v_ok or o.attempts >= 3;
  update clinic.outbox
     set status = case when v_ok then 'sent' when v_fin then 'failed' else 'queued' end,
         sent_at = case when v_ok then now() end,
         external_id = nullif(p ->> 'external_id', ''),
         last_error = case when v_ok then null else left(coalesce(p ->> 'error', 'send failed'), 500) end,
         not_before = case when v_ok or v_fin then not_before else now() + make_interval(secs => 30 * o.attempts) end
   where id = o.id;
  if o.message_id is not null then
    update clinic.messages
       set status = case when v_ok then 'sent' when v_fin then 'failed' else 'queued' end,
           external_id = coalesce(nullif(p ->> 'external_id', ''), external_id),
           sent_at = case when v_ok then now() else sent_at end,
           error = case when v_ok then null else left(coalesce(p ->> 'error', 'send failed'), 500) end
     where id = o.message_id
       and not exists (select 1 from clinic.messages x
                        where x.tenant_id = o.tenant_id and x.external_id = nullif(p ->> 'external_id', '') and x.id <> o.message_id);
  end if;
  if v_ok and o.wa_id is not null then
    update clinic.conversations set last_outbound_at = now() where tenant_id = o.tenant_id and wa_id = o.wa_id;
  end if;
  return jsonb_build_object('updated', true, 'final', v_fin, 'ok', v_ok);
end $$;

-- ---------------------------------------------------------------------
-- Intake: one inbound WhatsApp message
-- ---------------------------------------------------------------------
create or replace function clinic.staff_by_phone(p_tenant uuid, p_phone text)
returns jsonb language sql stable as $$
  select coalesce(
    (select jsonb_build_object('kind', 'member', 'user_id', m.user_id, 'role', m.role, 'doctor_id', m.doctor_id,
                               'clinical', m.clinical, 'name', coalesce(m.display_name, m.email))
       from clinic.tenant_members m
      where m.tenant_id = p_tenant and p_phone is not null and m.phone = p_phone
      order by (m.role = 'owner') desc limit 1),
    (select jsonb_build_object('kind', 'doctor', 'user_id', d.user_id, 'role', 'doctor', 'doctor_id', d.id,
                               'clinical', true, 'name', clinic.doctor_label(d.id, 'ar'))
       from clinic.doctors d
      where d.tenant_id = p_tenant and d.is_active and p_phone is not null and clinic.wa_phone(d.ops_whatsapp) = p_phone
      limit 1))
$$;

create or replace function clinic.intake(p jsonb)
returns jsonb language plpgsql as $$
declare
  ch        clinic.whatsapp_channels%rowtype;
  t         clinic.tenants%rowtype;
  s         jsonb;
  co        clinic.contacts%rowtype;
  conv      clinic.conversations%rowtype;
  v_phone   text := nullif(clinic.digits(p ->> 'phone'), '');
  v_lid     text := nullif(clinic.digits(p ->> 'lid'), '');
  v_wa      text := nullif(btrim(p ->> 'wa_id'), '');
  v_reply   text := nullif(btrim(p ->> 'reply_to'), '');
  v_text    text := coalesce(p ->> 'text', '');
  v_cid     bigint;
  v_msg     bigint;
  v_buf     bigint;
  v_lang    text;
  v_release int;
  v_pc      clinic.pause_contacts%rowtype;
  v_pause   bigint;
  v_send    boolean := false;
  v_apology text;
  base      jsonb;
  v_q       clinic.messages%rowtype;
  v_quote   text;
  v_staff   jsonb;
begin
  select * into ch from clinic.whatsapp_channels
   where provider = coalesce(nullif(p ->> 'provider', ''), 'evolution')
     and instance_name = p ->> 'instance' and is_active;
  if not found then return jsonb_build_object('route', 'ignore', 'reason', 'unknown_channel'); end if;
  if coalesce(p ->> 'token', '') <> ch.webhook_token then
    return jsonb_build_object('route', 'ignore', 'reason', 'bad_token');
  end if;
  select * into t from clinic.tenants where id = ch.tenant_id;
  if t.status in ('suspended', 'cancelled') then
    return jsonb_build_object('route', 'ignore', 'reason', 'tenant_' || t.status);
  end if;
  update clinic.whatsapp_channels
     set last_inbound_at = now(), status = 'connected', connected_at = coalesce(connected_at, now())
   where id = ch.id;
  s := clinic.merged_settings(t.settings);

  base := jsonb_build_object(
    'tenant_id', t.id, 'tenant_slug', t.slug, 'tenant_status', t.status, 'timezone', t.timezone,
    'channel', jsonb_build_object('id', ch.id, 'provider', ch.provider, 'base_url', rtrim(ch.base_url, '/'),
                                  'instance', ch.instance_name, 'api_key', ch.api_key));

  if coalesce((p ->> 'from_me')::boolean, false) then
    return base || jsonb_build_object('route', 'from_me');
  end if;
  if v_wa is null then return base || jsonb_build_object('route', 'ignore', 'reason', 'no_sender'); end if;

  -- the team answered a question the agent asked: the agent passes it on
  if p ->> 'kind' = 'team_answer' then
    select * into conv from clinic.conversations where tenant_id = t.id and wa_id = v_wa;
    if not found or not exists (select 1 from clinic.team_questions q
                                 where q.tenant_id = t.id and q.wa_id = v_wa and q.status = 'answered' and q.told_at is null) then
      return base || jsonb_build_object('route', 'ignore', 'reason', 'no_new_answer');
    end if;
    select * into co from clinic.contacts where id = conv.contact_id;
    base := base || jsonb_build_object('contact_id', co.id, 'conversation_id', conv.id, 'wa_id', co.wa_id,
                                       'reply_to', co.reply_to, 'phone_hidden', co.phone_hidden, 'team_answer', true);
    if co.is_blocked or conv.mode = 'human' or not t.agent_enabled then
      return base || jsonb_build_object('route', 'ignore', 'reason', 'agent_not_answering');
    end if;
    insert into clinic.inbound_buffer (tenant_id, wa_id, message_text) values (t.id, co.wa_id, '') returning id into v_buf;
    return base || jsonb_build_object('route', 'agent', 'buffer_id', v_buf);
  end if;

  -- the contact, by any identity -------------------------------------------
  select ci.contact_id into v_cid
    from clinic.contact_identities ci
   where ci.tenant_id = t.id
     and ((ci.kind = 'phone' and ci.value = v_phone) or (ci.kind = 'lid' and ci.value = v_lid))
   order by (ci.kind = 'phone') desc
   limit 1;
  if v_cid is null then
    select id into v_cid from clinic.contacts where tenant_id = t.id and wa_id = v_wa;
  end if;
  if v_cid is null then
    insert into clinic.contacts (tenant_id, wa_id, reply_to, phone, lid, phone_hidden, display_name)
    values (t.id, v_wa, coalesce(v_reply, v_wa), v_phone, v_lid, v_phone is null, nullif(btrim(p ->> 'push_name'), ''))
    on conflict (tenant_id, wa_id) do update set last_seen_at = now()
    returning id into v_cid;
  end if;
  update clinic.contacts c
     set phone        = coalesce(c.phone, v_phone),
         lid          = coalesce(c.lid, v_lid),
         phone_hidden = coalesce(c.phone, v_phone) is null,
         reply_to     = case when v_phone is not null then v_phone else coalesce(v_reply, c.reply_to) end,
         display_name = coalesce(nullif(btrim(p ->> 'push_name'), ''), c.display_name),
         last_seen_at = now()
   where c.id = v_cid
  returning * into co;
  if v_phone is not null then
    insert into clinic.contact_identities (tenant_id, kind, value, contact_id) values (t.id, 'phone', v_phone, v_cid) on conflict do nothing;
  end if;
  if v_lid is not null then
    insert into clinic.contact_identities (tenant_id, kind, value, contact_id) values (t.id, 'lid', v_lid, v_cid) on conflict do nothing;
  end if;

  -- a swipe-reply: what they replied to, in words
  if jsonb_typeof(p -> 'quoted') = 'object' then
    select * into v_q from clinic.messages m
     where m.tenant_id = t.id and m.external_id = nullif(p -> 'quoted' ->> 'id', '') limit 1;
    v_quote := case
      when v_q.id is null then
        case when coalesce(p -> 'quoted' ->> 'text', '') <> '' then 'replying to: "' || left(p -> 'quoted' ->> 'text', 300) || '"'
             when coalesce(p -> 'quoted' ->> 'kind', '') <> '' then 'replying to a ' || (p -> 'quoted' ->> 'kind') end
      when v_q.direction = 'inbound' then 'replying to their own earlier message: "' || left(coalesce(v_q.body, '[' || v_q.kind || ']'), 300) || '"'
      when v_q.meta ->> 'purpose' in ('reminder', 'delay_notice', 'delay_followup', 'session_cancelled', 'waitlist_offer', 'booking_moved')
        then 'replying to the clinic''s ' || replace(v_q.meta ->> 'purpose', '_', ' ') || ': "' || left(coalesce(v_q.body, ''), 300) || '"'
      else 'replying to ' || case v_q.sender when 'agent' then 'your message' when 'staff' then 'the team''s message' else 'the automatic message' end
           || ': "' || left(coalesce(v_q.body, ''), 300) || '"' end;
  end if;

  v_staff := case when v_phone is not null and not coalesce((p ->> 'test_run')::boolean, false)
                  then clinic.staff_by_phone(t.id, v_phone) end;

  -- the message, exactly once (Evolution can deliver twice)
  insert into clinic.messages (tenant_id, wa_id, direction, sender, kind, body, external_id, raw_payload, meta)
  values (t.id, co.wa_id, 'inbound', case when v_staff is not null then 'staff' else 'patient' end,
          coalesce(nullif(p ->> 'message_type', ''), 'text'), v_text,
          nullif(p ->> 'external_id', ''), p -> 'raw',
          jsonb_strip_nulls(jsonb_build_object('location', p -> 'location', 'push_name', p ->> 'push_name',
                                               'channel_id', ch.id, 'reply_to', v_quote,
                                               'staff', case when v_staff is not null then true end)))
  on conflict (tenant_id, external_id) where external_id is not null do nothing
  returning id into v_msg;
  if v_msg is null then return base || jsonb_build_object('route', 'duplicate', 'wa_id', co.wa_id); end if;

  insert into clinic.conversations as c
    (tenant_id, contact_id, wa_id, kind, state, last_message_at, last_inbound_at, unread_count, last_message_preview)
  values (t.id, v_cid, co.wa_id, case when v_staff is not null then 'staff' else 'patient' end,
          jsonb_build_object('contact', jsonb_build_object('reply_to', co.reply_to, 'phone_hidden', co.phone_hidden,
                                                           'channel_id', ch.id)),
          now(), now(), 1, left(v_text, 160))
  on conflict (tenant_id, wa_id) do update
    set state = c.state || jsonb_build_object('contact', coalesce(c.state -> 'contact', '{}'::jsonb) || (excluded.state -> 'contact')),
        contact_id = coalesce(c.contact_id, excluded.contact_id),
        kind = excluded.kind,
        last_message_at = now(), last_inbound_at = now(),
        unread_count = c.unread_count + 1,
        last_message_preview = excluded.last_message_preview
  returning * into conv;
  update clinic.messages set conversation_id = conv.id where id = v_msg;

  base := base || jsonb_build_object('contact_id', co.id, 'conversation_id', conv.id, 'message_id', v_msg,
                                     'wa_id', co.wa_id, 'reply_to', co.reply_to, 'phone_hidden', co.phone_hidden);

  if co.is_blocked then return base || jsonb_build_object('route', 'ignore', 'reason', 'blocked'); end if;

  -- a team member's own number: their commands go to the staff assistant
  if v_staff is not null then
    if conv.mode = 'human' then return base || jsonb_build_object('route', 'human'); end if;
    insert into clinic.inbound_buffer (tenant_id, wa_id, message_text, media_pending)
    values (t.id, co.wa_id, case when v_quote is not null then '[' || v_quote || '] ' || v_text else v_text end,
            coalesce(jsonb_typeof(p -> 'media') = 'object', false))
    returning id into v_buf;
    return base || jsonb_build_object('route', 'staff', 'buffer_id', v_buf, 'staff', v_staff);
  end if;

  -- a person took over: the agent stays quiet unless the person went idle
  if conv.mode = 'human' then
    v_release := coalesce((s ->> 'human_auto_release_minutes')::int, 0);
    if v_release > 0 and coalesce(conv.human_last_activity_at, conv.human_since, now())
                         < now() - make_interval(mins => v_release) then
      update clinic.conversations
         set mode = 'agent', assigned_user_id = null, human_since = null, human_reason = null,
             state = state || jsonb_build_object('handback', jsonb_build_object('at', now(), 'by', 'auto', 'human_since', conv.human_since))
       where id = conv.id;
    else
      return base || jsonb_build_object('route', 'human');
    end if;
  end if;

  -- the agent is OFF: one apology, remembered for "we're back"
  if not t.agent_enabled then
    v_pause := t.current_pause_id;
    if v_pause is null then
      insert into clinic.agent_pauses (tenant_id, reason) values (t.id, 'switched off') returning id into v_pause;
      update clinic.tenants set current_pause_id = v_pause where id = t.id;
    end if;
    insert into clinic.pause_contacts as pc (pause_id, tenant_id, wa_id, reply_to, channel_id, contact_id)
    values (v_pause, t.id, co.wa_id, co.reply_to, ch.id, co.id)
    on conflict (pause_id, wa_id) do update
      set last_message_at = now(), messages_count = pc.messages_count + 1, reply_to = excluded.reply_to, channel_id = excluded.channel_id
    returning * into v_pc;
    if v_pc.apologized_at is null then
      update clinic.pause_contacts set apologized_at = now() where pause_id = v_pc.pause_id and wa_id = v_pc.wa_id;
      update clinic.agent_pauses set contacts_count = contacts_count + 1 where id = v_pause;
      v_lang := case when v_text ~ '[ء-ي]' then 'ar' when v_text ~ '[A-Za-z]' then 'en' else coalesce(co.language, t.default_language) end;
      v_apology := clinic.render_template(s -> 'templates' ->> ('pause_apology_' || v_lang),
                                          jsonb_build_object('name', clinic.first_name(co.full_name, co.display_name)));
      v_send := true;
    end if;
    return base || jsonb_build_object('route', 'paused', 'send_apology', v_send, 'apology_text', v_apology, 'pause_id', v_pause);
  end if;

  -- still onboarding: only the clinic's test numbers (and the Test Runner) reach the agent
  if t.status = 'onboarding'
     and not (coalesce((p ->> 'test_run')::boolean, false) and clinic.is_test_number(co.wa_id))
     and not (coalesce(s -> 'test_numbers', '[]'::jsonb) ? co.wa_id
              or (co.phone is not null and coalesce(s -> 'test_numbers', '[]'::jsonb) ? co.phone)) then
    return base || jsonb_build_object('route', 'not_live');
  end if;

  insert into clinic.inbound_buffer (tenant_id, wa_id, message_text, has_location, location, media_pending)
  values (t.id, co.wa_id, case when v_quote is not null then '[' || v_quote || '] ' || v_text else v_text end,
          coalesce((p ->> 'has_location')::boolean, false), p -> 'location',
          coalesce(jsonb_typeof(p -> 'media') = 'object', false) and not coalesce((p ->> 'test_run')::boolean, false))
  returning id into v_buf;
  return base || jsonb_build_object('route', 'agent', 'buffer_id', v_buf);
end $$;

-- a message the clinic typed on the phone itself (fromMe), a few seconds later
create or replace function clinic.log_phone_reply(p jsonb)
returns jsonb language plpgsql as $$
declare
  ch     clinic.whatsapp_channels%rowtype;
  t      clinic.tenants%rowtype;
  s      jsonb;
  v_wa   text;
  v_cid  bigint;
  v_conv bigint;
  v_text text := coalesce(p ->> 'text', '');
  v_msg  bigint;
  v_take boolean;
begin
  select * into ch from clinic.whatsapp_channels
   where provider = coalesce(nullif(p ->> 'provider', ''), 'evolution') and instance_name = p ->> 'instance' and is_active;
  if not found or coalesce(p ->> 'token', '') <> ch.webhook_token then
    return jsonb_build_object('logged', false, 'reason', 'unknown_channel');
  end if;
  select * into t from clinic.tenants where id = ch.tenant_id;
  s := clinic.merged_settings(t.settings);
  v_take := coalesce((s ->> 'phone_reply_takes_over')::boolean, true);
  if nullif(p ->> 'external_id', '') is not null
     and exists (select 1 from clinic.messages where tenant_id = t.id and external_id = p ->> 'external_id') then
    return jsonb_build_object('logged', false, 'reason', 'already_logged');
  end if;
  select ci.contact_id into v_cid
    from clinic.contact_identities ci
   where ci.tenant_id = t.id
     and ((ci.kind = 'phone' and ci.value = nullif(clinic.digits(p ->> 'phone'), ''))
       or (ci.kind = 'lid' and ci.value = nullif(clinic.digits(p ->> 'lid'), '')))
   limit 1;
  if v_cid is null then select id into v_cid from clinic.contacts where tenant_id = t.id and wa_id = p ->> 'wa_id'; end if;
  if v_cid is null then return jsonb_build_object('logged', false, 'reason', 'unknown_contact'); end if;
  select wa_id into v_wa from clinic.contacts where id = v_cid;
  if exists (select 1 from clinic.messages
              where tenant_id = t.id and wa_id = v_wa and direction = 'outbound'
                and created_at > now() - interval '3 minutes'
                and btrim(coalesce(body, '')) = btrim(v_text) and v_text <> '') then
    return jsonb_build_object('logged', false, 'reason', 'engine_echo');
  end if;
  select id into v_conv from clinic.conversations where tenant_id = t.id and wa_id = v_wa;
  insert into clinic.messages (tenant_id, conversation_id, wa_id, direction, sender, kind, body, external_id, status, sent_at, meta)
  values (t.id, v_conv, v_wa, 'outbound', 'staff', coalesce(nullif(p ->> 'message_type', ''), 'text'), v_text,
          nullif(p ->> 'external_id', ''), 'sent', now(), jsonb_build_object('via', 'phone'))
  on conflict (tenant_id, external_id) where external_id is not null do nothing
  returning id into v_msg;
  if v_msg is null then return jsonb_build_object('logged', false, 'reason', 'already_logged'); end if;
  update clinic.conversations
     set last_message_at = now(), last_outbound_at = now(), last_message_preview = left(v_text, 160),
         mode = case when v_take then 'human' else mode end,
         human_since = case when v_take then coalesce(human_since, now()) else human_since end,
         human_last_activity_at = case when v_take then now() else human_last_activity_at end,
         human_reason = case when v_take and mode = 'agent' then 'replied from the phone' else human_reason end
   where id = v_conv;
  return jsonb_build_object('logged', true, 'message_id', v_msg, 'wa_id', v_wa);
end $$;

-- ---------------------------------------------------------------------
-- Debounce window: only the run holding the newest buffered message
-- answers; it takes a lock and drains every buffered message into one turn
-- ---------------------------------------------------------------------
create or replace function clinic.claim_window(p_tenant uuid, p_wa text, p_run text, p_buffer bigint)
returns jsonb language plpgsql as $$
declare
  v_mode    text;
  v_kind    text;
  v_enabled boolean;
  v_newest  bigint;
  v_lock    text;
  r         record;
begin
  select c.mode, c.kind into v_mode, v_kind from clinic.conversations c where c.tenant_id = p_tenant and c.wa_id = p_wa;
  select t.agent_enabled into v_enabled from clinic.tenants t where t.id = p_tenant;
  if v_mode = 'human' or (not v_enabled and v_kind <> 'staff') then
    delete from clinic.inbound_buffer where tenant_id = p_tenant and wa_id = p_wa and claimed_by_run_id is null;
    return jsonb_build_object('is_newest', false, 'lock_acquired', false,
                              'blocked_reason', case when v_mode = 'human' then 'human' else 'paused' end);
  end if;
  select b.id into v_newest
    from clinic.inbound_buffer b
   where b.tenant_id = p_tenant and b.wa_id = p_wa and b.claimed_by_run_id is null
   order by b.received_at desc, b.id desc
   limit 1;
  if v_newest is distinct from p_buffer then
    return jsonb_build_object('is_newest', false, 'lock_acquired', false);
  end if;
  if exists (select 1 from clinic.inbound_buffer b
              where b.tenant_id = p_tenant and b.wa_id = p_wa and b.claimed_by_run_id is null
                and b.media_pending and b.received_at > now() - interval '60 seconds') then
    return jsonb_build_object('is_newest', true, 'lock_acquired', false, 'waiting_for_media', true);
  end if;
  insert into clinic.conversation_locks as l (tenant_id, wa_id, run_id, locked_at, expires_at)
  values (p_tenant, p_wa, p_run, now(), now() + interval '300 seconds')
  on conflict (tenant_id, wa_id) do update
    set run_id = excluded.run_id, locked_at = now(), expires_at = excluded.expires_at
    where l.expires_at < now()
  returning run_id into v_lock;
  if v_lock is null then return jsonb_build_object('is_newest', true, 'lock_acquired', false); end if;

  with drained as (
    update clinic.inbound_buffer b set claimed_by_run_id = p_run
     where b.tenant_id = p_tenant and b.wa_id = p_wa and b.claimed_by_run_id is null
    returning b.message_text, b.has_location, b.location, b.received_at
  )
  select coalesce(string_agg(nullif(d.message_text, ''), E'\n' order by d.received_at), '') as combined_text,
         coalesce(bool_or(d.has_location), false) as has_location,
         (array_remove(array_agg(d.location order by d.received_at desc), null))[1] as location,
         count(*) as buffered_count
    into r from drained d;
  return jsonb_build_object('is_newest', true, 'lock_acquired', true, 'combined_text', r.combined_text,
                            'has_location', r.has_location, 'location', r.location, 'buffered_count', r.buffered_count);
end $$;

-- a photo or voice note, understood: written into the buffer and the message
create or replace function clinic.media_understood(p jsonb)
returns jsonb language plpgsql as $$
declare
  v_text   text := nullif(btrim(p ->> 'text'), '');
  v_marker text := coalesce(p ->> 'marker', '');
  n int;
begin
  update clinic.inbound_buffer b
     set message_text = case when v_text is null then b.message_text
                             when v_marker <> '' and position(v_marker in coalesce(b.message_text, '')) > 0
                             then replace(b.message_text, v_marker, v_text)
                             else concat_ws(' ', nullif(b.message_text, ''), v_text) end,
         media_pending = false
   where b.id = (p ->> 'buffer_id')::bigint;
  get diagnostics n = row_count;
  if v_text is not null and nullif(p ->> 'message_id', '') is not null then
    update clinic.messages
       set meta = meta || jsonb_build_object('understood', v_text, 'understood_by', p ->> 'model')
     where id = (p ->> 'message_id')::bigint;
  end if;
  return jsonb_build_object('buffer_rows', n);
end $$;

-- ---------------------------------------------------------------------
-- The turn's own record: memory, the team's questions, alerts, unlock
-- ---------------------------------------------------------------------
create or replace function clinic.persist_turn(p jsonb)
returns jsonb language plpgsql as $$
declare
  v_tenant  uuid := (p ->> 'tenant_id')::uuid;
  v_wa      text := p ->> 'wa_id';
  v_run     text := p ->> 'run_id';
  v_handoff boolean := coalesce((p -> 'handoff' ->> 'needed')::boolean, false);
  v_final   boolean := coalesce((p ->> 'final')::boolean, false);
  v_take    boolean;
  v_since   timestamptz;
  v_alert   jsonb;
  n_state int; n_unlock int; n_clean int;
begin
  select l.locked_at into v_since from clinic.conversation_locks l
   where l.tenant_id = v_tenant and l.wa_id = v_wa and l.run_id = v_run;
  if not v_final and v_since is not null and exists (
       select 1 from clinic.inbound_buffer b
        where b.tenant_id = v_tenant and b.wa_id = v_wa and b.claimed_by_run_id is null and b.received_at > v_since) then
    update clinic.inbound_buffer set claimed_by_run_id = null
     where tenant_id = v_tenant and wa_id = v_wa and claimed_by_run_id = v_run;
    get diagnostics n_clean = row_count;
    delete from clinic.conversation_locks where tenant_id = v_tenant and wa_id = v_wa and run_id = v_run;
    get diagnostics n_unlock = row_count;
    insert into clinic.agent_events (tenant_id, wa_id, run_id, stage, input, output)
    values (v_tenant, v_wa, v_run, 'superseded', coalesce(p -> 'log_row' -> 'input', '{}'::jsonb),
            jsonb_build_object('dropped_reply', p -> 'log_row' -> 'output' -> 'messages'));
    return jsonb_build_object('superseded', true, 'state_written', 0, 'locks_released', n_unlock, 'buffer_rows_returned', n_clean);
  end if;

  select coalesce((clinic.merged_settings(settings) ->> 'auto_takeover_on_handoff')::boolean, false)
    into v_take from clinic.tenants where id = v_tenant;

  update clinic.conversations c
     set state = coalesce(c.state, '{}'::jsonb)
                 || coalesce(p -> 'state_patch', '{}'::jsonb)
                 || jsonb_build_object('ledger', coalesce(c.state -> 'ledger', '{}'::jsonb) || coalesce(p -> 'ledger_patch', '{}'::jsonb)),
         needs_attention  = c.needs_attention or v_handoff,
         attention_reason = case when v_handoff then nullif(p -> 'handoff' ->> 'reason', '') else c.attention_reason end,
         attention_at     = case when v_handoff then now() else c.attention_at end,
         mode             = case when v_handoff and v_take then 'human' else c.mode end,
         human_since      = case when v_handoff and v_take and c.mode = 'agent' then now() else c.human_since end,
         human_reason     = case when v_handoff and v_take and c.mode = 'agent' then 'the agent asked for a person: ' || coalesce(p -> 'handoff' ->> 'reason', '') else c.human_reason end
   where c.tenant_id = v_tenant and c.wa_id = v_wa;
  get diagnostics n_state = row_count;

  -- the agent asked the doctor or the team
  insert into clinic.team_questions (tenant_id, conversation_id, wa_id, question, run_id)
  select distinct v_tenant, c.id, v_wa, left(btrim(x), 500), v_run
    from clinic.conversations c,
         jsonb_array_elements_text(case jsonb_typeof(p -> 'ask_team') when 'array' then p -> 'ask_team'
                                        when 'string' then jsonb_build_array(p -> 'ask_team') else '[]'::jsonb end) x
   where c.tenant_id = v_tenant and c.wa_id = v_wa and btrim(x) <> ''
     and not exists (select 1 from clinic.team_questions q
                      where q.conversation_id = c.id and q.status = 'open' and q.question = left(btrim(x), 500));
  update clinic.team_questions q set told_at = now()
   where q.tenant_id = v_tenant and q.wa_id = v_wa and q.status = 'answered' and q.told_at is null
     and q.id in (select (x #>> '{}')::bigint from jsonb_array_elements(coalesce(p -> 'answers_told', '[]'::jsonb)) x);
  update clinic.conversations c
     set questions_open = (select count(*) from clinic.team_questions q where q.conversation_id = c.id and q.status = 'open')
   where c.tenant_id = v_tenant and c.wa_id = v_wa;

  -- an urgent or emergency message the engine flagged
  if jsonb_typeof(p -> 'alert') = 'object' then
    v_alert := clinic.raise_alert(p -> 'alert' || jsonb_build_object('tenant_id', v_tenant, 'wa_id', v_wa));
  end if;

  if nullif(p ->> 'language', '') is not null then
    update clinic.contacts set language = p ->> 'language'
     where tenant_id = v_tenant and wa_id = v_wa and language is distinct from p ->> 'language';
  end if;

  insert into clinic.agent_events
    (tenant_id, wa_id, run_id, stage, booking_stage, tool_action, qa_passed, repair_used, llm_calls,
     duration_total_ms, duration_llm_ms, prompt_tokens, completion_tokens, cached_tokens, input, output)
  select v_tenant, v_wa, v_run, coalesce(l ->> 'stage', 'turn_complete'), l ->> 'booking_stage', l ->> 'tool_action',
         (l ->> 'qa_passed')::boolean, (l ->> 'repair_used')::boolean, (l ->> 'llm_calls')::int,
         (l ->> 'duration_total_ms')::int, (l ->> 'duration_llm_ms')::int, (l ->> 'prompt_tokens')::int,
         (l ->> 'completion_tokens')::int, coalesce((l ->> 'cached_tokens')::int, 0),
         coalesce(l -> 'input', '{}'::jsonb), coalesce(l -> 'output', '{}'::jsonb)
    from (select coalesce(p -> 'log_row', '{}'::jsonb) as l) x;

  delete from clinic.conversation_locks where tenant_id = v_tenant and wa_id = v_wa and run_id = v_run;
  get diagnostics n_unlock = row_count;
  delete from clinic.inbound_buffer where tenant_id = v_tenant and wa_id = v_wa and claimed_by_run_id = v_run;
  get diagnostics n_clean = row_count;

  return jsonb_build_object('state_written', n_state, 'locks_released', n_unlock, 'buffer_rows_cleared', n_clean,
                            'alert', v_alert,
                            'mode', (select mode from clinic.conversations where tenant_id = v_tenant and wa_id = v_wa),
                            'agent_enabled', (select agent_enabled from clinic.tenants where id = v_tenant));
end $$;

create or replace function clinic.release_lock(p_tenant uuid, p_wa text, p_run text)
returns void language sql as $$
  delete from clinic.conversation_locks where tenant_id = p_tenant and wa_id = p_wa and run_id = p_run;
$$;

create or replace function clinic.log_outbound(p jsonb)
returns jsonb language plpgsql as $$
declare
  v_tenant uuid := (p ->> 'tenant_id')::uuid;
  v_wa     text := p ->> 'wa_id';
  v_conv   bigint;
  v_id     bigint;
  v_ok     boolean := coalesce((p ->> 'ok')::boolean, true);
begin
  select id into v_conv from clinic.conversations where tenant_id = v_tenant and wa_id = v_wa;
  insert into clinic.messages (tenant_id, conversation_id, wa_id, direction, sender, kind, body, media_url, media_mime,
                               external_id, status, error, run_id, meta, sent_at)
  values (v_tenant, v_conv, v_wa, 'outbound', coalesce(nullif(p ->> 'sender', ''), 'agent'),
          coalesce(nullif(p ->> 'kind', ''), 'text'), p ->> 'body', nullif(p ->> 'media_url', ''),
          nullif(p ->> 'media_mime', ''), nullif(p ->> 'external_id', ''),
          case when v_ok then 'sent' else 'failed' end, nullif(p ->> 'error', ''), p ->> 'run_id',
          coalesce(p -> 'meta', '{}'::jsonb), case when v_ok then now() end)
  on conflict (tenant_id, external_id) where external_id is not null do nothing
  returning id into v_id;
  if v_ok then
    update clinic.conversations
       set last_outbound_at = now(), last_message_at = now(),
           last_message_preview = left(coalesce(p ->> 'body', '[' || coalesce(p ->> 'kind', 'media') || ']'), 160)
     where id = v_conv;
  end if;
  return jsonb_build_object('message_id', v_id);
end $$;

-- ---------------------------------------------------------------------
-- The agent switch, takeover, staff replies, the team's answers
-- ---------------------------------------------------------------------
create or replace function clinic.set_agent_enabled(p_tenant uuid, p_enabled boolean,
                                                     p_reason text default null, p_notify boolean default true)
returns jsonb language plpgsql security definer set search_path = clinic, pg_temp as $$
declare
  t       clinic.tenants%rowtype;
  s       jsonb;
  v_pause bigint;
  pc      record;
  n       int := 0;
  v_lang  text;
  v_uid   uuid := clinic.current_user_id();
begin
  perform clinic.require_role(p_tenant, array['owner', 'manager', 'doctor', 'receptionist', 'nurse']);
  select * into t from clinic.tenants where id = p_tenant for update;
  s := clinic.merged_settings(t.settings);
  if not p_enabled then
    if not t.agent_enabled then return jsonb_build_object('agent_enabled', false, 'changed', false); end if;
    insert into clinic.agent_pauses (tenant_id, started_by, reason, notify_on_resume)
    values (p_tenant, v_uid, nullif(btrim(coalesce(p_reason, '')), ''), coalesce(p_notify, true))
    returning id into v_pause;
    update clinic.tenants set agent_enabled = false, current_pause_id = v_pause where id = p_tenant;
    insert into clinic.audit_log (tenant_id, user_id, action, entity, entity_id, detail)
    values (p_tenant, v_uid, 'agent_off', 'tenants', p_tenant::text, jsonb_build_object('reason', p_reason));
    return jsonb_build_object('agent_enabled', false, 'pause_id', v_pause, 'changed', true);
  end if;
  if t.agent_enabled then return jsonb_build_object('agent_enabled', true, 'changed', false, 'notified', 0); end if;
  v_pause := t.current_pause_id;
  update clinic.agent_pauses set ended_at = now(), ended_by = v_uid where id = v_pause;
  update clinic.tenants set agent_enabled = true, current_pause_id = null where id = p_tenant;
  if coalesce(p_notify, true) and v_pause is not null then
    for pc in select x.*, co.full_name, co.display_name
                from clinic.pause_contacts x left join clinic.contacts co on co.id = x.contact_id
               where x.pause_id = v_pause and x.resume_notified_at is null and not coalesce(co.is_blocked, false)
               order by x.first_message_at loop
      v_lang := clinic.contact_language(p_tenant, pc.wa_id);
      perform clinic.queue_message(p_tenant, pc.wa_id, 'resume_notice',
                                   clinic.render_template(s -> 'templates' ->> ('resume_notice_' || v_lang),
                                                          jsonb_build_object('name', clinic.first_name(pc.full_name, pc.display_name))),
                                   p_not_before => now() + make_interval(secs => n * 3));
      update clinic.pause_contacts set resume_notified_at = now() where pause_id = v_pause and wa_id = pc.wa_id;
      n := n + 1;
    end loop;
  end if;
  update clinic.agent_pauses set notified_count = n where id = v_pause;
  insert into clinic.audit_log (tenant_id, user_id, action, entity, entity_id, detail)
  values (p_tenant, v_uid, 'agent_on', 'tenants', p_tenant::text, jsonb_build_object('notified', n));
  return jsonb_build_object('agent_enabled', true, 'changed', true, 'notified', n);
end $$;

create or replace function clinic.take_over(p_conversation bigint, p_reason text default null)
returns jsonb language plpgsql security definer set search_path = clinic, pg_temp as $$
declare c clinic.conversations%rowtype;
begin
  select * into c from clinic.conversations where id = p_conversation for update;
  if not found then raise exception 'conversation not found'; end if;
  perform clinic.require_role(c.tenant_id, array['owner', 'manager', 'doctor', 'receptionist', 'nurse']);
  update clinic.conversations
     set mode = 'human', assigned_user_id = coalesce(clinic.current_user_id(), assigned_user_id),
         human_since = coalesce(human_since, now()), human_last_activity_at = now(),
         human_reason = coalesce(nullif(p_reason, ''), human_reason, 'taken over from the dashboard'),
         needs_attention = false
   where id = c.id returning * into c;
  delete from clinic.inbound_buffer where tenant_id = c.tenant_id and wa_id = c.wa_id and claimed_by_run_id is null;
  return jsonb_build_object('mode', c.mode, 'human_since', c.human_since);
end $$;

create or replace function clinic.hand_back(p_conversation bigint)
returns jsonb language plpgsql security definer set search_path = clinic, pg_temp as $$
declare c clinic.conversations%rowtype;
begin
  select * into c from clinic.conversations where id = p_conversation for update;
  if not found then raise exception 'conversation not found'; end if;
  perform clinic.require_role(c.tenant_id, array['owner', 'manager', 'doctor', 'receptionist', 'nurse']);
  update clinic.conversations
     set mode = 'agent', assigned_user_id = null, human_reason = null, human_last_activity_at = null,
         state = state || jsonb_build_object('handback', jsonb_build_object(
                   'at', now(), 'by', coalesce(clinic.current_user_id()::text, 'system'), 'human_since', c.human_since)),
         human_since = null
   where id = c.id returning * into c;
  return jsonb_build_object('mode', c.mode);
end $$;

create or replace function clinic.send_staff_message(p_conversation bigint, p_body text, p_kind text default 'text',
                                                      p_media_url text default null, p_media_mime text default null,
                                                      p_file_name text default null)
returns jsonb language plpgsql security definer set search_path = clinic, pg_temp as $$
declare c clinic.conversations%rowtype;
begin
  select * into c from clinic.conversations where id = p_conversation for update;
  if not found then raise exception 'conversation not found'; end if;
  perform clinic.require_role(c.tenant_id, array['owner', 'manager', 'doctor', 'receptionist', 'nurse']);
  if coalesce(btrim(p_body), '') = '' and p_media_url is null then raise exception 'empty message'; end if;
  update clinic.conversations
     set mode = 'human', assigned_user_id = coalesce(assigned_user_id, clinic.current_user_id()),
         human_since = coalesce(human_since, now()), human_last_activity_at = now(),
         human_reason = coalesce(human_reason, 'replied from the dashboard'),
         needs_attention = false, unread_count = 0
   where id = c.id;
  delete from clinic.inbound_buffer where tenant_id = c.tenant_id and wa_id = c.wa_id and claimed_by_run_id is null;
  return clinic.queue_message(c.tenant_id, c.wa_id, 'staff_reply', nullif(btrim(p_body), ''),
                              coalesce(p_kind, 'text'), p_media_url, p_media_mime, p_file_name, 'staff', clinic.current_user_id());
end $$;

create or replace function clinic.mark_read(p_conversation bigint)
returns void language plpgsql security definer set search_path = clinic, pg_temp as $$
declare v_tenant uuid;
begin
  select tenant_id into v_tenant from clinic.conversations where id = p_conversation;
  perform clinic.require_role(v_tenant, array['owner', 'manager', 'doctor', 'receptionist', 'nurse']);
  update clinic.conversations set unread_count = 0 where id = p_conversation;
end $$;

create or replace function clinic.resolve_attention(p_conversation bigint)
returns void language plpgsql security definer set search_path = clinic, pg_temp as $$
declare v_tenant uuid;
begin
  select tenant_id into v_tenant from clinic.conversations where id = p_conversation;
  perform clinic.require_role(v_tenant, array['owner', 'manager', 'doctor', 'receptionist', 'nurse']);
  update clinic.conversations set needs_attention = false, attention_reason = null, urgency = null where id = p_conversation;
end $$;

create or replace function clinic.answer_team_question(p_question bigint, p_kind text, p_answer text default null)
returns jsonb language plpgsql security definer set search_path = clinic, pg_temp as $$
declare
  q      clinic.team_questions%rowtype;
  v_kind text := lower(btrim(coalesce(p_kind, '')));
  v_text text := nullif(btrim(coalesce(p_answer, '')), '');
begin
  select * into q from clinic.team_questions where id = p_question for update;
  if not found then raise exception 'no such question'; end if;
  perform clinic.require_role(q.tenant_id, array['owner', 'manager', 'doctor', 'receptionist', 'nurse']);
  if v_kind not in ('yes', 'no', 'text') then raise exception 'the answer is yes, no or text'; end if;
  if v_kind = 'text' and v_text is null then raise exception 'write the answer'; end if;
  if q.status = 'dismissed' then raise exception 'this question was closed'; end if;
  update clinic.team_questions
     set status = 'answered', answer_kind = v_kind, answer = left(v_text, 1000), told_at = null,
         answered_at = now(), answered_by = clinic.current_user_id(), answered_by_name = clinic.my_name(q.tenant_id)
   where id = q.id;
  update clinic.conversations c
     set questions_open = (select count(*) from clinic.team_questions x where x.conversation_id = c.id and x.status = 'open')
   where c.id = q.conversation_id;
  return jsonb_build_object('ok', true, 'tenant_id', q.tenant_id, 'wa_id', q.wa_id, 'conversation_id', q.conversation_id,
                            'mode', (select mode from clinic.conversations where id = q.conversation_id));
end $$;

create or replace function clinic.dismiss_team_question(p_question bigint)
returns void language plpgsql security definer set search_path = clinic, pg_temp as $$
declare q clinic.team_questions%rowtype;
begin
  select * into q from clinic.team_questions where id = p_question;
  if not found then raise exception 'no such question'; end if;
  perform clinic.require_role(q.tenant_id, array['owner', 'manager', 'doctor', 'receptionist', 'nurse']);
  update clinic.team_questions set status = 'dismissed' where id = q.id and status = 'open';
  update clinic.conversations c
     set questions_open = (select count(*) from clinic.team_questions x where x.conversation_id = c.id and x.status = 'open')
   where c.id = q.conversation_id;
end $$;

-- ---------------------------------------------------------------------
-- The WhatsApp number
-- ---------------------------------------------------------------------
create or replace function clinic.save_channel(p_tenant uuid, p jsonb)
returns jsonb language plpgsql security definer set search_path = clinic, pg_temp as $$
declare
  v_id uuid := nullif(p ->> 'id', '')::uuid;
  c    clinic.whatsapp_channels%rowtype;
begin
  perform clinic.require_role(p_tenant, array['owner', 'manager']);
  if v_id is null then
    insert into clinic.whatsapp_channels (tenant_id, provider, label, phone_number, instance_name, base_url, api_key,
                                          cloud_phone_number_id, cloud_access_token)
    values (p_tenant, coalesce(nullif(p ->> 'provider', ''), 'evolution'), nullif(p ->> 'label', ''),
            nullif(clinic.digits(p ->> 'phone_number'), ''), nullif(btrim(p ->> 'instance_name'), ''),
            nullif(rtrim(btrim(p ->> 'base_url'), '/'), ''), nullif(btrim(p ->> 'api_key'), ''),
            nullif(btrim(p ->> 'cloud_phone_number_id'), ''), nullif(btrim(p ->> 'cloud_access_token'), ''))
    returning * into c;
  else
    update clinic.whatsapp_channels
       set label = coalesce(p ->> 'label', label),
           phone_number = coalesce(nullif(clinic.digits(p ->> 'phone_number'), ''), phone_number),
           instance_name = coalesce(nullif(btrim(p ->> 'instance_name'), ''), instance_name),
           base_url = coalesce(nullif(rtrim(btrim(p ->> 'base_url'), '/'), ''), base_url),
           api_key = coalesce(nullif(btrim(p ->> 'api_key'), ''), api_key),
           cloud_phone_number_id = coalesce(nullif(btrim(p ->> 'cloud_phone_number_id'), ''), cloud_phone_number_id),
           cloud_access_token = coalesce(nullif(btrim(p ->> 'cloud_access_token'), ''), cloud_access_token),
           is_active = coalesce((p ->> 'is_active')::boolean, is_active),
           webhook_token = case when coalesce((p ->> 'rotate_token')::boolean, false) then clinic.random_token() else webhook_token end
     where id = v_id and tenant_id = p_tenant
    returning * into c;
    if not found then raise exception 'number not found'; end if;
  end if;
  return jsonb_build_object('id', c.id, 'instance_name', c.instance_name, 'webhook_token', c.webhook_token,
                            'has_api_key', c.api_key is not null, 'status', c.status);
end $$;

create or replace function clinic.remove_channel(p_channel uuid)
returns jsonb language plpgsql security definer set search_path = clinic, pg_temp as $$
declare
  c       clinic.whatsapp_channels%rowtype;
  v_other uuid;
  n       int := 0;
begin
  select * into c from clinic.whatsapp_channels where id = p_channel;
  if not found then raise exception 'number not found'; end if;
  perform clinic.require_role(c.tenant_id, array['owner', 'manager']);
  select id into v_other from clinic.whatsapp_channels where tenant_id = c.tenant_id and id <> c.id and is_active order by created_at limit 1;
  if v_other is not null then
    update clinic.outbox set channel_id = v_other where channel_id = c.id and status = 'queued';
    get diagnostics n = row_count;
  end if;
  delete from clinic.whatsapp_channels where id = c.id;
  return jsonb_build_object('removed', c.id, 'other_number', v_other is not null, 'queued_moved', n);
end $$;

create or replace function clinic.channel_webhook_token(p_channel uuid)
returns text language plpgsql stable security definer set search_path = clinic, pg_temp as $$
declare c clinic.whatsapp_channels%rowtype;
begin
  select * into c from clinic.whatsapp_channels where id = p_channel;
  if not found then raise exception 'number not found'; end if;
  perform clinic.require_role(c.tenant_id, array['owner', 'manager']);
  return c.webhook_token;
end $$;
