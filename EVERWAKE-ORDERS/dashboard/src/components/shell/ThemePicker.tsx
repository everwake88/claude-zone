'use client';
import { Check, Palette } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { cx } from '@/lib/format';
import { useT } from '@/lib/i18n';
import { UI_THEMES, useUiTheme } from '@/lib/ui-theme';

// The look of the dashboard: three ways of laying on the restaurant's own colours.
// A small preview of each, so nobody has to choose a name blind.
export function ThemePicker({ dark }: { dark?: boolean }) {
  const t = useT();
  const { ui, choose } = useUiTheme();
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const away = (e: MouseEvent) => { if (!box.current?.contains(e.target as Node)) setOpen(false); };
    const esc = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    window.addEventListener('mousedown', away); window.addEventListener('keydown', esc);
    return () => { window.removeEventListener('mousedown', away); window.removeEventListener('keydown', esc); };
  }, [open]);

  return (
    <div ref={box} className="relative">
      <button onClick={() => setOpen(o => !o)} aria-expanded={open} aria-label={t('Dashboard look')} title={t('Dashboard look')}
        className={cx('flex size-10 items-center justify-center rounded-full transition-[background-color,transform] duration-150 active:scale-95',
          dark ? 'bg-white/10 text-white hover:bg-white/15' : 'ew-card !rounded-full text-ink hover:text-gold-ink')}>
        <Palette className="size-[18px]" aria-hidden />
      </button>
      {open && (
        <div className="ew-pop absolute end-0 top-12 z-50 w-72 origin-top-right rounded-2xl bg-white p-2 text-ink shadow-[0_24px_48px_-20px_rgba(0,0,0,0.35)] ring-1 ring-black/5 rtl:origin-top-left">
          <p className="px-2 pb-2 pt-1 text-sm font-semibold">{t('Dashboard look')}</p>
          {UI_THEMES.map(th => (
            <button key={th.key} onClick={() => { choose(th.key); setOpen(false); }} aria-pressed={ui === th.key}
              className={cx('flex w-full items-center gap-3 rounded-xl p-2 text-start transition-colors duration-150', ui === th.key ? 'bg-gold-wash' : 'hover:bg-paper')}>
              <Preview kind={th.key} />
              <span className="min-w-0 flex-1">
                <span className="block text-sm font-medium">{t(th.label)}</span>
                <span className="block text-xs text-muted">{t(th.about)}</span>
              </span>
              {ui === th.key && <Check className="size-4 text-gold-ink" aria-hidden />}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

// a thumbnail of the look, in this restaurant's colours
function Preview({ kind }: { kind: string }) {
  const r = kind === 'classic' ? 3 : 7;
  return (
    <span aria-hidden className="relative h-12 w-16 shrink-0 overflow-hidden rounded-lg"
      style={{ background: kind === 'glass' ? 'linear-gradient(135deg, color-mix(in oklab, var(--color-gold) 45%, white), color-mix(in oklab, var(--color-navy-soft) 40%, white))'
                         : kind === 'classic' ? 'var(--color-paper)' : 'color-mix(in oklab, var(--color-gold-wash) 70%, var(--color-paper))' }}>
      <span className="absolute bg-navy" style={{ insetBlock: kind === 'classic' ? 0 : 4, insetInlineStart: kind === 'classic' ? 0 : 4, width: 14, borderRadius: kind === 'classic' ? 0 : r }} />
      <span className="absolute" style={{ insetBlock: kind === 'classic' ? 6 : 4, insetInlineStart: kind === 'classic' ? 20 : 22, insetInlineEnd: kind === 'classic' ? 4 : 4,
        borderRadius: r, background: kind === 'glass' ? 'rgba(255,255,255,.6)' : kind === 'classic' ? 'transparent' : 'rgba(255,255,255,.85)' }}>
        <span className="absolute inset-x-1.5 top-1.5 h-3 bg-white" style={{ borderRadius: r / 2, boxShadow: kind === 'classic' ? '0 0 0 1px var(--color-hairline)' : '0 2px 4px rgba(0,0,0,.08)' }} />
        <span className="absolute bottom-1.5 start-1.5 h-3 w-4 bg-gold" style={{ borderRadius: r / 2 }} />
      </span>
    </span>
  );
}
