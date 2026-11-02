import type { ApptCard } from '@/lib/types';

export interface RecordRow { id: number; status?: string; created_at: string; updated_at?: string; source?: string; notes?: string | null; [k: string]: unknown }
export interface Tooth { tooth: number; condition: string; surfaces: string[]; planned: string | null; notes: string | null; updated_at: string }
export interface PlanItem { id: number; seq: number; tooth: number | null; service_id: string | null; label: string; price: number | null; sessions: number;
  session_gap_days: number | null; done_sessions: number; status: string; notes: string | null }
export interface Plan { id: number; title: string; status: string; discount: number; notes: string | null; doctor: string; doctor_id: string | null; total: number;
  quoted_at: string | null; accepted_at: string | null; created_at: string; items: PlanItem[] }
export interface Encounter { id: number; status: 'draft' | 'signed'; chief_complaint: string | null; data: Record<string, Record<string, unknown>>;
  assessment: string | null; plan: string | null; diagnoses: { name: string }[]; follow_up_date: string | null; started_at: string; signed_at: string | null;
  doctor: string | null; template_id: string | null; appointment_id: number | null }
export interface FormField { key: string; label_ar: string; label_en: string; type: string; unit?: string; options?: string[] }
export interface FormTemplate { id: string; name: string; specialty: string; schema: { sections: { key: string; title_ar: string; title_en: string; fields: FormField[] }[] } }
export interface Doc { id: number; kind: string; title: string | null; url: string | null; mime: string | null; source: string; ai_summary: string | null;
  ai_values: { name: string; value: string; unit?: string; flag?: string }[] | null; created_at: string }
export interface Profile {
  patient: { id: number; file_no: string; full_name: string; sex: string | null; birth_date: string | null; age: string | null; age_en: string | null; age_years: number | null;
    phone: string | null; national_id: string | null; blood_group: string | null; marital_status: string | null; occupation: string | null; address: string | null;
    insurance: string | null; tags: string[]; notes: string | null; visits_count: number; no_show_count: number; last_visit_at: string | null; first_visit_at: string | null; created_at: string };
  clinical: boolean;
  contacts: { contact_id: number; relation: string; name: string | null; phone: string | null; wa_id: string | null; conversation_id: number | null }[];
  family: { id: number; full_name: string; relation: string }[];
  appointments: ApptCard[];
  conditions: RecordRow[] | null; allergies: RecordRow[] | null; medications: RecordRow[] | null; history: RecordRow[] | null; vitals: RecordRow[] | null;
  encounters: Encounter[] | null; documents: Doc[] | null; dental_chart: Tooth[] | null; plans: Plan[] | null; templates: FormTemplate[] | null;
}
