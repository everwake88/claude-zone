-- a whole chat: intake, the turn, identity one field at a time, the payslip, a dispute, the reply
do $$
declare tok text; r jsonb; conv uuid; m1 bigint; m2 bigint; ctx jsonb; p jsonb;
begin
  select webhook_token into tok from salary.channel;
  assert (salary.intake('{"token":"wrong","wa_id":"201001234567"}') ->> 'route') = 'bad_token';

  r := salary.intake(jsonb_build_object('token', tok, 'wa_id', '201001234567', 'phone', '201001234567',
                                        'text', 'عايز اعرف تفاصيل مرتبي', 'external_id', 'A1', 'push_name', 'Ahmed'));
  assert r ->> 'route' = 'agent', r::text;
  conv := (r ->> 'conversation_id')::uuid; m1 := (r ->> 'message_id')::bigint;
  assert (select phone from salary.conversations where id = conv) = '01001234567';
  assert (salary.intake(jsonb_build_object('token', tok, 'wa_id', '201001234567', 'text', 'x', 'external_id', 'A1')) ->> 'route') = 'duplicate';

  -- a second message before the wait ends: only the newest answers
  m2 := (salary.intake(jsonb_build_object('token', tok, 'wa_id', '201001234567', 'phone', '201001234567',
                                          'text', 'لو سمحت', 'external_id', 'A2')) ->> 'message_id')::bigint;
  assert (salary.claim_turn(conv, m1) ->> 'go')::boolean = false, 'superseded';
  assert (salary.claim_turn(conv, m2) ->> 'go')::boolean, 'newest claims';

  ctx := salary.turn_context(conv, m2);
  assert ctx -> 'asked_fields' = '["full_name","national_id","work_id"]', ctx::text;
  assert (ctx ->> 'verified')::boolean = false;
  assert jsonb_array_length(ctx -> 'history') = 2 and (ctx -> 'history' -> 1 ->> 'new')::boolean;

  -- nothing before verification
  assert salary.get_payslip(conv, null) ->> 'status' = 'not_verified';
  assert salary.escalate_to_hr(conv, '{"details":"x"}') ->> 'status' = 'not_verified';

  -- one field at a time, a bad one, a good one
  r := salary.verify_identity(conv, '{"full_name":"احمد محمد"}');
  assert r ->> 'status' = 'need_more' and r -> 'invalid' ? 'full_name', r::text;
  r := salary.verify_identity(conv, '{"full_name":"احمد محمد عبدالله السيد"}');
  assert r -> 'saved' = '["full_name"]' and r -> 'still_needed' = '["national_id","work_id"]', r::text;
  r := salary.verify_identity(conv, '{"national_id":"2900115010123"}');
  assert r -> 'invalid' ? 'national_id', r::text;
  r := salary.verify_identity(conv, '{"national_id":"٢٩٠٠١١٥٠١٠١٢٣٤"}');
  assert r -> 'still_needed' = '["work_id"]', r::text;
  assert salary.turn_context(conv, m2) -> 'still_needed' = '["work_id"]';

  -- a wrong work id: no match, and no hint which field was wrong
  r := salary.verify_identity(conv, '{"work_id":"9999"}');
  assert r ->> 'status' = 'no_match' and (r ->> 'failed_attempts')::int = 1, r::text;
  assert (select result from salary.identity_attempts where conversation_id = conv order by id desc limit 1) = 'no_match';
  assert (select given ->> 'national_id' from salary.identity_attempts where conversation_id = conv order by id desc limit 1) = '••••••••••1234', 'masked';

  -- the right one: verified, with October's payslip, hidden columns left out
  r := salary.verify_identity(conv, '{"work_id":"01023"}');
  assert r ->> 'status' = 'verified', r::text;
  assert r ->> 'period' = '2026-10';
  assert jsonb_path_exists(r, '$.payslip[*] ? (@.column == "صافي المرتب")'), 'net pay is there';
  assert not jsonb_path_exists(r, '$.payslip[*] ? (@.column == "الرقم القومي")'), 'hidden column stays out';
  assert not jsonb_path_exists(r, '$.payslip[*] ? (@.column == "ملاحظات HR")'), 'HR notes stay out';
  assert jsonb_array_length(r -> 'available_periods') = 2;
  assert (select employee_name from salary.conversations where id = conv) = 'أحمد محمد عبد الله السيد';
  assert (select collected from salary.conversations where id = conv) = '{}', 'what they typed is not kept';

  -- another month; a month that does not exist
  p := salary.get_payslip(conv, '2026-09');
  assert p ->> 'period' = '2026-09', p::text;
  assert salary.get_payslip(conv, '2025-01') ->> 'status' = 'no_record_for_period';

  -- a dispute, then the same one again: one ticket
  r := salary.escalate_to_hr(conv, '{"period":"2026-10","item":"خصم تأخير","details":"مكنتش متأخر يوم 12"}');
  assert r ->> 'status' = 'sent_to_hr', r::text;
  assert salary.escalate_to_hr(conv, '{"period":"2026-10","item":"خصم تأخير","details":"ولا يوم 15"}') ->> 'status' = 'added_to_open_ticket';
  assert (select count(*) from salary.disputes where conversation_id = conv) = 1;
  assert (select employee_name from salary.disputes where conversation_id = conv) = 'أحمد محمد عبد الله السيد';

  -- the reply: logged, the two messages answered, the turn released
  perform salary.log_reply(jsonb_build_object('conversation_id', conv, 'text', 'تمام', 'upto_message_id', m2));
  assert (select count(*) from salary.messages where conversation_id = conv and direction = 'in' and not answered) = 0;
  assert (select turn_message_id from salary.conversations where id = conv) is null;

  -- the reply's echo came first (typed "from the phone"), then the log: one message, the agent's
  perform salary.intake(jsonb_build_object('token', tok, 'wa_id', '201001234567', 'text', 'echo', 'external_id', 'OUT9', 'from_me', true));
  perform salary.log_reply(jsonb_build_object('conversation_id', conv, 'text', 'الرد', 'upto_message_id', m2, 'external_id', 'OUT9'));
  assert (select author || ':' || text from salary.messages where external_id = 'OUT9') = 'agent:الرد';

  -- verification wears off after HR's hours
  update salary.conversations set verified_at = now() - interval '25 hours' where id = conv;
  assert salary.get_payslip(conv, null) ->> 'status' = 'not_verified', 'expired';
  assert (salary.turn_context(conv, m2) ->> 'verified')::boolean = false;
end $$;

-- the sender's number must be the row's number
do $$
declare tok text; conv uuid; r jsonb;
begin
  select webhook_token into tok from salary.channel;
  -- منى's details, written from someone else's phone
  conv := (salary.intake(jsonb_build_object('token', tok, 'wa_id', '201009990000', 'phone', '201009990000', 'text', 'hi', 'external_id', 'B1')) ->> 'conversation_id')::uuid;
  r := salary.verify_identity(conv, '{"full_name":"مني ابراهيم حسن علي","national_id":"29203220201876","work_id":"1024"}');
  assert r ->> 'status' = 'phone_mismatch', r::text;
  assert salary.get_payslip(conv, null) ->> 'status' = 'not_verified';

  -- WhatsApp hid the number (a private id): the mobile number is asked for instead (HR's default)
  conv := (salary.intake(jsonb_build_object('token', tok, 'wa_id', '123456789012345', 'reply_to', '123456789012345@lid', 'text', 'hi', 'external_id', 'C1')) ->> 'conversation_id')::uuid;
  assert salary.turn_context(conv, null) -> 'still_needed' = '["full_name","national_id","work_id","phone"]', 'phone joins what is asked';
  r := salary.verify_identity(conv, '{"full_name":"مني ابراهيم حسن علي","national_id":"29203220201876","work_id":"1024"}');
  assert r ->> 'status' = 'need_more' and r -> 'still_needed' = '["phone"]', r::text;
  -- a number that is not on her row: no match (and no hint which field)
  r := salary.verify_identity(conv, '{"phone":"01009990000"}');
  assert r ->> 'status' = 'no_match', r::text;
  -- her own number, as she types it
  r := salary.verify_identity(conv, '{"phone":"+20 111 222 3344"}');
  assert r ->> 'status' = 'verified', r::text;

  -- HR unticks "ask for the number instead": a hidden number cannot be checked, they are sent to HR
  update salary.settings set hidden_number_ask_phone = false;
  conv := (salary.intake(jsonb_build_object('token', tok, 'wa_id', '223456789012345', 'reply_to', '223456789012345@lid', 'text', 'hi', 'external_id', 'C2')) ->> 'conversation_id')::uuid;
  assert salary.turn_context(conv, null) -> 'still_needed' = '["full_name","national_id","work_id"]';
  r := salary.verify_identity(conv, '{"full_name":"مني ابراهيم حسن علي","national_id":"29203220201876","work_id":"1024"}');
  assert r ->> 'status' = 'sender_hidden', r::text;

  -- HR switches the WhatsApp-number match off altogether: the same chat now passes, nothing extra asked
  update salary.settings set phone_must_match_sender = false;
  r := salary.verify_identity(conv, '{}');
  assert r ->> 'status' = 'verified', r::text;
  update salary.settings set phone_must_match_sender = true, hidden_number_ask_phone = true;

  -- HR asks for the phone too, and turns the agent off
  update salary.settings set ask_phone = true, ask_work_id = false;
  conv := (salary.intake(jsonb_build_object('token', tok, 'wa_id', '201112223344', 'phone', '201112223344', 'text', 'hi', 'external_id', 'D1')) ->> 'conversation_id')::uuid;
  r := salary.verify_identity(conv, '{"full_name":"منى إبراهيم حسن علي","national_id":"29203220201876"}');
  assert r -> 'still_needed' = '["phone"]', r::text;
  r := salary.verify_identity(conv, '{"phone":"+20 111 222 3344"}');
  assert r ->> 'status' = 'verified', r::text;
  update salary.settings set ask_phone = false, ask_work_id = true, agent_enabled = false;
  assert salary.intake(jsonb_build_object('token', tok, 'wa_id', '201112223344', 'text', 'hi', 'external_id', 'D2')) ->> 'route' = 'off';
  update salary.settings set agent_enabled = true;

  -- a message typed on the company phone is logged, not answered
  assert salary.intake(jsonb_build_object('token', tok, 'wa_id', '201112223344', 'text', 'from HR', 'external_id', 'D3', 'from_me', true)) ->> 'route' = 'from_me';

  -- at least one unique number must stay ticked
  begin
    update salary.settings set ask_national_id = false, ask_work_id = false;
    assert false, 'should not allow';
  exception when check_violation then null;
  end;
end $$;
