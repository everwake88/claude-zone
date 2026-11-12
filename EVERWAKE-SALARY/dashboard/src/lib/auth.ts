import 'server-only';
import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { COOKIE, verify, type Session } from './session';
import { translator, type Lang } from './i18n';

export async function currentUser(): Promise<Session | null> {
  return verify((await cookies()).get(COOKIE)?.value);
}
export async function requireUser(): Promise<Session> {
  const u = await currentUser();
  if (!u) redirect('/login');
  return u;
}
export async function getLang(): Promise<Lang> {
  return (await cookies()).get('lang')?.value === 'en' ? 'en' : 'ar';
}
export async function getT() {
  const lang = await getLang();
  return { lang, t: translator(lang), dir: lang === 'ar' ? 'rtl' as const : 'ltr' as const };
}
