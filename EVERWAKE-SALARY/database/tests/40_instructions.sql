-- the agent's instructions: the default to start with, HR's own version, word rules at the end
do $$
declare txt text; conv uuid;
begin
  assert (select count(*) from salary.agent_instructions) = 1, 'the default is the first version';
  assert salary.instructions_text() = salary.default_instructions(), 'no word rules yet: the default as it is';

  insert into salary.agent_instructions (body, note) values (salary.default_instructions() || E'\n\nAlways sign off with: فريق الموارد البشرية', 'sign-off');
  assert salary.instructions_text() like '%فريق الموارد البشرية', 'the newest version is live';

  insert into salary.word_rules (say, avoid) values ('مرتب', 'راتب');
  insert into salary.word_rules (say, avoid) values (null, 'تم بنجاح');
  txt := salary.instructions_text();
  assert txt like E'%\n\n<wording>\n%', txt;
  assert txt like '%- say «مرتب», never «راتب»%' and txt like E'%- never say «تم بنجاح»\n</wording>', txt;

  begin
    insert into salary.word_rules (avoid) values (' راتب ');
    assert false, 'the same word twice';
  exception when unique_violation then null;
  end;
  begin
    insert into salary.agent_instructions (body) values ('too short');
    assert false, 'an empty or cut-off version is refused';
  exception when check_violation then null;
  end;

  -- the agent reads it every turn
  select id into conv from salary.conversations limit 1;
  assert salary.turn_context(conv, (select max(id) from salary.messages where conversation_id = conv)) ->> 'instructions' = txt;

  delete from salary.word_rules;
  delete from salary.agent_instructions where note = 'sign-off';
  assert salary.instructions_text() = salary.default_instructions(), 'back to the default';
end $$;
