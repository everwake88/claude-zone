'use client';
import { useTenant } from '@/components/tenant';
import { sb } from './supabase/client';
import type { Doctor, Location, Resource, Schedule, Service } from './types';
import { useCached } from './use-cached';

// The clinic's doctors, locations, chairs, schedules and services: read once and kept while the
// dashboard is open (forms and filters on every page need them).
export interface ClinicData { doctors: Doctor[]; locations: Location[]; resources: Resource[]; schedules: Schedule[]; services: Service[] }

export function useClinic() {
  const { tenant } = useTenant();
  const r = useCached<ClinicData>(`clinic:${tenant.id}`, async () => {
    const db = sb();
    const q = (table: string) => db.from(table).select('*').eq('tenant_id', tenant.id).order('sort', { ascending: true });
    const [d, l, res, s, sv] = await Promise.all([q('doctors'), q('locations'), q('resources'),
      db.from('schedules').select('*').eq('tenant_id', tenant.id).order('weekday', { ascending: true }), q('services')]);
    return { doctors: (d.data || []) as Doctor[], locations: (l.data || []) as Location[], resources: (res.data || []) as Resource[],
             schedules: (s.data || []) as Schedule[], services: (sv.data || []) as Service[] };
  });
  const data = r.data || { doctors: [], locations: [], resources: [], schedules: [], services: [] };
  return { ...data, ready: !!r.data, refresh: r.refresh };
}

// a doctor's or a place's name in the dashboard's language
export const docName = (d: Doctor | undefined, lang: 'ar' | 'en') =>
  !d ? '' : lang === 'en' ? [d.title_en, d.name_en || d.name_ar].filter(Boolean).join(' ') : [d.title_ar, d.name_ar].filter(Boolean).join(' ');
export const placeName = (l: Location | undefined, lang: 'ar' | 'en') => (!l ? '' : lang === 'en' && l.name_en ? l.name_en : l.name_ar);
export const serviceName = (s: Service | undefined, lang: 'ar' | 'en') => (!s ? '' : lang === 'en' && s.name_en ? s.name_en : s.name_ar);
