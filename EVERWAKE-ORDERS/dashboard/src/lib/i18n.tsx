'use client';
import { Languages } from 'lucide-react';
import { createContext, useCallback, useContext, useState, type ReactNode } from 'react';
import { LANG_COOKIE, setCurrentLang, translate, type Lang, type Vars } from './i18n-core';

export { translate, type Lang, type Vars };

type T = (key: string, vars?: Vars) => string;
interface Ctx { lang: Lang; setLang: (l: Lang) => void; t: T }
const LangCtx = createContext<Ctx>({ lang: 'en', setLang: () => {}, t: (k, v) => translate('en', k, v) });

export function LangProvider({ initial, children }: { initial: Lang; children: ReactNode }) {
  const [lang, setLangState] = useState<Lang>(initial);
  setCurrentLang(lang);
  const setLang = useCallback((l: Lang) => {
    document.cookie = `${LANG_COOKIE}=${l}; path=/; max-age=31536000; samesite=lax`;
    document.documentElement.lang = l;
    document.documentElement.dir = l === 'ar' ? 'rtl' : 'ltr';
    setLangState(l);
  }, []);
  const t = useCallback<T>((key, vars) => translate(lang, key, vars), [lang]);
  return <LangCtx.Provider value={{ lang, setLang, t }}>{children}</LangCtx.Provider>;
}

export const useLang = () => useContext(LangCtx);
export const useT = () => useContext(LangCtx).t;

// the switch: shows the language you can switch to
export function LangSwitch({ className = '' }: { className?: string }) {
  const { lang, setLang } = useLang();
  return (
    <button type="button" onClick={() => setLang(lang === 'ar' ? 'en' : 'ar')}
      className={`inline-flex items-center gap-1.5 rounded-full border border-hairline bg-white px-3 py-1.5 text-sm font-medium text-ink hover:bg-paper ${className}`}
      aria-label={lang === 'ar' ? 'Switch to English' : 'التحويل للعربية'}>
      <Languages className="size-4" />
      {lang === 'ar' ? 'English' : 'العربية'}
    </button>
  );
}
