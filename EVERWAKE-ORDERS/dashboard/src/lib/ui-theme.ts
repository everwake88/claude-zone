'use client';
import { useCallback, useEffect, useState } from 'react';

// The dashboard's look, chosen per browser: the colours stay the restaurant's,
// the look changes how they are laid on (see globals.css, "The dashboard's three looks").
export const UI_THEMES = [
  { key: 'clay', label: 'Soft', about: 'Rounded and soft, floating panels' },
  { key: 'glass', label: 'Glass', about: 'Frosted panels over your colours' },
  { key: 'classic', label: 'Classic', about: 'Flat and quiet, the most compact' }
] as const;
export type UiTheme = typeof UI_THEMES[number]['key'];
const KEY = 'ew-ui';

// runs before the page paints (app/layout.tsx), so the chosen look is there from the first frame
export const UI_THEME_SCRIPT = `try{var u=localStorage.getItem('${KEY}');document.documentElement.dataset.ui=(u==='glass'||u==='classic')?u:'clay'}catch(e){document.documentElement.dataset.ui='clay'}`;

export function useUiTheme() {
  const [ui, setUi] = useState<UiTheme>('clay');
  useEffect(() => { setUi((document.documentElement.dataset.ui as UiTheme) || 'clay'); }, []);
  const choose = useCallback((next: UiTheme) => {
    document.documentElement.dataset.ui = next;
    try { localStorage.setItem(KEY, next); } catch { /* private mode: for this visit only */ }
    setUi(next);
  }, []);
  return { ui, choose };
}
