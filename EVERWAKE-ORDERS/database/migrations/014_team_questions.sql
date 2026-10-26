-- =====================================================================
-- Everwake Orders · 014 · the agent asks the team
--
-- Some things only the restaurant knows: whether a dish not on the menu
-- can be made, whether a branch takes half online and half cash, what a
-- charge the branch sets comes to. The agent asks the team the way a new
-- host asks the manager — one clear question — tells the customer it is
-- checking, and carries on with the rest.
--
--   team_questions        each question, its answer and who gave it
--   answer_team_question  the inbox's Yes / No / typed answer; the
--                         dashboard then wakes the agent (Main, intake
--                         'team_answer', 004), which passes the answer on
--   dismiss_team_question the team dealt with it another way
--
-- persist_turn (004) records the agent's question (ask_team) and marks
-- the answers its reply passed on (told_at); turn_context (004) gives the
-- agent the questions of the last day.
-- =====================================================================

create table everwake.team_questions (
  id               bigint generated always as identity primary key,
  tenant_id        uuid not null references everwake.tenants(id) on delete cascade,
  conversation_id  bigint not null references everwake.conversations(id) on delete cascade,
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
  told_at          timestamptz             -- the agent passed the answer on to the customer
);
create index team_questions_chat_idx on everwake.team_questions (tenant_id, wa_id, asked_at desc);
create index team_questions_open_idx on everwake.team_questions (tenant_id, status) where status = 'open';

-- the inbox list shows a chat with a question waiting
alter table everwake.conversations add column questions_open int not null default 0;

create or replace function everwake.sync_questions_open(p_conversation bigint)
returns void language sql security definer set search_path = everwake, pg_temp as $$
  update everwake.conversations c
     set questions_open = (select count(*) from everwake.team_questions q
                            where q.conversation_id = c.id and q.status = 'open')
   where c.id = p_conversation;
$$;

create or replace function everwake.answer_team_question(p_question bigint, p_kind text, p_answer text default null)
returns jsonb language plpgsql security definer set search_path = everwake, pg_temp as $$
declare
  q      everwake.team_questions%rowtype;
  v_kind text := lower(btrim(coalesce(p_kind, '')));
  v_text text := nullif(btrim(coalesce(p_answer, '')), '');
begin
  select * into q from everwake.team_questions where id = p_question for update;
  if not found then raise exception 'no such question'; end if;
  perform everwake.require_role(q.tenant_id, array['owner', 'manager', 'staff']);
  if v_kind not in ('yes', 'no', 'text') then raise exception 'the answer is yes, no or text'; end if;
  if v_kind = 'text' and v_text is null then raise exception 'write the answer'; end if;
  if q.status = 'dismissed' then raise exception 'this question was closed'; end if;

  update everwake.team_questions
     set status = 'answered', answer_kind = v_kind, answer = left(v_text, 1000), told_at = null,
         answered_at = now(), answered_by = everwake.current_user_id(),
         answered_by_name = (select coalesce(m.display_name, m.email) from everwake.tenant_members m
                              where m.tenant_id = q.tenant_id and m.user_id = everwake.current_user_id())
   where id = q.id;
  perform everwake.sync_questions_open(q.conversation_id);

  return jsonb_build_object('ok', true, 'tenant_id', q.tenant_id, 'wa_id', q.wa_id,
                            'conversation_id', q.conversation_id,
                            'mode', (select mode from everwake.conversations where id = q.conversation_id));
end $$;

create or replace function everwake.dismiss_team_question(p_question bigint)
returns void language plpgsql security definer set search_path = everwake, pg_temp as $$
declare q everwake.team_questions%rowtype;
begin
  select * into q from everwake.team_questions where id = p_question;
  if not found then raise exception 'no such question'; end if;
  perform everwake.require_role(q.tenant_id, array['owner', 'manager', 'staff']);
  update everwake.team_questions set status = 'dismissed' where id = q.id and status = 'open';
  perform everwake.sync_questions_open(q.conversation_id);
end $$;

alter table everwake.team_questions enable row level security;
create policy member_read on everwake.team_questions for select to authenticated
  using (tenant_id = any ((select everwake.my_tenant_ids())::uuid[]));
grant select on everwake.team_questions to authenticated;
grant all on everwake.team_questions to service_role;

revoke execute on all functions in schema everwake from public, anon;
grant execute on all functions in schema everwake to service_role;
revoke execute on function everwake.sync_questions_open(bigint) from authenticated;
grant execute on function everwake.answer_team_question(bigint, text, text), everwake.dismiss_team_question(bigint)
  to authenticated;
