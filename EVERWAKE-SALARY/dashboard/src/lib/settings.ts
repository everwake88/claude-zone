import 'server-only';
import { one } from './db';

export type Settings = {
  company_name: string; agent_name: string; hr_contact: string; agent_enabled: boolean;
  ask_full_name: boolean; ask_national_id: boolean; ask_work_id: boolean; ask_phone: boolean;
  phone_must_match_sender: boolean; hidden_number_ask_phone: boolean; name_min_words: number; work_id_digits_only: boolean;
  work_id_min_length: number; work_id_max_length: number; verified_hours: number;
};
export const FIELDS = ['full_name', 'national_id', 'work_id', 'phone'] as const;
export type Field = (typeof FIELDS)[number];

export async function getSettings(): Promise<Settings> {
  return (await one<Settings>('select * from salary.settings'))!;
}
export const askedFields = (s: Settings): Field[] => FIELDS.filter((f) => s[`ask_${f}` as const]);
