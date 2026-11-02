// What the dashboard reads from the clinic schema (EVERWAKE-CLINIC/database).
export type Role = 'owner' | 'manager' | 'doctor' | 'nurse' | 'receptionist';
export type ApptStatus = 'held' | 'booked' | 'confirmed' | 'arrived' | 'in_visit' | 'done' | 'no_show' | 'cancelled';

export interface TenantSummary {
  id: string; slug: string; name_ar: string; name_en: string; status: 'onboarding' | 'live' | 'suspended' | 'cancelled';
  agent_enabled: boolean; currency: string; currency_symbol: string; timezone: string; default_language: 'ar' | 'en';
  specialty: string; role: Role; clinical: boolean; doctor_id: string | null;
}
export interface Brand { logo_url?: string; color?: string }

export interface ApptCard {
  id: number; ref_no: string; status: ApptStatus; mode: 'slot' | 'queue'; source: string;
  doctor_id: string; location_id: string; resource_id: string | null; resource: string | null;
  service_id: string | null; service: string | null; service_en: string | null; category: string | null;
  patient_id: number | null; patient: string | null; file_no: string | null; sex: 'male' | 'female' | null; age: string | null; age_en: string | null;
  phone: string | null; whatsapp: boolean; wa_id: string | null; conversation_id: number | null;
  starts_at: string; ends_at: string; est_at: string | null; queue_no: number | null; session_date: string;
  original_starts_at: string | null; delay_minutes: number; reason: string | null; urgency: string;
  is_new: boolean; is_follow_up: boolean; price_text: string | null; price: number | null; payment_status: string;
  confirmed_at: string | null; arrived_at: string | null; visit_started_at: string | null; visit_ended_at: string | null;
  staff_notes: string | null; plan_item_id: number | null; allergies: string[] | null;
  visits_count: number | null; last_visit_at: string | null; no_show_count: number | null; delay_reply: string | null;
  waiting_minutes?: number; created_at?: string;
}
export interface SessionBlock {
  doctor_id: string; doctor: string; doctor_en: string; color: string | null; specialty: string;
  location_id: string; location: string; location_en: string; starts_at: string; ends_at: string;
  mode: 'slots' | 'queue' | 'both'; capacity: number | null; delay_minutes: number; appointments: ApptCard[];
}
export interface Alert {
  id: number; kind: string; severity: 'critical' | 'high' | 'normal' | 'low'; title: string; body: string | null;
  patient_id: number | null; contact_id: number | null; wa_id: string | null; conversation_id: number | null;
  appointment_id: number | null; doctor_id: string | null; data: Record<string, unknown>; status: string; created_at: string;
  acknowledged_by_name?: string | null;
}
export interface DelayNotice {
  id: number; kind: 'delay' | 'cancel_session'; doctor: string; doctor_id: string; minutes: number; reason: string | null;
  via: string; by: string | null; at: string; tally: Record<string, number> | null;
}
export interface TodayBoard {
  date: string; now: string; timezone: string; clinical: boolean;
  sessions: SessionBlock[]; outside: ApptCard[]; waiting_room: ApptCard[];
  next: (ApptCard & { conditions: string[] | null; medications: string[] | null;
                      last_visit: { date: string; service: string; doctor: string } | null; documents: number; pre_visit: Record<string, unknown> }) | null;
  counts: Record<'total' | 'booked' | 'confirmed' | 'arrived' | 'in_visit' | 'done' | 'no_show' | 'cancelled' | 'new_patients' | 'by_agent' | 'expected' | 'collected', number>;
  tomorrow_unconfirmed: number; agent_today: ApptCard[]; delays: DelayNotice[]; alerts: Alert[];
}
export interface Doctor {
  id: string; code: string; name_ar: string; name_en: string | null; title_ar: string; title_en: string; gender: 'male' | 'female' | null;
  specialty: string; sub_specialty_ar: string | null; bio_ar: string | null; color: string | null; ops_whatsapp: string | null;
  follow_up_days: number; accepts_new: boolean; is_active: boolean; sort: number; user_id: string | null;
}
export interface Location {
  id: string; code: string; name_ar: string; name_en: string | null; aliases: string[]; area_ar: string | null; address_ar: string | null;
  address_en: string | null; directions_ar: string | null; lat: number | null; lng: number | null; maps_url: string | null; phone: string | null;
  is_active: boolean; sort: number;
}
export interface Resource { id: string; location_id: string; kind: string; name_ar: string; name_en: string | null; is_active: boolean; sort: number }
export interface Schedule {
  id: string; doctor_id: string; location_id: string; weekday: number; start_time: string; end_time: string;
  mode: 'slots' | 'queue' | 'both'; slot_minutes: number; capacity: number | null; online_booking: boolean; is_active: boolean;
}
export interface ScheduleException {
  id: string; doctor_id: string; location_id: string | null; on_date: string; kind: 'off' | 'extra' | 'changed';
  start_time: string | null; end_time: string | null; reason: string | null;
}
export type PriceKind = 'fixed' | 'range' | 'from' | 'after_exam' | 'free';
export interface Service {
  id: string; code: string; category: string; specialty: string | null; name_ar: string; name_en: string | null; aliases: string[];
  description_ar: string | null; duration_min: number; price_kind: PriceKind; price: number | null; price_max: number | null;
  price_unit: string; price_note_ar: string | null; sessions: number; session_gap_days: number | null; prep_ar: string | null;
  aftercare_ar: string | null; doctor_ids: string[]; location_ids: string[]; days: number[]; min_age: number | null; max_age: number | null;
  needs_consult_first: boolean; resource_kind: string | null; agent_visible: boolean; bookable: boolean; is_active: boolean; sort: number;
}
export interface Offer {
  id: string; title_ar: string; description_ar: string | null; kind: string; value: number; service_ids: string[];
  starts_at: string | null; ends_at: string | null; is_active: boolean;
}
export interface Knowledge { id: string; topic: string; content_ar: string | null; content_en: string | null; doctor_id: string | null; is_active: boolean; sort: number }
export interface AgentRule { id: string; kind: string; doctor_id: string | null; params: Record<string, unknown>; text_ar: string | null; is_active: boolean }
export interface Slot {
  kind: 'slot' | 'queue'; doctor_id: string; doctor: string; location_id: string; location: string; resource_id?: string | null;
  starts_at: string; ends_at: string; date: string; time: string; band: string; label_ar: string; label_en: string;
  queue_no?: number; est_at?: string; left?: number | null;
}
