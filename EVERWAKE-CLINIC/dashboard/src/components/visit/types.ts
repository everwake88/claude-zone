import type { ApptCard } from '@/lib/types';
import type { Extraction, RecordItem } from '@/lib/scribe/schema';
import type { Segment } from '@/lib/scribe/transcript';
import type { Verification } from '@/lib/scribe/verify';
import type { FormTemplate, Tooth } from '../patients/types';

export type RecStatus = 'recording' | 'processing' | 'review' | 'signed' | 'failed' | 'discarded';
export interface Recording {
  id: number; status: RecStatus; patient_id: number; appointment_id: number; encounter_id: number | null;
  chunks: { seq: number; ms: number; text: string; path?: string }[]; duration_ms: number;
  transcript: { segments: Segment[] }; diarized: boolean; consent_at: string; consent_text: string;
  audio_deleted_at: string | null; error: string | null; created_at: string;
}
export interface Run {
  id: number; recording_id: number; models: Record<string, string>; extraction: Extraction; verification: Verification;
  outputs: { soap?: Extraction['soap']; summary_ar?: string; prescription?: RecordItem[] }; created_at: string;
}
export interface VisitEncounter {
  id: number; status: 'draft' | 'signed'; template_id: string | null; chief_complaint: string | null;
  data: Record<string, Record<string, unknown>>; sources: Record<string, unknown>; assessment: string | null; plan: string | null;
  follow_up_date: string | null; signed_at: string | null;
}
export interface VisitContext {
  appointment: ApptCard & { pre_visit: Record<string, string> | null };
  doctor: { id: string; name: string; name_en: string; specialty: string };
  template: FormTemplate | null;
  patient: { id: number; full_name: string; file_no: string; sex: string | null; birth_date: string | null; age: string | null; age_en: string | null; phone: string | null };
  record: { allergies: { id: number; substance: string; reaction: string | null }[]; medications: { id: number; name: string; dose: string | null }[];
            conditions: { id: number; name: string }[]; teeth: Tooth[] };
  recording: Recording | null;
  run: Run | null;
  encounter: VisitEncounter | null;
  terms: string[];
  audio_days: number;
}
