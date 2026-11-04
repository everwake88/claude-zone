import { notFound } from 'next/navigation';
import { DevConsole } from '@/components/dev/DevConsole';
import { serverClient } from '@/lib/supabase/server';

export const dynamic = 'force-dynamic';

// Everwake's developer console: what the AI costs, each restaurant's percent and AI settings, the prices.
// Only platform admins: anyone else gets a plain "not found" (the data refuses them too).
export default async function DevPage() {
  const db = await serverClient();
  const { data: admin } = await db.rpc('is_platform_admin');
  if (admin !== true) notFound();
  return <DevConsole />;
}
