-- A voice note is understood before the agent answers; a quick text after it waits for it
do $$
declare
  t    uuid := (select id from everwake.tenants where slug = 'nile_grill');
  base jsonb := jsonb_build_object('instance', 'nilegrill', 'token', 'demo-token');
  r1 jsonb; r2 jsonb; c jsonb; ctx jsonb;
  wa   text := '201300300398';
begin
  r1 := everwake.intake(base || jsonb_build_object('external_id', 'vn1', 'wa_id', wa, 'phone', wa, 'text', '[voice note]',
                                                   'message_type', 'audioMessage', 'media', jsonb_build_object('kind', 'audio')));
  assert (select media_pending from everwake.inbound_buffer where id = (r1 ->> 'buffer_id')::bigint), 'a voice note waits to be understood';
  r2 := everwake.intake(base || jsonb_build_object('external_id', 'vn2', 'wa_id', wa, 'phone', wa, 'text', 'بسرعة لو سمحت'));
  -- the text's run is the newest, but the voice note is still being heard: it waits
  c := everwake.claim_window(t, wa, 'vn-run2', (r2 ->> 'buffer_id')::bigint);
  assert (c ->> 'is_newest')::boolean and not (c ->> 'lock_acquired')::boolean and (c ->> 'waiting_for_media')::boolean, c::text;

  c := everwake.media_understood(jsonb_build_object('buffer_id', r1 ->> 'buffer_id', 'message_id', r1 ->> 'message_id',
         'marker', '[voice note]', 'text', '[voice note: «عايز كيلو كفتة ونص فرخة»]', 'model', 'gpt-transcribe'));
  c := everwake.claim_window(t, wa, 'vn-run2', (r2 ->> 'buffer_id')::bigint);
  assert (c ->> 'lock_acquired')::boolean, c::text;
  assert c ->> 'combined_text' = E'[voice note: «عايز كيلو كفتة ونص فرخة»]\nبسرعة لو سمحت', c::text;

  -- the inbox keeps the marker; the history reads what it said
  assert (select body from everwake.messages where id = (r1 ->> 'message_id')::bigint) = '[voice note]';
  ctx := everwake.turn_context(t, wa);
  assert exists (select 1 from jsonb_array_elements(ctx -> 'recent_messages') m where m ->> 'text' like '[voice note: «عايز كيلو%'), ctx -> 'recent_messages';

  -- a photo with a caption: the description goes with their words
  perform everwake.persist_turn(jsonb_build_object('tenant_id', t, 'wa_id', wa, 'run_id', 'vn-run2'));
  r1 := everwake.intake(base || jsonb_build_object('external_id', 'ph1', 'wa_id', wa, 'phone', wa, 'text', 'عايز ده',
                                                   'message_type', 'imageMessage', 'media', jsonb_build_object('kind', 'image')));
  perform everwake.media_understood(jsonb_build_object('buffer_id', r1 ->> 'buffer_id', 'message_id', r1 ->> 'message_id',
         'marker', 'عايز ده', 'text', '[photo: a plate of grilled kofta with rice] عايز ده'));
  c := everwake.claim_window(t, wa, 'ph-run1', (r1 ->> 'buffer_id')::bigint);
  assert c ->> 'combined_text' = '[photo: a plate of grilled kofta with rice] عايز ده', c::text;

  -- the Test Runner's pretend chats never wait
  r1 := everwake.intake(base || jsonb_build_object('external_id', 'ph2', 'wa_id', '200000000017', 'phone', '200000000017', 'text', '[photo]',
                                                   'media', jsonb_build_object('kind', 'image'), 'test_run', true));
  assert not (select media_pending from everwake.inbound_buffer where id = (r1 ->> 'buffer_id')::bigint);
end $$;
