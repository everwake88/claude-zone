-- =====================================================================
-- Everwake Orders · patch 2026-11-05 · AI usage written by the engine itself
-- n8n now calls OpenAI directly (no meter in the dashboard) and saves each
-- call's usage, exactly as OpenAI reported it, through record_ai_usage.
-- Each call also keeps the prices its cost was worked out with.
-- Run after 2026-11-04_ai_costs_and_bills.sql. Safe to run again.
-- =====================================================================

alter table everwake.ai_usage add column if not exists price_in_per_m numeric(12, 4),
  add column if not exists price_cached_per_m numeric(12, 4), add column if not exists price_out_per_m numeric(12, 4),
  add column if not exists price_audio_per_minute numeric(12, 4);

-- the price of a call, from the longest model prefix that has one
create or replace function everwake.ai_usage_price() returns trigger
language plpgsql security definer set search_path = everwake, pg_temp as $$
declare p everwake.ai_prices%rowtype;
begin
  if new.wa_id is null and new.message_id is not null then
    select m.wa_id into new.wa_id from everwake.messages m where m.id = new.message_id;
  end if;
  select * into p from everwake.ai_prices
   where new.model is not null and lower(new.model) like lower(model) || '%'
   order by length(model) desc limit 1;
  if found then
    new.cost_usd := case
      when new.audio_seconds is not null and p.audio_per_minute is not null and new.input_tokens = 0
        then new.audio_seconds / 60.0 * p.audio_per_minute
      else (greatest(new.input_tokens - new.cached_tokens, 0) * p.input_per_m
            + new.cached_tokens * p.cached_per_m + new.output_tokens * p.output_per_m) / 1000000.0 end;
    new.priced := true;
    new.price_in_per_m := p.input_per_m; new.price_cached_per_m := p.cached_per_m;
    new.price_out_per_m := p.output_per_m; new.price_audio_per_minute := p.audio_per_minute;
  end if;
  return new;
end $$;
drop trigger if exists ai_usage_price on everwake.ai_usage;
create trigger ai_usage_price before insert or update of model, input_tokens, cached_tokens, output_tokens, audio_seconds
  on everwake.ai_usage for each row execute function everwake.ai_usage_price();

-- the engine's own record of its calls to OpenAI: n8n calls OpenAI itself and
-- hands each call's usage here, exactly as OpenAI reported it. Only the engine
-- (the database owner) may call it; no dashboard role can.
create or replace function everwake.record_ai_usage(p_tenant uuid, p_message_id bigint, p_run_id text, p_kind text, p_calls jsonb)
returns int language plpgsql security definer set search_path = everwake, pg_temp as $$
declare n int;
begin
  if p_tenant is null or jsonb_typeof(p_calls) is distinct from 'array' then return 0; end if;
  insert into everwake.ai_usage (tenant_id, run_id, message_id, step, kind, model, endpoint, input_tokens, cached_tokens,
                                 output_tokens, reasoning_tokens, audio_seconds, http_status, duration_ms)
  select p_tenant, left(p_run_id, 120), p_message_id,
         case when c->>'step' in ('brain', 'agent', 'transcribe', 'vision') then c->>'step' else 'other' end,
         case when p_kind in ('text', 'voice', 'image', 'test') then p_kind else 'text' end,
         left(c->>'model', 80), left(c->>'endpoint', 40),
         greatest(coalesce((c->>'input')::numeric, 0), 0)::int, greatest(coalesce((c->>'cached')::numeric, 0), 0)::int,
         greatest(coalesce((c->>'output')::numeric, 0), 0)::int, greatest(coalesce((c->>'thinking')::numeric, 0), 0)::int,
         nullif(c->>'seconds', '')::numeric, nullif(c->>'status', '')::numeric::int, nullif(c->>'ms', '')::numeric::int
    from jsonb_array_elements(p_calls) c
   where jsonb_typeof(c) = 'object' and (c ? 'input' or c ? 'output' or c ? 'seconds' or c ? 'status');
  get diagnostics n = row_count;
  return n;
end $$;
revoke all on function everwake.record_ai_usage(uuid, bigint, text, text, jsonb) from public, anon, authenticated;


revoke execute on function everwake.ai_settings(uuid) from public, anon, authenticated;   -- the engine's, not the dashboard's
grant execute on function everwake.record_ai_usage(uuid, bigint, text, text, jsonb) to service_role;
