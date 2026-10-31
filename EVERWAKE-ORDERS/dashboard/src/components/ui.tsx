'use client';
import { AlertCircle, CheckCircle2, Info, Loader2, X } from 'lucide-react';
import {
  createContext, useCallback, useContext, useEffect, useRef, useState,
  type ButtonHTMLAttributes, type InputHTMLAttributes, type ReactNode, type SelectHTMLAttributes, type TextareaHTMLAttributes
} from 'react';
import { cx } from '@/lib/format';
import { useT } from '@/lib/i18n';

// ---- Button ------------------------------------------------------------------
type Variant = 'primary' | 'gold' | 'outline' | 'ghost' | 'danger' | 'positive';
const VARIANT: Record<Variant, string> = {
  primary: 'bg-navy text-white hover:bg-navy-soft',
  gold: 'bg-gold text-on-gold hover:bg-gold-bright font-semibold',
  outline: 'border border-hairline bg-white text-ink hover:bg-paper',
  ghost: 'text-ink hover:bg-paper-sunk',
  danger: 'bg-critical text-white hover:opacity-90',
  positive: 'bg-positive text-white hover:opacity-90'
};
export function Button({ variant = 'primary', size = 'md', busy, className, children, ...rest }:
  ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant; size?: 'sm' | 'md'; busy?: boolean }) {
  return (
    <button
      {...rest}
      disabled={rest.disabled || busy}
      className={cx('inline-flex select-none items-center justify-center gap-1.5 whitespace-nowrap rounded-lg font-medium transition-[background-color,color,box-shadow,transform] duration-150',
        'active:scale-[.97] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gold/60 focus-visible:ring-offset-2 disabled:pointer-events-none disabled:opacity-50',
        size === 'sm' ? 'h-8 px-3 text-xs' : 'h-10 px-4 text-sm', VARIANT[variant], className)}>
      {busy && <Loader2 className="size-4 animate-spin" />}
      {children}
    </button>
  );
}

// ---- Fields --------------------------------------------------------------------
const field = 'w-full rounded-lg border border-hairline bg-white px-3 text-sm text-ink transition-[border-color,box-shadow] duration-150 placeholder:text-muted/70 hover:border-ink/25 focus:outline-none focus:ring-4 focus:ring-gold/20 focus:border-gold disabled:bg-paper';
export function Input(props: InputHTMLAttributes<HTMLInputElement>) {
  return <input dir="auto" {...props} className={cx(field, 'h-10', props.className)} />;
}
export function Textarea(props: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return <textarea dir="auto" rows={3} {...props} className={cx(field, 'py-2 leading-relaxed', props.className)} />;
}
export function Select({ children, ...props }: SelectHTMLAttributes<HTMLSelectElement>) {
  return <select {...props} className={cx(field, 'h-10 pe-8', props.className)}>{children}</select>;
}
export function Field({ label, hint, children, className }: { label: string; hint?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <label className={cx('block space-y-1.5', className)}>
      <span className="text-sm font-medium text-ink">{label}</span>
      {children}
      {hint && <span className="block text-xs text-muted">{hint}</span>}
    </label>
  );
}

export function Switch({ checked, onChange, disabled, label, tone = 'positive' }:
  { checked: boolean; onChange: (v: boolean) => void; disabled?: boolean; label?: string; tone?: 'positive' | 'gold' }) {
  return (
    <button type="button" role="switch" aria-checked={checked} aria-label={label} disabled={disabled}
      onClick={() => onChange(!checked)}
      className={cx('relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition-colors disabled:opacity-50',
        checked ? (tone === 'gold' ? 'bg-gold' : 'bg-positive') : 'bg-paper-sunk border border-hairline')}>
      <span className={cx('inline-block size-5 rounded-full bg-white shadow transition-transform', checked ? 'translate-x-5 rtl:-translate-x-5' : 'translate-x-0.5 rtl:-translate-x-0.5')} />
    </button>
  );
}

export function Checkbox({ checked, onChange, label }: { checked: boolean; onChange: (v: boolean) => void; label: ReactNode }) {
  return (
    <label className="flex cursor-pointer items-center gap-2 text-sm">
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} className="size-4 accent-[#0B222E]" />
      <span>{label}</span>
    </label>
  );
}

// ---- Surfaces ------------------------------------------------------------------
export function Card({ children, className, title, action }: { children: ReactNode; className?: string; title?: ReactNode; action?: ReactNode }) {
  return (
    <section className={cx('rounded-2xl border border-hairline/80 bg-white shadow-[0_1px_2px_rgba(0,0,0,0.04),0_6px_20px_-12px_rgba(0,0,0,0.12)]', className)}>
      {(title || action) && (
        <header className="flex items-center justify-between gap-3 border-b border-hairline/70 px-5 py-3.5">
          <h2 className="text-[15px] font-semibold text-ink">{title}</h2>
          {action}
        </header>
      )}
      <div className="p-5">{children}</div>
    </section>
  );
}

type Tone = 'neutral' | 'positive' | 'caution' | 'critical' | 'gold' | 'navy';
const TONE: Record<Tone, string> = {
  neutral: 'bg-paper-sunk text-muted', positive: 'bg-positive-wash text-positive', caution: 'bg-caution-wash text-caution',
  critical: 'bg-critical-wash text-critical', gold: 'bg-gold-wash text-gold-ink', navy: 'bg-navy text-white'
};
export function Badge({ tone = 'neutral', children, className }: { tone?: Tone; children: ReactNode; className?: string }) {
  return <span className={cx('inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium', TONE[tone], className)}>{children}</span>;
}

export function PageHeader({ title, subtitle, actions }: { title: string; subtitle?: ReactNode; actions?: ReactNode }) {
  return (
    <div className="mb-6 flex flex-wrap items-end justify-between gap-3">
      <div className="min-w-0">
        <h1 className="board text-[34px] text-ink">{title}</h1>
        {subtitle && <p className="mt-1.5 max-w-3xl text-sm leading-relaxed text-muted">{subtitle}</p>}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </div>
  );
}

export function Empty({ title, children, action }: { title: string; children?: ReactNode; action?: ReactNode }) {
  return (
    <div className="rounded-xl border border-dashed border-hairline bg-white px-6 py-10 text-center">
      <p className="font-medium text-ink">{title}</p>
      {children && <div className="mx-auto mt-1 max-w-md text-sm text-muted">{children}</div>}
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}

// while a page loads: the shape of what is coming, shimmering, instead of a spinner
export function Spinner({ label }: { label?: string }) {
  const t = useT();
  return (
    <div role="status" aria-live="polite" className="space-y-3 py-2">
      <span className="sr-only">{label || t('Loading…')}</span>
      <div className="ew-skeleton h-24 rounded-2xl" />
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="ew-skeleton h-36 rounded-2xl" />
        <div className="ew-skeleton h-36 rounded-2xl [animation-delay:.15s]" />
      </div>
      <div className="ew-skeleton h-14 w-2/3 rounded-2xl [animation-delay:.3s]" />
    </div>
  );
}

// a number that counts up to its value when it arrives or changes
export function CountUp({ value, format = (v: number) => String(Math.round(v)), ms = 700 }: { value: number; format?: (v: number) => string; ms?: number }) {
  const [v, setV] = useState(0);
  const from = useRef(0);
  useEffect(() => {
    const a = from.current, b = Number(value) || 0;
    if (typeof window === 'undefined' || window.matchMedia('(prefers-reduced-motion: reduce)').matches) { from.current = b; setV(b); return; }
    const t0 = performance.now();
    let raf = 0;
    const step = (t: number) => {
      const k = Math.min(1, (t - t0) / ms), x = a + (b - a) * (1 - Math.pow(1 - k, 3));
      from.current = x; setV(k < 1 ? x : b);
      if (k < 1) raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [value, ms]);
  const exact = Math.abs(v - value) < 0.005;
  return <span className="tabular-nums">{format(exact ? value : Number.isInteger(value) ? Math.round(v) : Math.round(v * 10) / 10)}</span>;
}

// ---- Overlays -------------------------------------------------------------------
export function Drawer({ open, onClose, title, children, footer, wide }:
  { open: boolean; onClose: () => void; title: ReactNode; children: ReactNode; footer?: ReactNode; wide?: boolean }) {
  const t = useT();
  useEffect(() => {
    if (!open) return;
    const esc = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', esc);
    return () => window.removeEventListener('keydown', esc);
  }, [open, onClose]);
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 flex justify-end" role="dialog" aria-modal="true">
      <div className="ew-fade absolute inset-0 bg-navy/45 backdrop-blur-[2px]" onClick={onClose} />
      <aside className={cx('ew-drawer relative flex h-full w-full flex-col bg-white shadow-2xl', wide ? 'max-w-3xl' : 'max-w-xl')}>
        <header className="flex items-center justify-between border-b border-hairline px-5 py-4">
          <h2 className="text-lg font-semibold">{title}</h2>
          <button onClick={onClose} className="rounded-lg p-1.5 hover:bg-paper" aria-label={t('Close')}><X className="size-5" /></button>
        </header>
        <div className="flex-1 overflow-y-auto px-5 py-4">{children}</div>
        {footer && <footer className="flex justify-end gap-2 border-t border-hairline px-5 py-3">{footer}</footer>}
      </aside>
    </div>
  );
}

export function Modal({ open, onClose, title, children, footer }:
  { open: boolean; onClose: () => void; title: ReactNode; children: ReactNode; footer?: ReactNode }) {
  const t = useT();
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4" role="dialog" aria-modal="true">
      <div className="ew-fade absolute inset-0 bg-navy/45 backdrop-blur-[2px]" onClick={onClose} />
      <div className="ew-pop relative w-full max-w-md rounded-2xl bg-white shadow-2xl">
        <header className="flex items-center justify-between px-5 pt-5">
          <h2 className="text-lg font-semibold">{title}</h2>
          <button onClick={onClose} className="rounded-lg p-1.5 hover:bg-paper" aria-label={t('Close')}><X className="size-5" /></button>
        </header>
        <div className="px-5 py-4">{children}</div>
        {footer && <footer className="flex justify-end gap-2 border-t border-hairline px-5 py-3">{footer}</footer>}
      </div>
    </div>
  );
}

export function Tabs<T extends string>({ value, onChange, tabs, size = 'md' }:
  { value: T; onChange: (v: T) => void; tabs: { value: T; label: ReactNode }[]; size?: 'sm' | 'md' }) {
  return (
    <div className="inline-flex rounded-xl border border-hairline bg-white p-1" role="tablist">
      {tabs.map(t => (
        <button key={t.value} onClick={() => onChange(t.value)} role="tab" aria-selected={value === t.value}
          className={cx('whitespace-nowrap rounded-lg font-medium transition-colors duration-200', size === 'sm' ? 'px-2.5 py-1 text-xs' : 'px-3.5 py-1.5 text-sm',
            value === t.value ? 'bg-navy text-white shadow-sm' : 'text-muted hover:bg-paper hover:text-ink')}>
          {t.label}
        </button>
      ))}
    </div>
  );
}

// ---- Toasts ------------------------------------------------------------------------
type Toast = { id: number; text: string; tone: 'positive' | 'critical' | 'neutral' };
const ToastCtx = createContext<(text: string, tone?: Toast['tone']) => void>(() => {});
export function ToastProvider({ children }: { children: ReactNode }) {
  const [list, setList] = useState<Toast[]>([]);
  const push = useCallback((text: string, tone: Toast['tone'] = 'positive') => {
    const id = Date.now() + Math.random();
    setList(l => [...l, { id, text, tone }]);
    setTimeout(() => setList(l => l.filter(t => t.id !== id)), tone === 'critical' ? 7000 : 3500);
  }, []);
  return (
    <ToastCtx.Provider value={push}>
      {children}
      <div className="pointer-events-none fixed bottom-4 end-4 z-[60] flex flex-col gap-2" aria-live="polite">
        {list.map(t => {
          const Icon = t.tone === 'critical' ? AlertCircle : t.tone === 'neutral' ? Info : CheckCircle2;
          return (
            <div key={t.id} role={t.tone === 'critical' ? 'alert' : 'status'}
              className={cx('ew-toast pointer-events-auto relative flex max-w-sm items-start gap-2.5 overflow-hidden rounded-xl py-3 pe-3 ps-3.5 text-sm text-white shadow-xl',
                t.tone === 'critical' ? 'bg-critical' : t.tone === 'neutral' ? 'bg-navy' : 'bg-positive')}>
              <Icon className="mt-px size-4 shrink-0" aria-hidden />
              <span className="flex-1 leading-snug">{t.text}</span>
              <button onClick={() => setList(l => l.filter(x => x.id !== t.id))} className="-m-1 rounded p-1 opacity-70 hover:opacity-100" aria-label="×"><X className="size-3.5" /></button>
              <span className="ew-timer absolute inset-x-0 bottom-0 h-0.5 bg-white/40" style={{ animationDuration: t.tone === 'critical' ? '7s' : '3.5s' }} aria-hidden />
            </div>
          );
        })}
      </div>
    </ToastCtx.Provider>
  );
}
export const useToast = () => useContext(ToastCtx);

// run an async action with a busy flag and a toast on failure
export function useAction() {
  const toast = useToast();
  const t = useT();
  const [busy, setBusy] = useState(false);
  const run = useCallback(async <T,>(fn: () => Promise<T>, done?: string): Promise<T | undefined> => {
    setBusy(true);
    try {
      const r = await fn();
      if (done) toast(done);
      return r;
    } catch (e) {
      // a known message (ours, or the database's) shows in the dashboard's language
      toast(t(e instanceof Error ? e.message : String(e)), 'critical');
      return undefined;
    } finally {
      setBusy(false);
    }
  }, [toast, t]);
  return { busy, run };
}
