'use client';
import { useCallback } from 'react';
import { useLang } from '@/lib/i18n';
import { sb } from '@/lib/supabase/client';
import { useCached } from '@/lib/use-cached';
import { useAction } from '../ui';
import { useTenant } from '../tenant';

export interface TenantRow { name_ar: string; name_en: string; profile: Record<string, unknown>; settings: Record<string, unknown>; timezone: string; specialty: string;
  merged_settings: Record<string, unknown>; merged_profile: Record<string, unknown> }

// The clinic's own row: its profile (what the assistant knows) and settings, as stored (only what
// was changed) and merged over the defaults (what is in force). Saving merges a patch into the stored copy.
export function useTenantRow() {
  const { tenant } = useTenant();
  const { t } = useLang();
  const { busy, run } = useAction();
  const { data, refresh, put } = useCached<TenantRow>(`tenant-row:${tenant.id}`, async () => {
    const db = sb();
    const { data, error } = await db.from('tenants').select('name_ar, name_en, profile, settings, timezone, specialty').eq('id', tenant.id).single();
    if (error) throw new Error(error.message);
    const row = data as Omit<TenantRow, 'merged_settings' | 'merged_profile'>;
    const [{ data: ms }, { data: mp }] = await Promise.all([
      db.rpc('merged_settings', { p_settings: row.settings || {} }), db.rpc('merged_profile', { p_profile: row.profile || {} })]);
    return { ...row, merged_settings: (ms || {}) as Record<string, unknown>, merged_profile: (mp || {}) as Record<string, unknown> };
  });
  const save = useCallback(async (patch: { profile?: Record<string, unknown>; settings?: Record<string, unknown>; name_ar?: string; name_en?: string }) => {
    if (!data) return;
    const body: Record<string, unknown> = {};
    if (patch.profile) body.profile = { ...(data.profile || {}), ...patch.profile };
    if (patch.settings) body.settings = { ...(data.settings || {}), ...patch.settings };
    if (patch.name_ar !== undefined) body.name_ar = patch.name_ar;
    if (patch.name_en !== undefined) body.name_en = patch.name_en;
    const r = await run(async () => {
      const { error } = await sb().from('tenants').update(body).eq('id', tenant.id);
      if (error) throw new Error(error.message);
      return true;
    }, t('Saved. The assistant uses it from the next message.'));
    if (r) { put({ ...data, ...(body as Partial<TenantRow>) }); refresh(); }
    return r;
  }, [data, run, t, tenant.id, put, refresh]);
  return { row: data, save, busy, refresh };
}
