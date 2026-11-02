\i tests/fixtures/helpers.sql
-- intake routes, then a whole booking through the agent's tool: options → hold → summary → book,
-- a child's booking from the same number, "بعده", reschedule, confirm, cancel, an emergency
do $$
declare
  t   uuid := pg_temp.tid();
  wa  text := '201011112222';
  r   jsonb; r2 jsonb;
  v   jsonb;
  ref text;
  aid bigint;
  n   int;
  last_max timestamptz;
begin
  -- routes
  r := pg_temp.say(wa, 'السلام عليكم، عايز أحجز تنضيف جير', 'Ahmed Samir');
  assert r ->> 'route' = 'agent' and (r ->> 'buffer_id') is not null, r::text;
  r2 := clinic.intake(jsonb_build_object('instance', 'nileclinic', 'token', 'wrong', 'wa_id', wa, 'phone', wa, 'text', 'x'));
  assert r2 ->> 'route' = 'ignore' and r2 ->> 'reason' = 'bad_token';
  r2 := clinic.intake(jsonb_build_object('instance', 'nileclinic', 'token', 'demo-token', 'wa_id', wa, 'phone', wa, 'text', 'x', 'external_id', 'DUP-1'));
  r2 := clinic.intake(jsonb_build_object('instance', 'nileclinic', 'token', 'demo-token', 'wa_id', wa, 'phone', wa, 'text', 'x', 'external_id', 'DUP-1'));
  assert r2 ->> 'route' = 'duplicate';
  -- the doctor's own number goes to the staff assistant
  r2 := pg_temp.say('201000000101', 'هتأخر 20 دقيقة');
  assert r2 ->> 'route' = 'staff' and r2 -> 'staff' ->> 'role' = 'doctor', r2::text;
  -- debounce: only the newest message answers, and it takes the lock
  r := pg_temp.say(wa, 'لو ينفع السبت');
  r2 := clinic.claim_window(t, wa, 'run-1', (r ->> 'buffer_id')::bigint);
  assert (r2 ->> 'lock_acquired')::boolean, r2::text;
  assert r2 ->> 'combined_text' like '%تنضيف جير%' and r2 ->> 'combined_text' like '%السبت%', 'bundled';
  perform clinic.persist_turn(jsonb_build_object('tenant_id', t, 'wa_id', wa, 'run_id', 'run-1'));

  -- the context the agent reads
  v := clinic.turn_context(t, wa);
  assert v ->> 'catalog_digest' like '%تنضيف جير وتلميع%';
  assert jsonb_array_length(v -> 'known_patients') = 0, 'a new person';

  -- free times for a cleaning
  r := pg_temp.tool(wa, 'find_slots', jsonb_build_object('service', 'تنظيف', 'from', pg_temp.next_dow(6)));
  assert r ->> 'status' = 'OPTIONS', r::text;
  assert jsonb_array_length(r -> 'options') between 1 and 3 and (r -> 'options' -> 0 ->> 'option')::int = 1, r::text;
  assert (r -> 'price' ->> 'price')::numeric = 600, 'priced';
  -- "بعده": the next free times after the last one offered
  select max((x ->> 'starts_at')::timestamptz) into last_max from jsonb_array_elements(r -> 'options') x;
  r2 := pg_temp.tool(wa, 'find_slots', '{"after":"last_offered"}');
  assert not exists (select 1 from jsonb_array_elements(r2 -> 'options') x where (x ->> 'starts_at')::timestamptz <= last_max), 'only later times';
  -- a band: the evening
  r2 := pg_temp.tool(wa, 'find_slots', '{"band":"evening"}');
  assert not exists (select 1 from jsonb_array_elements(r2 -> 'options') x where x ->> 'band' <> 'evening'), 'evening only';

  -- options always mean the last list offered: offer Saturday's again
  r := pg_temp.tool(wa, 'find_slots', jsonb_build_object('service', 'تنظيف', 'from', pg_temp.next_dow(6)));
  -- picks option 1 and says who they are
  r := pg_temp.tool(wa, 'update', '{"option":1,"full_name":"أحمد سمير","age":"32","relation":"self","reason":"جير وحساسية"}');
  assert r -> 'held' ->> 'status' = 'held', r::text;
  assert (r ->> 'ready_for_summary')::boolean, r::text;
  -- booking before the summary is refused
  r2 := pg_temp.tool(wa, 'book');
  assert r2 ->> 'error' = 'SUMMARY_NOT_CONFIRMED', r2::text;
  r := pg_temp.tool(wa, 'summary');
  assert r ->> 'status' = 'SUMMARY_READY' and r ->> 'summary_text' like '%600 ج%' and r ->> 'summary_text' like '%أحمد سمير%', r::text;
  r := pg_temp.tool(wa, 'book');
  assert r ->> 'status' = 'BOOKED', r::text;
  ref := r -> 'appointment' ->> 'ref_no';
  aid := (r -> 'appointment' ->> 'id')::bigint;
  assert ref like 'NC-%';
  assert r -> 'location' ->> 'maps_url' is not null, 'the pin to send';
  assert (select count(*) from clinic.appointment_reminders where appointment_id = aid and status = 'scheduled') >= 1, 'reminders planned';
  assert exists (select 1 from clinic.patients p join clinic.patient_contacts pc on pc.patient_id = p.id
                  where p.full_name = 'أحمد سمير' and pc.relation = 'self' and p.birth_date is not null and p.birth_date_estimated), 'patient made';
  assert not exists (select 1 from clinic.booking_drafts where tenant_id = t and wa_id = wa), 'draft cleared';

  -- the same number books for their child with the paediatrician (queue numbers)
  r := pg_temp.tool(wa, 'find_slots', '{"doctor":"كريم","full_name":"يوسف أحمد","age":"6","relation":"child","reason":"سخونية وكحة"}');
  assert r ->> 'status' = 'OPTIONS' and r -> 'options' -> 0 ->> 'kind' = 'queue', r::text;
  r := pg_temp.tool(wa, 'update', '{"option":1}');
  assert r -> 'held' ->> 'mode' = 'queue', r::text;
  r := pg_temp.tool(wa, 'summary');
  assert r ->> 'summary_text' like '%يوسف أحمد%' and r ->> 'summary_text' like '%350%', r::text;
  r := pg_temp.tool(wa, 'book');
  assert r ->> 'status' = 'BOOKED', r::text;
  v := clinic.turn_context(t, wa);
  assert jsonb_array_length(v -> 'known_patients') = 2, 'self and child';
  assert jsonb_array_length(v -> 'upcoming') = 2;

  -- confirm (a reminder's "1"), then move, then cancel
  r := pg_temp.tool(wa, 'confirm', jsonb_build_object('ref_no', ref));
  assert (select status from clinic.appointments where id = aid) = 'confirmed', r::text;
  r := pg_temp.tool(wa, 'reschedule', jsonb_build_object('ref_no', ref));
  assert r ->> 'status' = 'OPTIONS', 'reschedule without a time offers times: ' || r::text;
  r := pg_temp.tool(wa, 'reschedule', jsonb_build_object('ref_no', ref, 'option', 2));
  assert r ->> 'status' = 'MOVED', r::text;
  assert (select status from clinic.appointments where id = aid) = 'booked', 'a moved visit needs confirming again';
  r := pg_temp.tool(wa, 'cancel', jsonb_build_object('ref_no', ref));
  assert r ->> 'status' = 'CANCELLED', r::text;
  assert (select status from clinic.appointments where id = aid) = 'cancelled';
  assert not exists (select 1 from clinic.appointment_reminders where appointment_id = aid and status = 'scheduled'), 'no reminders for a cancelled visit';

  -- a service the clinic does not have, and one that needs a check-up first
  r := pg_temp.tool(wa, 'update', '{"service":"عملية تجميل أنف"}');
  assert r -> 'problems' -> 0 ->> 'problem' = 'SERVICE_UNKNOWN', r::text;

  -- an emergency flagged by the turn: an alert, the chat marked, the doctor's WhatsApp
  r := clinic.persist_turn(jsonb_build_object('tenant_id', t, 'wa_id', wa, 'run_id', 'run-x',
         'alert', jsonb_build_object('kind', 'emergency', 'specialty', 'dentistry', 'body', 'وشي وارم ومش قادر أبلع', 'data', jsonb_build_object('words', 'مش قادر ابلع'))));
  assert (r -> 'alert' ->> 'alert_id') is not null, r::text;
  assert (select urgency from clinic.conversations where tenant_id = t and wa_id = wa) = 'emergency';
  assert exists (select 1 from clinic.outbox where tenant_id = t and purpose = 'staff_alert' and to_jid = '201000000101'), 'the dentist was told';
  -- a repeat within half an hour updates the same alert
  r2 := clinic.persist_turn(jsonb_build_object('tenant_id', t, 'wa_id', wa, 'run_id', 'run-y',
         'alert', jsonb_build_object('kind', 'emergency', 'body', 'لسه وارم')));
  assert (r2 -> 'alert' ->> 'repeat')::boolean, r2::text;
end $$;
