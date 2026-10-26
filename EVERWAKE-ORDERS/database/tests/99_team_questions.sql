-- The agent asks the team: the question waits, the answer wakes the agent, the reply passes it on
do $$
declare
  t    uuid := (select id from everwake.tenants where slug = 'nile_grill');
  base jsonb := jsonb_build_object('instance', 'nilegrill', 'token', 'demo-token');
  r jsonb; c jsonb; ctx jsonb; q bigint; conv bigint;
  wa   text := '201300300399';
begin
  r := everwake.intake(base || jsonb_build_object('external_id', 'tq1', 'wa_id', wa, 'phone', wa, 'text', 'ينفع نص كاش ونص أونلاين؟'));
  conv := (r ->> 'conversation_id')::bigint;
  c := everwake.claim_window(t, wa, 'tq-run1', (r ->> 'buffer_id')::bigint);
  assert (c ->> 'lock_acquired')::boolean, c::text;

  -- no answer yet: a wake does nothing
  r := everwake.intake(base || jsonb_build_object('kind', 'team_answer', 'wa_id', wa));
  assert r ->> 'route' = 'ignore' and r ->> 'reason' = 'no_new_answer', r::text;

  -- the agent asks; the same question twice is one question
  c := everwake.persist_turn(jsonb_build_object('tenant_id', t, 'wa_id', wa, 'run_id', 'tq-run1',
         'ask_team', jsonb_build_array('ينفع العميل يدفع نص كاش ونص أونلاين؟', ' ')));
  assert (c ->> 'state_written')::int = 1, c::text;
  c := everwake.persist_turn(jsonb_build_object('tenant_id', t, 'wa_id', wa, 'run_id', 'tq-run-x',
         'ask_team', 'ينفع العميل يدفع نص كاش ونص أونلاين؟'));
  select id into q from everwake.team_questions where wa_id = wa and status = 'open';
  assert (select count(*) from everwake.team_questions where wa_id = wa) = 1;
  assert (select questions_open from everwake.conversations where id = conv) = 1;
  ctx := everwake.turn_context(t, wa);
  assert ctx -> 'team_questions' -> 0 ->> 'status' = 'open', ctx -> 'team_questions';

  -- a typed answer needs words; a yes may carry a note
  begin
    perform everwake.answer_team_question(q, 'text', '  ');
    assert false, 'an empty typed answer is refused';
  exception when raise_exception then null;
  end;
  r := everwake.answer_team_question(q, 'yes', 'بس الأونلاين الأول');
  assert r ->> 'wa_id' = wa and r ->> 'mode' = 'agent', r::text;
  assert (select questions_open from everwake.conversations where id = conv) = 0;

  -- the answer wakes the agent: a turn with no customer message
  r := everwake.intake(base || jsonb_build_object('kind', 'team_answer', 'wa_id', wa));
  assert r ->> 'route' = 'agent' and (r ->> 'team_answer')::boolean, r::text;
  assert (select count(*) from everwake.messages where wa_id = wa) = 1, 'no customer message is invented';
  c := everwake.claim_window(t, wa, 'tq-run2', (r ->> 'buffer_id')::bigint);
  assert (c ->> 'lock_acquired')::boolean and c ->> 'combined_text' = '', c::text;
  ctx := everwake.turn_context(t, wa);
  assert ctx -> 'team_questions' -> 0 ->> 'answer_kind' = 'yes'
     and ctx -> 'team_questions' -> 0 ->> 'answer' = 'بس الأونلاين الأول'
     and not (ctx -> 'team_questions' -> 0 ->> 'told')::boolean, ctx -> 'team_questions';

  -- the reply passed it on: told, and a second wake does nothing
  c := everwake.persist_turn(jsonb_build_object('tenant_id', t, 'wa_id', wa, 'run_id', 'tq-run2',
         'answers_told', jsonb_build_array(q)));
  assert (select told_at is not null from everwake.team_questions where id = q);
  r := everwake.intake(base || jsonb_build_object('kind', 'team_answer', 'wa_id', wa));
  assert r ->> 'reason' = 'no_new_answer', r::text;

  -- a person who took over keeps the chat: the answer does not wake the agent
  c := everwake.persist_turn(jsonb_build_object('tenant_id', t, 'wa_id', wa, 'run_id', 'tq-run3', 'ask_team', 'فيه جمبري جامبو النهارده؟'));
  select id into q from everwake.team_questions where wa_id = wa and status = 'open';
  perform everwake.take_over(conv, null);
  perform everwake.answer_team_question(q, 'no');
  r := everwake.intake(base || jsonb_build_object('kind', 'team_answer', 'wa_id', wa));
  assert r ->> 'reason' = 'agent_not_answering', r::text;

  -- two questions in one turn are two cards
  c := everwake.persist_turn(jsonb_build_object('tenant_id', t, 'wa_id', wa, 'run_id', 'tq-run5',
         'ask_team', jsonb_build_array('فيه فيليه بلطي؟', 'ينفع نسخن الأكل؟')));
  assert (select questions_open from everwake.conversations where id = conv) = 2;
  update everwake.team_questions set status = 'dismissed' where wa_id = wa and status = 'open';
  perform everwake.sync_questions_open(conv);

  -- dismissed: closed, and no longer shown to the agent
  perform everwake.hand_back(conv);
  c := everwake.persist_turn(jsonb_build_object('tenant_id', t, 'wa_id', wa, 'run_id', 'tq-run4', 'ask_team', 'ينفع نوصل بعد 12؟'));
  select id into q from everwake.team_questions where wa_id = wa and status = 'open';
  perform everwake.dismiss_team_question(q);
  assert (select status from everwake.team_questions where id = q) = 'dismissed';
  assert (select questions_open from everwake.conversations where id = conv) = 0;
  ctx := everwake.turn_context(t, wa);
  assert not exists (select 1 from jsonb_array_elements(ctx -> 'team_questions') x where (x ->> 'id')::bigint = q);
end $$;
