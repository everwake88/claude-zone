-- =====================================================================
-- Everwake Clinic · 009 · who can see and change what
--
-- Three kinds of caller:
--   · the n8n engine and maintenance scripts — a database role (or the
--     Supabase service role): full access, no user
--   · a dashboard user — Supabase role `authenticated` with a JWT: sees
--     only the clinics they belong to (row level security), and does
--     everything sensitive through the SECURITY DEFINER functions of
--     002–008, each of which checks the role first
--   · anon — nothing at all (the patient's manage page goes through the
--     dashboard's server with the service role)
--
-- The medical record (encounters, conditions, allergies, medications,
-- history, vitals, documents, dental chart, treatment plans) is readable
-- only by members marked clinical. A receptionist books, checks in and
-- answers chats, and never reads it.
-- =====================================================================

do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then create role anon nologin; end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then create role authenticated nologin; end if;
  if not exists (select 1 from pg_roles where rolname = 'service_role') then create role service_role nologin bypassrls; end if;
end $$;

revoke all on schema clinic from public;
grant usage on schema clinic to authenticated, service_role;

revoke all on all tables in schema clinic from public, anon, authenticated;
revoke all on all sequences in schema clinic from public, anon, authenticated;
revoke execute on all functions in schema clinic from public, anon, authenticated;
alter default privileges in schema clinic revoke execute on functions from public;

grant all on all tables in schema clinic to service_role;
grant all on all sequences in schema clinic to service_role;
grant execute on all functions in schema clinic to service_role;

-- ---------------------------------------------------------------------
-- Reading
-- ---------------------------------------------------------------------
grant select on clinic.tenants, clinic.tenant_members, clinic.tenant_invites, clinic.platform_admins, clinic.specialty_presets,
                clinic.doctors, clinic.locations, clinic.resources, clinic.schedules, clinic.schedule_exceptions,
                clinic.services, clinic.service_prices, clinic.offers, clinic.knowledge_entries, clinic.agent_rules,
                clinic.catalog_imports, clinic.catalog_changes, clinic.catalog_snapshot,
                clinic.contacts, clinic.contact_identities, clinic.conversations, clinic.messages, clinic.outbox,
                clinic.team_questions, clinic.agent_pauses, clinic.pause_contacts, clinic.agent_events,
                clinic.patients, clinic.patient_contacts, clinic.form_templates, clinic.encounters, clinic.conditions,
                clinic.allergies, clinic.medications, clinic.patient_history, clinic.vitals, clinic.documents,
                clinic.dental_chart, clinic.treatment_plans, clinic.treatment_plan_items, clinic.record_access_log,
                clinic.appointments, clinic.appointment_events, clinic.waitlist, clinic.alerts,
                clinic.appointment_reminders, clinic.delay_notices, clinic.delay_notice_items, clinic.audit_log
  to authenticated;
grant select (id, tenant_id, provider, label, phone_number, instance_name, base_url, cloud_phone_number_id,
              status, is_active, last_inbound_at, connected_at, created_at, updated_at)
  on clinic.whatsapp_channels to authenticated;

-- ---------------------------------------------------------------------
-- Writing what the clinic sets up (RLS narrows it to owners, managers, doctors)
-- ---------------------------------------------------------------------
grant insert, update, delete on clinic.doctors, clinic.locations, clinic.resources, clinic.schedules, clinic.schedule_exceptions,
                                clinic.services, clinic.service_prices, clinic.offers, clinic.knowledge_entries, clinic.agent_rules,
                                clinic.form_templates
  to authenticated;
grant insert, update on clinic.catalog_imports to authenticated;
grant update (name_ar, name_en, timezone, currency, currency_symbol_ar, default_language, specialty, ref_prefix, profile, settings)
  on clinic.tenants to authenticated;
grant update (full_name, notes, tags, is_blocked, language) on clinic.contacts to authenticated;
grant update (tags, notes, preferences) on clinic.patients to authenticated;
grant insert, update, delete on clinic.waitlist to authenticated;
grant update (staff_notes, pre_visit) on clinic.appointments to authenticated;

-- ---------------------------------------------------------------------
-- The functions the dashboard calls
-- ---------------------------------------------------------------------
grant execute on function
  clinic.current_user_id(), clinic.member_role(uuid), clinic.is_platform_admin(), clinic.my_tenant_ids(),
  clinic.my_editor_tenant_ids(), clinic.my_clinical_tenant_ids(), clinic.can_see_clinical(uuid), clinic.my_name(uuid),
  clinic.norm(text), clinic.digits(text), clinic.fmt_money(numeric), clinic.wa_phone(text, text),
  clinic.default_settings(), clinic.default_profile(), clinic.merged_settings(jsonb), clinic.merged_profile(jsonb),
  clinic.render_template(text, jsonb), clinic.doctor_label(uuid, text), clinic.location_label(uuid, text),
  clinic.day_name(int, text), clinic.clock_text(time, text), clinic.unit_text(text, text),
  clinic.price_words(text, numeric, numeric, text, text, text), clinic.service_offered(uuid, uuid, uuid),
  clinic.service_price(uuid, uuid, uuid), clinic.match_service(uuid, text, uuid), clinic.match_doctor(uuid, text),
  clinic.match_location(uuid, text), clinic.age_years(date, date), clinic.age_text(date, text),
  clinic.catalog_change(uuid, jsonb, boolean, text), clinic.catalog_apply(bigint), clinic.catalog_undo(bigint),
  clinic.set_agent_enabled(uuid, boolean, text, boolean), clinic.take_over(bigint, text), clinic.hand_back(bigint),
  clinic.send_staff_message(bigint, text, text, text, text, text), clinic.mark_read(bigint), clinic.resolve_attention(bigint),
  clinic.answer_team_question(bigint, text, text), clinic.dismiss_team_question(bigint),
  clinic.save_channel(uuid, jsonb), clinic.remove_channel(uuid), clinic.channel_webhook_token(uuid),
  clinic.log_record_access(bigint, text, text), clinic.acknowledge_alert(bigint, boolean), clinic.plan_quote(bigint),
  clinic.plan_total(bigint), clinic.plan_text(bigint, text),
  clinic.apply_preset(uuid, text, uuid), clinic.create_tenant(text, text, text, text, text, text), clinic.my_tenants(),
  clinic.onboarding_checklist(uuid), clinic.go_live(uuid, boolean),
  clinic.invite_member(uuid, text, text, boolean, uuid), clinic.accept_invites(), clinic.update_member(uuid, uuid, jsonb),
  clinic.set_my_phone(uuid, text), clinic.remove_member(uuid, uuid),
  clinic.today_board(uuid, date, uuid), clinic.calendar_range(uuid, date, date, uuid), clinic.dashboard_counts(uuid),
  clinic.staff_book(uuid, jsonb), clinic.move_appointment(bigint, jsonb), clinic.set_appointment_status(bigint, text, text, boolean),
  clinic.dashboard_delay(uuid, jsonb), clinic.dashboard_cancel_session(uuid, jsonb), clinic.dashboard_block_time(uuid, jsonb),
  clinic.dashboard_slots(uuid, jsonb), clinic.add_waitlist(uuid, jsonb),
  clinic.patient_search(uuid, text, int), clinic.patient_profile(bigint), clinic.save_patient(uuid, jsonb),
  clinic.save_record(bigint, text, jsonb), clinic.save_encounter(bigint, jsonb), clinic.set_teeth(bigint, jsonb),
  clinic.save_plan(bigint, jsonb), clinic.publish_catalog_import(uuid, jsonb, text), clinic.agent_digest(uuid)
  to authenticated;

-- ---------------------------------------------------------------------
-- Row level security
-- ---------------------------------------------------------------------
do $$
declare t text;
begin
  foreach t in array array['tenants', 'platform_admins', 'tenant_members', 'tenant_invites', 'doctors', 'locations', 'resources',
                           'schedules', 'schedule_exceptions', 'services', 'service_prices', 'offers', 'knowledge_entries',
                           'agent_rules', 'catalog_imports', 'catalog_changes', 'catalog_snapshot', 'whatsapp_channels', 'contacts',
                           'contact_identities', 'conversations', 'messages', 'outbox', 'inbound_buffer', 'conversation_locks',
                           'team_questions', 'agent_pauses', 'pause_contacts', 'agent_events', 'patients', 'patient_contacts',
                           'form_templates', 'encounters', 'conditions', 'allergies', 'medications', 'patient_history', 'vitals',
                           'documents', 'dental_chart', 'treatment_plans', 'treatment_plan_items', 'record_access_log',
                           'appointments', 'appointment_events', 'booking_drafts', 'waitlist', 'alerts', 'appointment_reminders',
                           'delay_notices', 'delay_notice_items', 'audit_log'] loop
    execute format('alter table clinic.%I enable row level security', t);
  end loop;

  -- members read their clinic's rows
  foreach t in array array['tenant_members', 'doctors', 'locations', 'resources', 'schedules', 'schedule_exceptions', 'services',
                           'service_prices', 'offers', 'knowledge_entries', 'agent_rules', 'catalog_imports', 'catalog_changes',
                           'catalog_snapshot', 'whatsapp_channels', 'contacts', 'contact_identities', 'conversations', 'messages',
                           'outbox', 'team_questions', 'agent_pauses', 'pause_contacts', 'patients', 'patient_contacts',
                           'form_templates', 'appointments', 'appointment_events', 'waitlist', 'alerts', 'appointment_reminders',
                           'delay_notices', 'delay_notice_items'] loop
    execute format('create policy member_read on clinic.%I for select to authenticated
                      using (tenant_id = any ((select clinic.my_tenant_ids())::uuid[]))', t);
  end loop;

  -- the medical record: clinical members only
  foreach t in array array['encounters', 'conditions', 'allergies', 'medications', 'patient_history', 'vitals', 'documents',
                           'dental_chart', 'treatment_plans', 'treatment_plan_items'] loop
    execute format('create policy clinical_read on clinic.%I for select to authenticated
                      using (tenant_id = any ((select clinic.my_clinical_tenant_ids())::uuid[]))', t);
  end loop;

  -- owners, managers and doctors change the set-up and the catalogue
  foreach t in array array['doctors', 'locations', 'resources', 'schedules', 'schedule_exceptions', 'services', 'service_prices',
                           'offers', 'knowledge_entries', 'agent_rules', 'catalog_imports', 'form_templates'] loop
    execute format('create policy editor_write on clinic.%I for all to authenticated
                      using (tenant_id = any ((select clinic.my_editor_tenant_ids())::uuid[]))
                      with check (tenant_id = any ((select clinic.my_editor_tenant_ids())::uuid[]))', t);
  end loop;

  -- any member: the patient's tags and notes, a contact's note, the waitlist, a visit's front-desk note
  foreach t in array array['patients', 'contacts', 'waitlist', 'appointments'] loop
    execute format('create policy member_write on clinic.%I for update to authenticated
                      using (tenant_id = any ((select clinic.my_tenant_ids())::uuid[]))
                      with check (tenant_id = any ((select clinic.my_tenant_ids())::uuid[]))', t);
  end loop;
end $$;

create policy member_insert on clinic.waitlist for insert to authenticated
  with check (tenant_id = any ((select clinic.my_tenant_ids())::uuid[]));
create policy member_delete on clinic.waitlist for delete to authenticated
  using (tenant_id = any ((select clinic.my_tenant_ids())::uuid[]));

create policy member_read on clinic.tenants for select to authenticated
  using (id = any ((select clinic.my_tenant_ids())::uuid[]));
create policy editor_update on clinic.tenants for update to authenticated
  using (id = any ((select clinic.my_editor_tenant_ids())::uuid[]))
  with check (id = any ((select clinic.my_editor_tenant_ids())::uuid[]));
create policy self_read on clinic.platform_admins for select to authenticated using (user_id = clinic.current_user_id());
create policy owner_read on clinic.tenant_invites for select to authenticated using (clinic.member_role(tenant_id) = 'owner');
create policy anyone_read on clinic.specialty_presets for select to authenticated using (true);
alter table clinic.specialty_presets enable row level security;

-- telemetry, the audit trail and who opened which record: owners and managers
create policy owner_read on clinic.agent_events for select to authenticated
  using (clinic.member_role(tenant_id) in ('owner', 'manager'));
create policy owner_read on clinic.audit_log for select to authenticated
  using (clinic.member_role(tenant_id) in ('owner', 'manager'));
create policy owner_read on clinic.record_access_log for select to authenticated
  using (clinic.member_role(tenant_id) in ('owner', 'manager'));
