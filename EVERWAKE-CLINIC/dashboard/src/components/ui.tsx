'use client';
import { AlertCircle, CheckCircle2, Info, Loader2, X } from 'lucide-react';
import { AnimatePresence, motion, useReducedMotion } from 'motion/react';
import {
  createContext, useCallback, useContext, useEffect, useRef, useState,
  type ButtonHTMLAttributes, type InputHTMLAttributes, type ReactNode, type SelectHTMLAttributes, type TextareaHTMLAttributes
} from 'react';
import { cx } from '@/lib/format';
import { useT } from '@/lib/i18n';

// ---- Button ------------------------------------------------------------------------
type Variant = 'primary' | 'accent' | 'outline' | 'ghost' | 'danger' | 'positive';
const VARIANT: Record<Variant, string> = {
  primary: 'bg-ink text-white hover:bg-[#1e2a42]',
  accent: 'bg-accent text-white hover:bg-accent-ink',
  outline: 'border border-control bg-sheet text-ink hover:bg-raised hover:border-faint/60',
  ghost: 'text-ink hover:bg-raised',
  danger: 'bg-critical text-white hover:bg-critical-ink',
  positive: 'bg-positive text-white hover:bg-positive-ink'
};
export function Button({ variant = 'primary', size = 'md', busy, className, children, ...rest }:
  ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant; size?: 'sm' | 'md'; busy?: boolean }) {
  return (
    <button type="button" {...rest} disabled={rest.disabled || busy} aria-busy={busy || undefined}
      className={cx('press inline-flex select-none items-center justify-center gap-1.5 whitespace-nowrap rounded-[7px] font-medium',
        'disabled:pointer-events-none disabled:opacity-45', size === 'sm' ? 'h-7 px-2.5 text-[13px]' : 'h-9 px-3.5 text-sm', VARIANT[variant], className)}>
      {busy && <Loader2 className="size-4 animate-spin" aria-hidden />}
      {children}
    </button>
  );
}

// ---- Fields -----------------------------------------------------------------------------
const field = 'w-full rounded-[7px] border border-control bg-sheet px-3 text-sm text-ink transition-[border-color,box-shadow] duration-150 placeholder:text-faint hover:border-faint/70 focus:border-accent focus:outline-none focus:ring-3 focus:ring-accent/15 disabled:bg-raised disabled:text-muted';
export function Input(props: InputHTMLAttributes<HTMLInputElement>) {
  return <input dir="auto" {...props} className={cx(field, 'h-9', props.className)} />;
}
export function Textarea(props: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return <textarea dir="auto" rows={3} {...props} className={cx(field, 'py-2 leading-relaxed', props.className)} />;
}
export function Select({ children, ...props }: SelectHTMLAttributes<HTMLSelectElement>) {
  return <select {...props} className={cx(field, 'h-9 pe-8', props.className)}>{children}</select>;
}
export function Field({ label, hint, children, className }: { label: ReactNode; hint?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <label className={cx('block space-y-1.5', className)}>
      <span className="text-[13px] font-medium text-ink">{label}</span>
      {children}
      {hint && <span className="block text-xs leading-snug text-muted">{hint}</span>}
    </label>
  );
}
export function Switch({ checked, onChange, disabled, label }: { checked: boolean; onChange: (v: boolean) => void; disabled?: boolean; label?: string }) {
  return (
    <button type="button" role="switch" aria-checked={checked} aria-label={label} disabled={disabled} onClick={() => onChange(!checked)}
      className={cx('relative inline-flex h-5 w-9 shrink-0 items-center rounded-full transition-colors duration-200 disabled:opacity-45',
        checked ? 'bg-accent' : 'bg-control')}>
      <span className={cx('inline-block size-4 rounded-full bg-white shadow-sm transition-transform duration-200 ease-[var(--ease-out)]',
        checked ? 'translate-x-[18px] rtl:-translate-x-[18px]' : 'translate-x-0.5 rtl:-translate-x-0.5')} />
    </button>
  );
}
export function Checkbox({ checked, onChange, label }: { checked: boolean; onChange: (v: boolean) => void; label: ReactNode }) {
  return (
    <label className="flex cursor-pointer items-center gap-2 text-sm">
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} className="size-4 accent-[var(--color-accent)]" />
      <span>{label}</span>
    </label>
  );
}

// ---- Surfaces ---------------------------------------------------------------------------
export function Card({ children, className, title, action, sub, pad = true }:
  { children: ReactNode; className?: string; title?: ReactNode; action?: ReactNode; sub?: ReactNode; pad?: boolean }) {
  return (
    <section className={cx('card min-w-0', className)}>
      {(title || action) && (
        <header className="flex min-h-12 items-center justify-between gap-3 border-b border-rule px-4 py-2.5">
          <div className="min-w-0">
            <h2 className="truncate text-[15px] font-semibold text-ink">{title}</h2>
            {sub && <p className="truncate text-xs text-muted">{sub}</p>}
          </div>
          {action && <div className="flex shrink-0 items-center gap-1.5">{action}</div>}
        </header>
      )}
      <div className={pad ? 'p-4' : ''}>{children}</div>
    </section>
  );
}

type Tone = 'neutral' | 'positive' | 'caution' | 'critical' | 'accent';
const TONE: Record<Tone, string> = {
  neutral: 'bg-raised text-muted ring-1 ring-inset ring-border', positive: 'bg-positive-soft text-positive-ink', caution: 'bg-caution-soft text-caution',
  critical: 'bg-critical-soft text-critical-ink', accent: 'bg-accent-soft text-accent-ink'
};
export function Pill({ tone = 'neutral', children, className }: { tone?: Tone; children: ReactNode; className?: string }) {
  return <span className={cx('inline-flex h-5 items-center gap-1 whitespace-nowrap rounded-full px-2 text-[11.5px] font-medium', TONE[tone], className)}>{children}</span>;
}

// the page's title, the one finding under it, and the main action beside it
export function PageTitle({ title, finding, actions }: { title: ReactNode; finding?: ReactNode; actions?: ReactNode }) {
  return (
    <div className="mb-4 flex flex-wrap items-end justify-between gap-x-4 gap-y-3">
      <div className="min-w-0">
        <h1 className="text-[22px] font-semibold leading-7 text-ink">{title}</h1>
        {finding && <p className="mt-0.5 text-sm text-muted">{finding}</p>}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </div>
  );
}

export function Empty({ children, action, className }: { children: ReactNode; action?: ReactNode; className?: string }) {
  return (
    <div className={cx('flex flex-wrap items-center justify-between gap-3 rounded-lg border border-dashed border-control px-4 py-3 text-sm text-muted', className)}>
      <span>{children}</span>
      {action}
    </div>
  );
}
export function Skeleton({ className }: { className?: string }) {
  return <span aria-hidden className={cx('skeleton block', className)} />;
}

// a person's mark: their initials on a pale tint of a hue that is theirs (it never changes)
export function Avatar({ name, hue, size = 32, className }: { name: string | null | undefined; hue?: string | null; size?: number; className?: string }) {
  const h = hue || `hsl(${[...(name || '?')].reduce((a, c) => a + c.charCodeAt(0), 0) % 360} 45% 45%)`;
  const ini = (name || '?').replace(/^(د\.|dr\.?)\s*/i, '').trim().split(/\s+/).slice(0, 2).map(w => w[0]).join('');
  return (
    <span aria-hidden className={cx('inline-flex shrink-0 items-center justify-center rounded-full font-semibold', className)}
      style={{ width: size, height: size, fontSize: size * 0.38, color: h, background: `color-mix(in oklab, ${h} 13%, white)` }}>{ini}</span>
  );
}

// a number that counts to its new value (never on first paint: the value is simply there)
export function CountUp({ value, format = (v: number) => String(Math.round(v)) }: { value: number; format?: (v: number) => string }) {
  const [v, setV] = useState(value);
  const from = useRef(value);
  const reduce = useReducedMotion();
  useEffect(() => {
    const a = from.current, b = Number(value) || 0;
    if (a === b || reduce) { from.current = b; setV(b); return; }
    const t0 = performance.now();
    let raf = 0;
    const step = (t: number) => {
      const k = Math.min(1, (t - t0) / 600), x = a + (b - a) * (1 - Math.pow(1 - k, 3));
      from.current = x; setV(k < 1 ? x : b);
      if (k < 1) raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [value, reduce]);
  return <span className="tabular-nums">{format(Math.abs(v - value) < 0.005 ? value : Math.round(v))}</span>;
}

// ---- Overlays ---------------------------------------------------------------------------
// A side sheet for a task that keeps the page in view (a booking, a patient's details).
// On a phone it rises from the bottom. Esc closes it; the focus goes into it.
export function Drawer({ open, onClose, title, children, footer, width = 'max-w-[520px]' }:
  { open: boolean; onClose: () => void; title: ReactNode; children: ReactNode; footer?: ReactNode; width?: string }) {
  const t = useT();
  const panel = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const esc = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', esc);
    const prev = document.activeElement as HTMLElement | null;
    setTimeout(() => panel.current?.querySelector<HTMLElement>('input,select,textarea,button:not([data-close])')?.focus(), 60);
    return () => { window.removeEventListener('keydown', esc); prev?.focus?.(); };
  }, [open, onClose]);
  const rtl = typeof document !== 'undefined' && document.documentElement.dir === 'rtl';
  return (
    <AnimatePresence>
      {open && (
        <div className="fixed inset-0 z-50 flex justify-end max-sm:items-end" role="dialog" aria-modal="true">
          <motion.div className="absolute inset-0 bg-ink/30" onClick={onClose}
            initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: 0.2 }} />
          <motion.aside ref={panel}
            className={cx('relative flex w-full flex-col bg-sheet shadow-[0_24px_64px_-24px_rgb(15_23_41/.45)] sm:h-full', width,
              'max-sm:max-h-[92dvh] max-sm:rounded-t-2xl')}
            initial={{ x: typeof window !== 'undefined' && window.innerWidth < 640 ? 0 : (rtl ? '-100%' : '100%'), y: typeof window !== 'undefined' && window.innerWidth < 640 ? '100%' : 0 }}
            animate={{ x: 0, y: 0 }}
            exit={{ x: typeof window !== 'undefined' && window.innerWidth < 640 ? 0 : (rtl ? '-100%' : '100%'), y: typeof window !== 'undefined' && window.innerWidth < 640 ? '100%' : 0 }}
            transition={{ duration: 0.28, ease: [0.32, 0.72, 0, 1] }}>
            <header className="flex items-center justify-between gap-3 border-b border-rule px-5 py-3.5">
              <h2 className="text-base font-semibold">{title}</h2>
              <button data-close onClick={onClose} className="press -me-1.5 rounded-md p-1.5 text-muted hover:bg-raised hover:text-ink" aria-label={t('Close')}>
                <X className="size-4.5" />
              </button>
            </header>
            <div className="flex-1 overflow-y-auto px-5 py-4">{children}</div>
            {footer && <footer className="flex flex-wrap justify-end gap-2 border-t border-rule px-5 py-3">{footer}</footer>}
          </motion.aside>
        </div>
      )}
    </AnimatePresence>
  );
}

// for a choice that must be made before going on (sending to every patient, cancelling a session)
export function Dialog({ open, onClose, title, children, footer, tone }:
  { open: boolean; onClose: () => void; title: ReactNode; children: ReactNode; footer?: ReactNode; tone?: 'critical' }) {
  const t = useT();
  useEffect(() => {
    if (!open) return;
    const esc = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', esc);
    return () => window.removeEventListener('keydown', esc);
  }, [open, onClose]);
  return (
    <AnimatePresence>
      {open && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4" role="alertdialog" aria-modal="true">
          <motion.div className="absolute inset-0 bg-ink/35" onClick={onClose}
            initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: 0.18 }} />
          <motion.div className="relative w-full max-w-md rounded-xl bg-sheet shadow-[0_24px_64px_-24px_rgb(15_23_41/.5)]"
            initial={{ opacity: 0, scale: 0.96, y: 6 }} animate={{ opacity: 1, scale: 1, y: 0 }} exit={{ opacity: 0, scale: 0.97 }}
            transition={{ duration: 0.2, ease: [0.23, 1, 0.32, 1] }}>
            <header className="flex items-start justify-between gap-3 px-5 pt-4">
              <h2 className={cx('text-base font-semibold', tone === 'critical' && 'text-critical')}>{title}</h2>
              <button onClick={onClose} className="press -me-1.5 rounded-md p-1 text-muted hover:bg-raised" aria-label={t('Close')}><X className="size-4" /></button>
            </header>
            <div className="px-5 py-3 text-sm leading-relaxed">{children}</div>
            {footer && <footer className="flex flex-wrap justify-end gap-2 px-5 pb-4 pt-1">{footer}</footer>}
          </motion.div>
        </div>
      )}
    </AnimatePresence>
  );
}

// a segmented choice: the selection slides between the options
export function Segmented<T extends string>({ value, onChange, options, size = 'md', label }:
  { value: T; onChange: (v: T) => void; options: { value: T; label: ReactNode }[]; size?: 'sm' | 'md'; label?: string }) {
  return (
    <div className="inline-flex rounded-[8px] bg-raised p-0.5 ring-1 ring-inset ring-border" role="tablist" aria-label={label}>
      {options.map(o => {
        const on = value === o.value;
        return (
          <button key={o.value} type="button" role="tab" aria-selected={on} onClick={() => onChange(o.value)}
            className={cx('press relative whitespace-nowrap rounded-[6px] font-medium', size === 'sm' ? 'h-6 px-2 text-xs' : 'h-8 px-3 text-[13px]',
              on ? 'text-ink' : 'text-muted hover:text-ink')}>
            {on && <motion.span layoutId={`seg-${label || 'x'}`} className="absolute inset-0 rounded-[6px] bg-sheet shadow-[0_1px_2px_rgb(15_23_41/.12)] ring-1 ring-border"
                                transition={{ duration: 0.22, ease: [0.23, 1, 0.32, 1] }} />}
            <span className="relative">{o.label}</span>
          </button>
        );
      })}
    </div>
  );
}

// ---- Toasts -------------------------------------------------------------------------------
type Toast = { id: number; text: string; tone: 'positive' | 'critical' | 'neutral'; action?: { label: string; run: () => void } };
type Push = (text: string, tone?: Toast['tone'], action?: Toast['action']) => void;
const ToastCtx = createContext<Push>(() => {});
export function ToastProvider({ children }: { children: ReactNode }) {
  const [list, setList] = useState<Toast[]>([]);
  const push = useCallback<Push>((text, tone = 'positive', action) => {
    const id = Date.now() + Math.random();
    setList(l => [...l.slice(-3), { id, text, tone, action }]);
    setTimeout(() => setList(l => l.filter(t => t.id !== id)), tone === 'critical' ? 7000 : action ? 6000 : 3500);
  }, []);
  return (
    <ToastCtx.Provider value={push}>
      {children}
      <div className="pointer-events-none fixed bottom-4 end-4 z-[70] flex w-[min(380px,calc(100vw-2rem))] flex-col gap-2 max-lg:bottom-20" aria-live="polite">
        <AnimatePresence initial={false}>
          {list.map(t => {
            const Icon = t.tone === 'critical' ? AlertCircle : t.tone === 'neutral' ? Info : CheckCircle2;
            return (
              <motion.div key={t.id} layout role={t.tone === 'critical' ? 'alert' : 'status'}
                initial={{ opacity: 0, y: 14, scale: 0.97 }} animate={{ opacity: 1, y: 0, scale: 1 }} exit={{ opacity: 0, scale: 0.97, transition: { duration: 0.15 } }}
                transition={{ duration: 0.26, ease: [0.23, 1, 0.32, 1] }}
                className="pointer-events-auto relative flex items-start gap-2.5 overflow-hidden rounded-lg bg-ink py-2.5 pe-2.5 ps-3 text-sm text-white shadow-[0_16px_40px_-16px_rgb(15_23_41/.6)]">
                <Icon className={cx('mt-0.5 size-4 shrink-0', t.tone === 'critical' ? 'text-[#ff8a8f]' : t.tone === 'positive' ? 'text-[#7ee2a8]' : 'text-[#a9c0ff]')} aria-hidden />
                <span className="flex-1 leading-snug">{t.text}</span>
                {t.action && <button onClick={() => { t.action!.run(); setList(l => l.filter(x => x.id !== t.id)); }}
                                     className="press rounded-md px-2 py-0.5 text-[13px] font-semibold text-[#a9c0ff] hover:bg-white/10">{t.action.label}</button>}
                <button onClick={() => setList(l => l.filter(x => x.id !== t.id))} className="rounded p-0.5 opacity-60 hover:opacity-100" aria-label="×"><X className="size-3.5" /></button>
                <span className="c-timer absolute inset-x-0 bottom-0 h-0.5 bg-white/25" style={{ animationDuration: t.tone === 'critical' ? '7s' : t.action ? '6s' : '3.5s' }} aria-hidden />
              </motion.div>
            );
          })}
        </AnimatePresence>
      </div>
    </ToastCtx.Provider>
  );
}
export const useToast = () => useContext(ToastCtx);

// run an async action with a busy flag; a failure shows its message in the dashboard's language
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
      toast(t(e instanceof Error ? e.message : String(e)), 'critical');
      return undefined;
    } finally { setBusy(false); }
  }, [toast, t]);
  return { busy, run };
}

export const Spinner = () => <Loader2 className="size-4 animate-spin text-muted" aria-hidden />;
