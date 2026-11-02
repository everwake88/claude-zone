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
export function LangSwitch({ className = '', dark }: { className?: string; dark?: boolean }) {
  const { lang, setLang } = useLang();
  return (
    <button type="button" onClick={() => setLang(lang === 'ar' ? 'en' : 'ar')}
      className={`press inline-flex h-8 items-center gap-1.5 rounded-full px-3 text-[13px] font-medium ${dark ? 'text-on-navy-muted hover:bg-white/10 hover:text-white' : 'border border-border bg-sheet text-ink hover:bg-raised'} ${className}`}
      aria-label={lang === 'ar' ? 'Switch to English' : 'التحويل للعربية'}>
      <Languages className="size-4" />
      {lang === 'ar' ? 'English' : 'العربية'}
    </button>
  );
}
