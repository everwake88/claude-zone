-- =====================================================================
-- Everwake Salary · 004 · what the n8n engine calls
--
--   intake(p)                    a WhatsApp message in: the token, the chat, the message
--   media_understood(id, text)   what a voice note said / a photo showed
--   claim_turn(conv, msg)        after the short wait: is this still the newest message?
--   turn_context(conv, msg)      everything the agent reads this turn
--   verify_identity(conv, d)     the agent's tool: the details the employee gave
--   get_payslip(conv, period)    the agent's tool: the verified employee's own row, nothing else
--   escalate_to_hr(conv, d)      the agent's tool: a dispute HR sees in the dashboard
--   log_reply(p)                 the reply that went out
--
-- The rule that matters is enforced here, not in the prompt: get_payslip and
-- escalate_to_hr answer only a conversation that passed verify_identity
-- (within the hours HR set), and only with that one person's rows.
-- =====================================================================

-- ---- a message in --------------------------------------------------------------------------
create or replace function salary.intake(p jsonb) returns jsonb
language plpgsql as $$
declare
  ch salary.channel; s salary.settings; c salary.conversations;
  msg_id bigint; kind text := coalesce(nullif(p ->> 'kind', ''), 'text');
begin
  select * into ch from salary.channel;
  select * into s from salary.settings;
  if coalesce(p ->> 'token', '') <> ch.webhook_token then
    return jsonb_build_object('route', 'bad_token');
  end if;
  if coalesce(p ->> 'wa_id', '') = '' then return jsonb_build_object('route', 'ignored'); end if;
  if nullif(p ->> 'external_id', '') is not null
     and exists (select 1 from salary.messages where external_id = p ->> 'external_id') then
    return jsonb_build_object('route', 'duplicate');
  end if;

  insert into salary.conversations as cv (wa_id, reply_to, phone, push_name, provider, last_inbound_at)
  values (p ->> 'wa_id', coalesce(p ->> 'reply_to', p ->> 'wa_id'), salary.norm_phone(p ->> 'phone'),
          nullif(p ->> 'push_name', ''), coalesce(nullif(p ->> 'provider', ''), 'evolution'),
          case when (p ->> 'from_me')::boolean is not true then now() end)
  on conflict (wa_id) do update set
    reply_to = coalesce(nullif(excluded.reply_to, ''), cv.reply_to),
    phone = coalesce(excluded.phone, cv.phone),
    push_name = coalesce(excluded.push_name, cv.push_name),
    last_inbound_at = coalesce(excluded.last_inbound_at, cv.last_inbound_at)
  returning * into c;

  -- typed on the company phone itself: kept so the chat reads whole, the agent does not answer it
  if (p ->> 'from_me')::boolean is true then
    insert into salary.messages (conversation_id, direction, author, kind, text, external_id)
    values (c.id, 'out', 'hr', kind, coalesce(p ->> 'text', ''), nullif(p ->> 'external_id', ''));
    return jsonb_build_object('route', 'from_me');
  end if;

  insert into salary.messages (conversation_id, direction, author, kind, text, external_id)
  values (c.id, 'in', 'employee', kind, coalesce(p ->> 'text', ''), nullif(p ->> 'external_id', ''))
  returning id into msg_id;

  return jsonb_build_object(
    'route', case when s.agent_enabled then 'agent' else 'off' end,
    'conversation_id', c.id, 'message_id', msg_id, 'reply_to', c.reply_to,
    'channel', jsonb_build_object('provider', ch.provider, 'base_url', rtrim(ch.base_url, '/'),
                                  'instance', ch.instance, 'api_key', ch.api_key));
end $$;

-- what a voice note said or a photo showed, in place of the "[voice note]" marker
create or replace function salary.media_understood(p_message bigint, p_text text) returns jsonb
language sql as $$
  update salary.messages set text = left(coalesce(p_text, ''), 4000) where id = p_message and direction = 'in'
  returning jsonb_build_object('ok', true);
$$;

-- ---- the turn ------------------------------------------------------------------------------
-- After the short wait: only the newest message of the chat answers (it answers them all)
create or replace function salary.claim_turn(p_conv uuid, p_message bigint) returns jsonb
language plpgsql as $$
declare newest bigint; claimed uuid;
begin
  select max(id) into newest from salary.messages where conversation_id = p_conv and direction = 'in';
  if newest is distinct from p_message then return jsonb_build_object('go', false, 'reason', 'a newer message came'); end if;
  update salary.conversations set turn_message_id = p_message
  where id = p_conv and (turn_message_id is null or turn_message_id < p_message)
  returning id into claimed;
  return jsonb_build_object('go', claimed is not null);
end $$;

-- Checked before every AI call and right before the reply is sent: has the employee written again since
-- this turn's message? Then this turn stops without sending, and the turn of their newest message answers
-- everything they sent together — the way a person who sees a new message arrive stops typing and reads it.
create or replace function salary.still_newest(p_conv uuid, p_message bigint) returns jsonb
language sql stable as $$
  select jsonb_build_object('go', not exists (
    select 1 from salary.messages where conversation_id = p_conv and direction = 'in' and id > p_message))
$$;

-- the fields HR ticked, in the order they are asked
create or replace function salary.asked_fields(s salary.settings) returns text[]
language sql immutable as $$
  select array_remove(array[
    case when s.ask_full_name then 'full_name' end,
    case when s.ask_national_id then 'national_id' end,
    case when s.ask_work_id then 'work_id' end,
    case when s.ask_phone then 'phone' end], null)
$$;

-- what this chat must give: HR's fields, plus the mobile number when the WhatsApp number has to be
-- matched but WhatsApp hides it (and HR allows asking for it instead)
create or replace function salary.needed_fields(s salary.settings, c salary.conversations) returns text[]
language sql immutable as $$
  select case when s.phone_must_match_sender and s.hidden_number_ask_phone and c.phone is null
                   and not 'phone' = any (salary.asked_fields(s))
              then salary.asked_fields(s) || 'phone'::text
              else salary.asked_fields(s) end
$$;

-- a verification older than HR's hours is dropped here (the employee is asked again)
create or replace function salary.current_conversation(p_conv uuid) returns salary.conversations
language plpgsql as $$
declare c salary.conversations; s salary.settings;
begin
  select * into s from salary.settings;
  select * into c from salary.conversations where id = p_conv;
  if c.verified_at is not null and s.verified_hours > 0 and c.verified_at < now() - make_interval(hours => s.verified_hours) then
    update salary.conversations set verified_at = null, person_key = null, verified_row = null, employee_name = null
    where id = p_conv returning * into c;
  end if;
  return c;
end $$;

-- the payroll months a person has (published sheets only), newest first
create or replace function salary.person_periods(p_person text) returns jsonb
language sql stable as $$
  select coalesce(jsonb_agg(jsonb_build_object('period', to_char(sh.period, 'YYYY-MM'), 'title', sh.title) order by sh.period desc), '[]')
  from salary.payroll_sheets sh
  where sh.status = 'published'
    and exists (select 1 from salary.payroll_rows r where r.sheet_id = sh.id and r.person_key = p_person)
$$;

create or replace function salary.turn_context(p_conv uuid, p_message bigint) returns jsonb
language plpgsql as $$
declare
  s salary.settings; c salary.conversations; asked text[];
  verified boolean; history jsonb;
begin
  select * into s from salary.settings;
  c := salary.current_conversation(p_conv);
  asked := salary.needed_fields(s, c);
  verified := c.verified_at is not null;

  select coalesce(jsonb_agg(jsonb_build_object(
           'id', m.id, 'who', m.author, 'text', m.text, 'kind', m.kind,
           'at', to_char(m.created_at at time zone 'Africa/Cairo', 'YYYY-MM-DD HH24:MI'),
           'new', m.direction = 'in' and not m.answered) order by m.id), '[]')
  into history
  from (select * from salary.messages where conversation_id = p_conv and id <= p_message
        order by id desc limit 30) m;

  return jsonb_build_object(
    -- the instructions HR keeps in the dashboard (005), word rules included
    'instructions', salary.instructions_text(),
    'company_name', s.company_name, 'agent_name', s.agent_name, 'hr_contact', s.hr_contact,
    'today', to_char(now() at time zone 'Africa/Cairo', 'YYYY-MM-DD'),
    'asked_fields', to_jsonb(asked),
    'phone_must_match_sender', s.phone_must_match_sender,
    'sender_phone_known', c.phone is not null,
    'hidden_number_ask_phone', s.hidden_number_ask_phone,
    'name_min_words', s.name_min_words,
    'verified', verified,
    'employee_name', case when verified then c.employee_name end,
    'verified_until', case when verified and s.verified_hours > 0
                           then to_char((c.verified_at + make_interval(hours => s.verified_hours)) at time zone 'Africa/Cairo', 'YYYY-MM-DD HH24:MI') end,
    'periods', case when verified then salary.person_periods(c.person_key) else '[]'::jsonb end,
    -- their disputes still with HR (also the ticket a superseded turn opened without telling them)
    'open_tickets', case when verified then coalesce((
        select jsonb_agg(jsonb_build_object('ticket_no', d.ticket_no, 'item', d.item, 'period', to_char(d.period, 'YYYY-MM'),
                                            'opened', to_char(d.created_at at time zone 'Africa/Cairo', 'YYYY-MM-DD')) order by d.created_at)
        from salary.disputes d where d.person_key = c.person_key and d.status = 'open'), '[]'::jsonb) else '[]'::jsonb end,
    'collected', case when verified then '{}'::jsonb else c.collected end,
    'still_needed', case when verified then '[]'::jsonb
                         else to_jsonb(array(select f from unnest(asked) f where not c.collected ? f)) end,
    'failed_attempts', c.failed_attempts,
    'history', history);
end $$;

-- ---- tool: verify_identity -----------------------------------------------------------------
create or replace function salary.verify_identity(p_conv uuid, p_details jsonb) returns jsonb
language plpgsql as $$
declare
  s salary.settings; c salary.conversations; asked text[];
  f text; v text; chk jsonb;
  saved text[] := '{}'; invalid jsonb := '{}'; got jsonb; still text[];
  hit record; n_people int; result text; given jsonb := '{}';
begin
  select * into s from salary.settings;
  c := salary.current_conversation(p_conv);
  if c.id is null then return jsonb_build_object('status', 'error', 'error', 'no such conversation'); end if;
  asked := salary.needed_fields(s, c);
  if c.verified_at is not null then
    return jsonb_build_object('status', 'already_verified', 'employee_name', c.employee_name,
                              'periods', salary.person_periods(c.person_key));
  end if;

  -- each field given: checked, and kept only when valid
  got := c.collected;
  for f, v in select key, value #>> '{}' from jsonb_each(coalesce(p_details, '{}'))
                where key in ('full_name', 'national_id', 'work_id', 'phone') and coalesce(value #>> '{}', '') <> '' loop
    chk := salary.check_field(f, v, s);
    if (chk ->> 'ok')::boolean then
      got := got || jsonb_build_object(f, chk ->> 'value');
      saved := saved || f;
    else
      invalid := invalid || jsonb_build_object(f, chk ->> 'problem');
      got := got - f;
    end if;
  end loop;
  update salary.conversations set collected = got where id = p_conv;
  still := array(select x from unnest(asked) x where not got ? x);

  if cardinality(still) > 0 or invalid <> '{}' then
    return jsonb_strip_nulls(jsonb_build_object('status', 'need_more', 'saved', to_jsonb(saved),
      'invalid', nullif(invalid, '{}'), 'still_needed', to_jsonb(still)));
  end if;

  -- everything asked is in: the exact match, newest month first
  for f in select unnest(asked) loop given := given || jsonb_build_object(f, salary.mask(f, got ->> f)); end loop;

  select r.id, r.person_key, r.phone, r.cells, sh.identity, sh.period, r.sheet_id into hit
  from salary.payroll_rows r join salary.payroll_sheets sh on sh.id = r.sheet_id
  where sh.status = 'published' and r.person_key is not null and not ('duplicate' = any (r.problems))
    and (not ('full_name' = any (asked))   or r.name_norm = salary.norm_name(got ->> 'full_name'))
    and (not ('national_id' = any (asked)) or r.national_id = got ->> 'national_id')
    and (not ('work_id' = any (asked))     or r.work_id = got ->> 'work_id')
    and (not ('phone' = any (asked))       or r.phone = got ->> 'phone')
  order by sh.period desc, r.id
  limit 1;

  if hit.id is null then
    -- duplicates in the newest month of a person who otherwise matches: HR must fix the sheet
    if exists (select 1 from salary.payroll_rows r join salary.payroll_sheets sh on sh.id = r.sheet_id
               where sh.status = 'published' and 'duplicate' = any (r.problems)
                 and (not ('national_id' = any (asked)) or r.national_id = got ->> 'national_id')
                 and (not ('work_id' = any (asked)) or r.work_id = got ->> 'work_id')) then
      result := 'ambiguous';
    else
      result := 'no_match';
    end if;
  elsif s.phone_must_match_sender and c.phone is null and not s.hidden_number_ask_phone then
    result := 'sender_hidden';
  -- (hidden number, HR allows asking: the typed mobile number already matched the row above)
  elsif s.phone_must_match_sender and c.phone is not null and hit.phone is distinct from c.phone then
    result := 'phone_mismatch';
  else
    result := 'verified';
  end if;

  insert into salary.identity_attempts (conversation_id, given, result, matched_row)
  values (p_conv, given, result, case when result = 'verified' then hit.id end);

  if result <> 'verified' then
    update salary.conversations set failed_attempts = failed_attempts + 1 where id = p_conv returning * into c;
    return jsonb_build_object('status', result, 'failed_attempts', c.failed_attempts,
                              'what_they_gave', got);
  end if;

  update salary.conversations set
    verified_at = now(), person_key = hit.person_key, verified_row = hit.id, collected = '{}', failed_attempts = 0,
    employee_name = coalesce(nullif(btrim(hit.cells ->> (hit.identity ->> 'full_name')), ''), got ->> 'full_name')
  where id = p_conv;

  return jsonb_build_object('status', 'verified') || salary.get_payslip(p_conv, null);
end $$;

-- ---- tool: get_payslip ---------------------------------------------------------------------
-- p_period 'YYYY-MM', or null / '' for the newest month the person has
create or replace function salary.get_payslip(p_conv uuid, p_period text) returns jsonb
language plpgsql as $$
declare c salary.conversations; sh salary.payroll_sheets; r salary.payroll_rows; items jsonb; want date;
begin
  c := salary.current_conversation(p_conv);
  if c.verified_at is null then
    return jsonb_build_object('status', 'not_verified',
      'note', 'Nothing about any salary can be shared before the employee proves who they are with verify_identity.');
  end if;
  if coalesce(p_period, '') ~ '^\d{4}-\d{1,2}$' then
    want := make_date(split_part(p_period, '-', 1)::int, split_part(p_period, '-', 2)::int, 1);
  end if;

  select s2.* into sh from salary.payroll_sheets s2
  where s2.status = 'published' and (want is null or s2.period = want)
    and exists (select 1 from salary.payroll_rows x where x.sheet_id = s2.id and x.person_key = c.person_key)
  order by s2.period desc limit 1;
  if sh.id is null then
    return jsonb_build_object('status', 'no_record_for_period', 'asked_for', p_period,
                              'available_periods', salary.person_periods(c.person_key));
  end if;
  select * into r from salary.payroll_rows where sheet_id = sh.id and person_key = c.person_key order by id limit 1;

  -- the row as HR uploaded it, column by column, in the sheet's order; hidden columns stay out
  select coalesce(jsonb_agg(jsonb_build_object('column', col ->> 'header', 'value', r.cells -> (col ->> 'key')) order by ord), '[]')
  into items
  from jsonb_array_elements(sh.columns) with ordinality as t(col, ord)
  where coalesce((col ->> 'visible')::boolean, true)
    and r.cells ? (col ->> 'key') and coalesce(r.cells ->> (col ->> 'key'), '') <> '';

  return jsonb_build_object('period', to_char(sh.period, 'YYYY-MM'), 'title', sh.title,
                            'payslip', items, 'available_periods', salary.person_periods(c.person_key));
end $$;

-- ---- tool: escalate_to_hr ------------------------------------------------------------------
create or replace function salary.escalate_to_hr(p_conv uuid, p jsonb) returns jsonb
language plpgsql as $$
declare c salary.conversations; want date; d salary.disputes;
begin
  c := salary.current_conversation(p_conv);
  if c.verified_at is null then
    return jsonb_build_object('status', 'not_verified', 'note', 'Only a verified employee can send a dispute to HR.');
  end if;
  if coalesce(btrim(p ->> 'details'), '') = '' then
    return jsonb_build_object('status', 'need_details', 'note', 'Ask what exactly they think is wrong, in their words.');
  end if;
  if coalesce(p ->> 'period', '') ~ '^\d{4}-\d{1,2}$' then
    want := make_date(split_part(p ->> 'period', '-', 1)::int, split_part(p ->> 'period', '-', 2)::int, 1);
  end if;
  -- the same complaint twice in a row is one ticket
  select * into d from salary.disputes
  where conversation_id = p_conv and status = 'open' and item = coalesce(p ->> 'item', '')
    and period is not distinct from want and created_at > now() - interval '1 day'
  order by created_at desc limit 1;
  if d.id is not null then
    update salary.disputes set details = left(details || E'\n' || btrim(p ->> 'details'), 4000) where id = d.id;
    return jsonb_build_object('status', 'added_to_open_ticket', 'ticket_no', d.ticket_no);
  end if;
  insert into salary.disputes (conversation_id, person_key, employee_name, period, item, details)
  values (p_conv, c.person_key, c.employee_name, want, coalesce(p ->> 'item', ''), left(btrim(p ->> 'details'), 4000))
  returning * into d;
  return jsonb_build_object('status', 'sent_to_hr', 'ticket_no', d.ticket_no);
end $$;

-- ---- the reply that went out ---------------------------------------------------------------
create or replace function salary.log_reply(p jsonb) returns jsonb
language plpgsql as $$
declare conv uuid := (p ->> 'conversation_id')::uuid; upto bigint := nullif(p ->> 'upto_message_id', '')::bigint;
begin
  if coalesce(p ->> 'text', '') <> '' then
    -- WhatsApp may echo the sent message back (from_me) before this runs: then that row becomes the agent's
    insert into salary.messages (conversation_id, direction, author, kind, text, external_id, send_error)
    values (conv, 'out', 'agent', 'text', p ->> 'text', nullif(p ->> 'external_id', ''), nullif(p ->> 'error', ''))
    on conflict (external_id) where external_id is not null
    do update set author = 'agent', text = excluded.text, send_error = excluded.send_error;
  end if;
  update salary.messages set answered = true
  where conversation_id = conv and direction = 'in' and not answered and id <= coalesce(upto, id);
  update salary.conversations set last_outbound_at = now(),
    turn_message_id = case when turn_message_id = upto then null else turn_message_id end
  where id = conv;
  return jsonb_build_object('ok', true);
end $$;
