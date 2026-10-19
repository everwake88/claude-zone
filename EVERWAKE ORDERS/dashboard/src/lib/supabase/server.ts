import 'server-only';
import { createServerClient } from '@supabase/ssr';
import { createClient } from '@supabase/supabase-js';
import { cookies } from 'next/headers';
import { SUPABASE_ANON_KEY, SUPABASE_URL } from '../env';
import type { DB } from './client';

// the signed-in user's client: row level security applies
export async function serverClient(): Promise<DB> {
  const store = await cookies();
  return createServerClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    db: { schema: 'everwake' },
    cookies: {
      getAll: () => store.getAll(),
      setAll: (list) => {
        try { list.forEach(({ name, value, options }) => store.set(name, value, options)); } catch { /* a server component cannot set cookies; the middleware does */ }
      }
    }
  }) as unknown as DB;
}

// the service role: bypasses row level security. Only for reading secrets
// (the WhatsApp API key) and storage the user cannot reach, AFTER the
// caller's role has been checked with their own client.
export function adminClient(): DB {
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!key) throw new Error('SUPABASE_SERVICE_ROLE_KEY is not set');
  return createClient(SUPABASE_URL, key, { db: { schema: 'everwake' }, auth: { persistSession: false } }) as unknown as DB;
}

// the caller's role in a restaurant, or null
export async function roleIn(tenantId: string): Promise<string | null> {
  const db = await serverClient();
  const { data } = await db.rpc('member_role', { p_tenant: tenantId });
  return (data as string | null) || null;
}
