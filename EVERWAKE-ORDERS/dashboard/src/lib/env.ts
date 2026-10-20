// Public values (safe in the browser). Supabase now calls the anon key the
// "publishable" key; either name works.
export const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL || '';
export const SUPABASE_ANON_KEY =
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY || '';

export const configured = Boolean(SUPABASE_URL && SUPABASE_ANON_KEY);
