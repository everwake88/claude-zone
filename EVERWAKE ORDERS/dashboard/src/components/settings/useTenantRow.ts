'use client';
import { useCallback, useEffect, useState } from 'react';
import { sb } from '@/lib/supabase/client';
import type { Tenant } from '@/lib/types';
import { useAction } from '../ui';
import { useTenant } from '../tenant';

// The full restaurant row, plus a save that writes only the columns the
// dashboard may change (profile, settings, names, clock, currency).
export function useTenantRow() {
  const { tenant } = useTenant();
  const [row, setRow] = useState<Tenant | null>(null);
  const { busy, run } = useAction();

  const load = useCallback(async () => {
    const { data } = await sb().from('tenants').select('*').eq('id', tenant.id).single();
    setRow(data as Tenant);
  }, [tenant.id]);
  useEffect(() => { load(); }, [load]);

  const save = (patch: Partial<Pick<Tenant, 'name_ar' | 'name_en' | 'timezone' | 'currency' | 'currency_symbol_ar' | 'default_language' | 'order_no_prefix' | 'profile' | 'settings'>>, done = 'Saved — the agent knows on the next message') =>
    run(async () => {
      const { data, error } = await sb().from('tenants').update(patch).eq('id', tenant.id).select('*').single();
      if (error) throw new Error(error.message);
      setRow(data as Tenant);
    }, done);

  return { row, setRow, save, busy, reload: load };
}
