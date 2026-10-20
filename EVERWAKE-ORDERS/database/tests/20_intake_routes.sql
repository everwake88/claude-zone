-- Intake: every route a message can take
do $$
declare
  t   uuid := (select id from everwake.tenants where slug = 'nile_grill');
  r   jsonb;
  c   record;
  base jsonb := jsonb_build_object('instance', 'nilegrill', 'token', 'demo-token');
  n   int;
begin
  -- the wrong WhatsApp instance or token is ignored
  r := everwake.intake(jsonb_build_object('instance', 'nobody', 'token', 'x', 'wa_id', '201111', 'text', 'hi'));
  assert r ->> 'route' = 'ignore' and r ->> 'reason' = 'unknown_channel', r::text;
  r := everwake.intake(jsonb_build_object('instance', 'nilegrill', 'token', 'wrong', 'wa_id', '201111', 'text', 'hi'));
  assert r ->> 'reason' = 'bad_token', r::text;

  -- a normal message → the agent, buffered, customer + conversation created
  r := everwake.intake(base || jsonb_build_object('external_id', 'm1', 'wa_id', '201222333444', 'reply_to', '201222333444',
                                                  'phone', '201222333444', 'push_name', 'Mona', 'text', 'عايزة أطلب'));
  assert r ->> 'route' = 'agent', r::text;
  assert (r ->> 'buffer_id') is not null;
  assert r -> 'channel' ->> 'base_url' = 'https://evo.example.com', 'trailing slash trimmed';
  select * into c from everwake.customers where tenant_id = t and wa_id = '201222333444';
  assert c.display_name = 'Mona' and c.phone = '201222333444' and not c.phone_hidden;

  -- Evolution delivers the same message twice → once
  r := everwake.intake(base || jsonb_build_object('external_id', 'm1', 'wa_id', '201222333444', 'text', 'عايزة أطلب'));
  assert r ->> 'route' = 'duplicate', r::text;
  select count(*) into n from everwake.messages where tenant_id = t and external_id = 'm1';
  assert n = 1;

  -- a customer behind a WhatsApp private id (lid) …
  r := everwake.intake(base || jsonb_build_object('external_id', 'm2', 'wa_id', '987654321012345', 'lid', '987654321012345',
                                                  'reply_to', '987654321012345@lid', 'text', 'hello'));
  assert r ->> 'route' = 'agent';
  select * into c from everwake.customers where tenant_id = t and wa_id = '987654321012345';
  assert c.phone_hidden and c.reply_to = '987654321012345@lid', 'lid customer replies go to the full jid';
  -- … who later arrives with the real number too: same customer, number attached
  r := everwake.intake(base || jsonb_build_object('external_id', 'm3', 'wa_id', '201555666777', 'lid', '987654321012345',
                                                  'phone', '201555666777', 'reply_to', '201555666777', 'text', 'again'));
  assert r ->> 'wa_id' = '987654321012345', 'still the same conversation key: ' || r::text;
  select * into c from everwake.customers where tenant_id = t and wa_id = '987654321012345';
  assert c.phone = '201555666777' and not c.phone_hidden and c.reply_to = '201555666777';
  -- and next time by number only, they are still recognised
  r := everwake.intake(base || jsonb_build_object('external_id', 'm4', 'wa_id', '201555666777', 'phone', '201555666777', 'text', 'x'));
  assert r ->> 'wa_id' = '987654321012345', 'found by phone identity: ' || r::text;

  -- a person took over → the agent stays quiet
  update everwake.conversations set mode = 'human', human_since = now(), human_last_activity_at = now()
   where tenant_id = t and wa_id = '201222333444';
  r := everwake.intake(base || jsonb_build_object('external_id', 'm5', 'wa_id', '201222333444', 'phone', '201222333444', 'text', 'any news?'));
  assert r ->> 'route' = 'human', r::text;
  -- … and after 30 idle minutes the agent takes it back by itself
  update everwake.conversations set human_last_activity_at = now() - interval '31 minutes'
   where tenant_id = t and wa_id = '201222333444';
  r := everwake.intake(base || jsonb_build_object('external_id', 'm6', 'wa_id', '201222333444', 'phone', '201222333444', 'text', 'hello?'));
  assert r ->> 'route' = 'agent', 'auto handback: ' || r::text;
  select * into c from everwake.conversations where tenant_id = t and wa_id = '201222333444';
  assert c.mode = 'agent' and c.state -> 'handback' ->> 'by' = 'auto';

  -- the restaurant switches the agent OFF
  r := everwake.set_agent_enabled(t, false, 'Friday rush');
  assert (r ->> 'changed')::boolean and not (r ->> 'agent_enabled')::boolean;
  r := everwake.intake(base || jsonb_build_object('external_id', 'm7', 'wa_id', '201999888777', 'phone', '201999888777',
                                                  'push_name', 'Karim Adel', 'text', 'عايز أطلب كفتة'));
  assert r ->> 'route' = 'paused' and (r ->> 'send_apology')::boolean, r::text;
  assert r ->> 'apology_text' like 'أهلاً Karim 🙏%', 'warm apology with the first name: ' || (r ->> 'apology_text');
  -- one apology per person, however many messages
  r := everwake.intake(base || jsonb_build_object('external_id', 'm8', 'wa_id', '201999888777', 'phone', '201999888777', 'text', 'hello?'));
  assert r ->> 'route' = 'paused' and not (r ->> 'send_apology')::boolean, r::text;
  r := everwake.intake(base || jsonb_build_object('external_id', 'm9', 'wa_id', '201444', 'phone', '201444', 'text', 'Hi, can I order?'));
  assert r ->> 'apology_text' like 'Hi, we are really sorry%', 'english apology, no name: ' || (r ->> 'apology_text');

  -- back ON → everyone who wrote gets "we're back", staggered
  r := everwake.set_agent_enabled(t, true);
  assert (r ->> 'notified')::int = 2, r::text;
  select count(*) into n from everwake.outbox where tenant_id = t and purpose = 'resume_notice' and status = 'queued';
  assert n = 2;
  assert (select count(distinct not_before) from everwake.outbox where tenant_id = t and purpose = 'resume_notice') = 2, 'staggered';
  assert exists (select 1 from everwake.outbox where tenant_id = t and purpose = 'resume_notice' and body like 'أهلاً Karim 👋 رجعنا%');
  assert exists (select 1 from everwake.messages where tenant_id = t and wa_id = '201999888777' and sender = 'system' and status = 'queued');
  r := everwake.set_agent_enabled(t, true);
  assert not (r ->> 'changed')::boolean, 'switching on twice notifies nobody twice';

  -- still onboarding: only test numbers reach the agent
  update everwake.tenants set status = 'onboarding' where id = t;
  r := everwake.intake(base || jsonb_build_object('external_id', 'm10', 'wa_id', '201777', 'phone', '201777', 'text', 'hi'));
  assert r ->> 'route' = 'not_live', r::text;
  r := everwake.intake(base || jsonb_build_object('external_id', 'm11', 'wa_id', '201000000001', 'phone', '201000000001', 'text', 'test'));
  assert r ->> 'route' = 'agent', 'test number: ' || r::text;
  update everwake.tenants set status = 'live' where id = t;

  -- the restaurant replies from the phone itself
  r := everwake.intake(base || jsonb_build_object('external_id', 'm12', 'wa_id', '201222333444', 'from_me', true, 'text', 'x'));
  assert r ->> 'route' = 'from_me';
  perform everwake.log_outbound(jsonb_build_object('tenant_id', t, 'wa_id', '201222333444', 'body', 'أهلاً بيكي', 'external_id', 'out1'));
  r := everwake.log_phone_reply(base || jsonb_build_object('external_id', 'out1', 'wa_id', '201222333444', 'phone', '201222333444', 'text', 'أهلاً بيكي'));
  assert r ->> 'reason' = 'already_logged', 'our own send is not a person: ' || r::text;
  r := everwake.log_phone_reply(base || jsonb_build_object('external_id', 'echo2', 'wa_id', '201222333444', 'phone', '201222333444', 'text', 'أهلاً بيكي'));
  assert r ->> 'reason' = 'engine_echo', r::text;
  r := everwake.log_phone_reply(base || jsonb_build_object('external_id', 'staff1', 'wa_id', '201222333444', 'phone', '201222333444', 'text', 'أنا أحمد من الفرع، طلبك جاهز'));
  assert (r ->> 'logged')::boolean, r::text;
  select * into c from everwake.conversations where tenant_id = t and wa_id = '201222333444';
  assert c.mode = 'human' and c.human_reason = 'replied from the phone', 'a phone reply takes the conversation over';
  update everwake.conversations set mode = 'agent', human_since = null, human_reason = null where id = c.id;

  -- a blocked customer is ignored
  update everwake.customers set is_blocked = true where tenant_id = t and wa_id = '201444';
  r := everwake.intake(base || jsonb_build_object('external_id', 'm13', 'wa_id', '201444', 'phone', '201444', 'text', 'spam'));
  assert r ->> 'reason' = 'blocked', r::text;
end $$;
