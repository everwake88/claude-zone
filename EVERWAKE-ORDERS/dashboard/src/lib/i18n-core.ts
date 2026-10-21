import { AR } from './i18n-ar';

// The dashboard in English or Arabic. The English text is the key: t('Orders')
// shows "الطلبات" in Arabic, and any text without a translation stays as it
// is. {name}-style placeholders are filled from vars. The choice lives in a
// cookie, so the server renders the right language and direction first time.
export type Lang = 'en' | 'ar';
export type Vars = Record<string, string | number | null | undefined>;
export { LANG_COOKIE } from './lang-cookie';

export function translate(lang: Lang, key: string, vars?: Vars): string {
  let s = lang === 'ar' ? (AR[key] ?? key) : key;
  if (vars) for (const [k, v] of Object.entries(vars)) s = s.split(`{${k}}`).join(v == null ? '' : String(v));
  return s;
}

// the language in use in this browser tab, for helpers outside React
// (dates, "5 min ago"); LangProvider keeps it current
let current: Lang = 'en';
export function setCurrentLang(l: Lang) { current = l; }
export function currentLang(): Lang { return current; }
export const tt = (key: string, vars?: Vars) => translate(current, key, vars);
