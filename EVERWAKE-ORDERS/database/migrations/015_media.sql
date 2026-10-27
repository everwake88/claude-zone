-- =====================================================================
-- Everwake Orders · 015 · photos and voice notes the agent understands
--
-- A customer's photo or voice note is fetched from WhatsApp and given to
-- a model (Main: Transcribe / Look At Photo) before the agent answers:
--   · intake (004) marks its buffer row media_pending
--   · claim_window (004) waits while one is pending (a minute at most),
--     so a quick text after a voice note is answered together with it
--   · media_understood writes what it said or showed into the buffer
--     ("[voice note: «…»]", "[photo: …]") and into the message (meta.
--     understood) for the inbox and the chat history (turn_context)
-- =====================================================================

alter table everwake.inbound_buffer add column if not exists media_pending boolean not null default false;

create or replace function everwake.media_understood(p jsonb)
returns jsonb language plpgsql as $$
declare
  v_text   text := nullif(btrim(p ->> 'text'), '');
  v_marker text := coalesce(p ->> 'marker', '');
  n int;
begin
  update everwake.inbound_buffer b
     set message_text = case when v_text is null then b.message_text
                             when v_marker <> '' and position(v_marker in coalesce(b.message_text, '')) > 0
                             then replace(b.message_text, v_marker, v_text)
                             else concat_ws(' ', nullif(b.message_text, ''), v_text) end,
         media_pending = false
   where b.id = (p ->> 'buffer_id')::bigint;
  get diagnostics n = row_count;
  if v_text is not null and nullif(p ->> 'message_id', '') is not null then
    update everwake.messages
       set meta = meta || jsonb_build_object('understood', v_text, 'understood_by', p ->> 'model')
     where id = (p ->> 'message_id')::bigint;
  end if;
  return jsonb_build_object('buffer_rows', n);
end $$;

revoke execute on function everwake.media_understood(jsonb) from public, anon, authenticated;
