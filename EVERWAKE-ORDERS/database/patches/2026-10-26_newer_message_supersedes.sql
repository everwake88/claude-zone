-- =====================================================================
-- A newer message drops the reply being thought out.
-- When the customer writes again while the agent is still working on a
-- reply, that reply is not sent: the turn's messages go back to wait and
-- the next turn answers everything together. A turn that did something
-- final (placed an order, sent a booking, made a payment link) always
-- sends its reply. Run once in the Supabase SQL editor; safe to run again.
-- =====================================================================
create or replace function everwake.persist_turn(p jsonb)
returns jsonb language plpgsql as $$
declare
  v_tenant  uuid := (p ->> 'tenant_id')::uuid;
  v_wa      text := p ->> 'wa_id';
  v_run     text := p ->> 'run_id';
  v_handoff boolean := coalesce((p -> 'handoff' ->> 'needed')::boolean, false);
  v_final   boolean := coalesce((p ->> 'final')::boolean, false);
  v_take    boolean;
  v_since   timestamptz;
  n_state int; n_unlock int; n_clean int;
begin
  -- the customer wrote again while this reply was being thought out: it is dropped, and this turn's
  -- messages go back to wait so the next turn answers them all together — the way a person who sees
  -- a new message arrive stops typing and reads it. Not when this turn did something final (placed an
  -- order, sent a booking, made a payment link): that reply always goes out.
  select l.locked_at into v_since from everwake.conversation_locks l
   where l.tenant_id = v_tenant and l.wa_id = v_wa and l.run_id = v_run;
  if not v_final and v_since is not null and exists (
       select 1 from everwake.inbound_buffer b
        where b.tenant_id = v_tenant and b.wa_id = v_wa and b.claimed_by_run_id is null and b.received_at > v_since) then
    update everwake.inbound_buffer set claimed_by_run_id = null
     where tenant_id = v_tenant and wa_id = v_wa and claimed_by_run_id = v_run;
    get diagnostics n_clean = row_count;
    delete from everwake.conversation_locks where tenant_id = v_tenant and wa_id = v_wa and run_id = v_run;
    get diagnostics n_unlock = row_count;
    insert into everwake.agent_events (tenant_id, wa_id, run_id, stage, input, output)
    values (v_tenant, v_wa, v_run, 'superseded', coalesce(p -> 'log_row' -> 'input', '{}'::jsonb),
            jsonb_build_object('dropped_reply', p -> 'log_row' -> 'output' -> 'messages'));
    return jsonb_build_object('superseded', true, 'state_written', 0, 'locks_released', n_unlock, 'buffer_rows_returned', n_clean);
  end if;

  select coalesce((everwake.merged_settings(settings) ->> 'auto_takeover_on_handoff')::boolean, false)
    into v_take from everwake.tenants where id = v_tenant;

  update everwake.conversations c
     set state = coalesce(c.state, '{}'::jsonb)
                 || coalesce(p -> 'state_patch', '{}'::jsonb)
                 || jsonb_build_object('ledger',
                      coalesce(c.state -> 'ledger', '{}'::jsonb)
                      || coalesce(p -> 'ledger_patch', '{}'::jsonb)
                      || case when coalesce((p ->> 'save_review')::boolean, false)
                              then jsonb_build_object('review_hash', everwake.review_hash(v_tenant, v_wa), 'review_at', now())
                              else '{}'::jsonb end),
         needs_attention  = c.needs_attention or v_handoff,
         attention_reason = case when v_handoff then nullif(p -> 'handoff' ->> 'reason', '') else c.attention_reason end,
         attention_at     = case when v_handoff then now() else c.attention_at end,
         mode             = case when v_handoff and v_take then 'human' else c.mode end,
         human_since      = case when v_handoff and v_take and c.mode = 'agent' then now() else c.human_since end,
         human_reason     = case when v_handoff and v_take and c.mode = 'agent' then 'agent asked for a person: ' || coalesce(p -> 'handoff' ->> 'reason', '') else c.human_reason end
   where c.tenant_id = v_tenant and c.wa_id = v_wa;
  get diagnostics n_state = row_count;

  if nullif(p ->> 'language', '') is not null then
    update everwake.customers set language = p ->> 'language'
     where tenant_id = v_tenant and wa_id = v_wa and language is distinct from p ->> 'language';
  end if;

  insert into everwake.agent_events
    (tenant_id, wa_id, run_id, stage, order_stage, cart_action, qa_passed, repair_used, llm_calls,
     duration_total_ms, duration_llm_ms, prompt_tokens, completion_tokens, cached_tokens, input, output)
  select v_tenant, v_wa, v_run, 'turn_complete', l ->> 'order_stage', l ->> 'cart_action',
         (l ->> 'qa_passed')::boolean, (l ->> 'repair_used')::boolean, (l ->> 'llm_calls')::int,
         (l ->> 'duration_total_ms')::int, (l ->> 'duration_llm_ms')::int, (l ->> 'prompt_tokens')::int,
         (l ->> 'completion_tokens')::int, coalesce((l ->> 'cached_tokens')::int, 0),
         coalesce(l -> 'input', '{}'::jsonb), coalesce(l -> 'output', '{}'::jsonb)
    from (select coalesce(p -> 'log_row', '{}'::jsonb) as l) x;

  delete from everwake.conversation_locks where tenant_id = v_tenant and wa_id = v_wa and run_id = v_run;
  get diagnostics n_unlock = row_count;
  delete from everwake.inbound_buffer where tenant_id = v_tenant and wa_id = v_wa and claimed_by_run_id = v_run;
  get diagnostics n_clean = row_count;

  -- a person may have taken over (or the agent been switched off) while
  -- the model was thinking: the reply is then not sent
  return jsonb_build_object('state_written', n_state, 'locks_released', n_unlock, 'buffer_rows_cleared', n_clean,
                            'mode', (select mode from everwake.conversations where tenant_id = v_tenant and wa_id = v_wa),
                            'agent_enabled', (select agent_enabled from everwake.tenants where id = v_tenant));
end $$;
