'use client';
import { createBrowserClient } from '@supabase/ssr';
import type { SupabaseClient } from '@supabase/supabase-js';
import { SUPABASE_ANON_KEY, SUPABASE_URL } from '../env';

// Every table lives in the `everwake` schema (add it under Supabase →
// Settings → API → Exposed schemas). Row level security limits each user
// to the restaurants they belong to.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type DB = SupabaseClient<any, any, any>;

let client: DB | null = null;

export function sb(): DB {
  if (!client) {
    client = createBrowserClient(SUPABASE_URL, SUPABASE_ANON_KEY, { db: { schema: 'everwake' } }) as unknown as DB;
  }
  return client;
}

// supabase-js returns { data, error }; the dashboard wants data or a thrown error
export async function must<T>(p: PromiseLike<{ data: T | null; error: { message: string } | null }>): Promise<T> {
  const { data, error } = await p;
  if (error) throw new Error(error.message);
  return data as T;
}
