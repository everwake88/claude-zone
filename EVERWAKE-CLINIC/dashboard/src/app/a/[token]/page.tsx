import type { Metadata } from 'next';
import { cookies } from 'next/headers';
import { Manage, type ManageView } from '@/components/public/Manage';
import { LANG_COOKIE } from '@/lib/lang-cookie';
import { adminClient } from '@/lib/supabase/server';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = { title: 'Your appointment', robots: { index: false, follow: false } };

// the link in every reminder: the patient sees their appointment and confirms, moves or cancels it
export default async function ManagePage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const lang = (await cookies()).get(LANG_COOKIE)?.value === 'en' ? 'en' : 'ar';
  let view: ManageView | null = null;
  if (/^[a-f0-9]{32,128}$/i.test(token)) {
    const { data } = await adminClient().rpc('manage_view', { p_token: token, p_lang: lang });
    if (data && (data as ManageView).ok) view = data as ManageView;
  }
  return <Manage token={token} view={view} />;
}
