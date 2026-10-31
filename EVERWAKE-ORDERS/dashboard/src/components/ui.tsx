'use client';
import { Loader2, X } from 'lucide-react';
import {
  createContext, useCallback, useContext, useEffect, useState,
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
      className={cx('inline-flex items-center justify-center gap-1.5 rounded-lg font-medium transition-colors disabled:opacity-50 disabled:cursor-not-allowed',
        size === 'sm' ? 'h-8 px-3 text-xs' : 'h-10 px-4 text-sm', VARIANT[variant], className)}>
      {busy && <Loader2 className="size-4 animate-spin" />}
      {children}
    </button>
  );
}

// ---- Fields --------------------------------------------------------------------
const field = 'w-full rounded-lg border border-hairline bg-white px-3 text-sm text-ink placeholder:text-muted/70 focus:outline-none focus:ring-2 focus:ring-gold/50 focus:border-gold disabled:bg-paper';
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
    <section className={cx('rounded-xl border border-hairline bg-white shadow-[0_1px_2px_rgba(11,34,46,0.06)]', className)}>
      {(title || action) && (
        <header className="flex items-center justify-between gap-3 border-b border-hairline px-4 py-3">
          <h2 className="text-sm font-semibold text-ink">{title}</h2>
          {action}
        </header>
      )}
      <div className="p-4">{children}</div>
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
    <div className="mb-5 flex flex-wrap items-end justify-between gap-3">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight text-ink">{title}</h1>
        {subtitle && <p className="mt-1 text-sm text-muted">{subtitle}</p>}
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

export function Spinner({ label }: { label?: string }) {
  const t = useT();
  return <div className="flex items-center gap-2 p-6 text-sm text-muted"><Loader2 className="size-4 animate-spin" />{label || t('Loading…')}</div>;
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
    <div className="fixed inset-0 z-50 flex justify-end">
      <div className="absolute inset-0 bg-navy/40" onClick={onClose} />
      <aside className={cx('relative flex h-full w-full flex-col bg-white shadow-2xl', wide ? 'max-w-3xl' : 'max-w-xl')}>
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
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-navy/40" onClick={onClose} />
      <div className="relative w-full max-w-md rounded-2xl bg-white shadow-2xl">
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
    <div className="inline-flex rounded-lg border border-hairline bg-white p-0.5">
      {tabs.map(t => (
        <button key={t.value} onClick={() => onChange(t.value)}
          className={cx('whitespace-nowrap rounded-md', size === 'sm' ? 'px-2 py-1 text-xs' : 'px-3 py-1.5 text-sm',
            value === t.value ? 'bg-navy text-white' : 'text-muted hover:text-ink')}>
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
      <div className="pointer-events-none fixed bottom-4 end-4 z-[60] flex flex-col gap-2">
        {list.map(t => (
          <div key={t.id} className={cx('pointer-events-auto max-w-sm rounded-xl px-4 py-3 text-sm shadow-lg',
            t.tone === 'critical' ? 'bg-critical text-white' : t.tone === 'neutral' ? 'bg-navy text-white' : 'bg-positive text-white')}>
            {t.text}
          </div>
        ))}
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
