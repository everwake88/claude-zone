-- =====================================================================
-- Everwake Clinic · 011 · what the dashboard reads in one call
--
-- Small read functions the dashboard's pages use, so a page asks once and
-- gets names along with the ids (the patient behind an alert, the doctor of
-- a waitlist entry). Each checks the caller's role first.
-- =====================================================================

-- alerts with who they are about: the emergency banner, Today, the Alerts page
create or replace function clinic.alert_list(p_tenant uuid, p_status text default 'open', p_kind text default null, p_limit int default 50)
returns jsonb language plpgsql stable security definer set search_path = clinic, pg_temp as $$
begin
  perform clinic.require_role(p_tenant, array['owner', 'manager', 'doctor', 'nurse', 'receptionist']);
  return coalesce((select jsonb_agg(x order by (x ->> 'severity' = 'critical') desc, (x ->> 'created_at') desc) from (
    select to_jsonb(al) || jsonb_build_object(
             'who', coalesce(p.full_name, co.full_name, co.display_name),
             'phone', coalesce(co.phone, p.phone),
             'doctor', clinic.doctor_label(al.doctor_id, 'ar'),
             'appointment', (select clinic.appt_when(a) from clinic.appointments a where a.id = al.appointment_id)) as x
      from clinic.alerts al
      left join clinic.patients p on p.id = al.patient_id
      left join clinic.contacts co on co.id = al.contact_id
     where al.tenant_id = p_tenant
       and (p_status is null or p_status = 'all' or al.status = p_status)
       and (p_kind is null or al.kind = p_kind)
     order by al.created_at desc
     limit least(coalesce(p_limit, 50), 200)) q), '[]'::jsonb);
end $$;

grant execute on function clinic.alert_list(uuid, text, text, int) to authenticated;
