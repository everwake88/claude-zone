import 'server-only';
import { cookies } from 'next/headers';
import { LANG_COOKIE, translate, type Lang, type Vars } from './i18n-core';

// the language chosen in the dashboard, for server-rendered pages
export async function serverLang(): Promise<Lang> {
  const v = (await cookies()).get(LANG_COOKIE)?.value;
  return v === 'ar' ? 'ar' : 'en';
}

// t() for a server component
export async function serverT(): Promise<(key: string, vars?: Vars) => string> {
  const lang = await serverLang();
  return (key, vars) => translate(lang, key, vars);
}
