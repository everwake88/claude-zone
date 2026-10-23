'use client';
import { HelpCircle } from 'lucide-react';
import { useEffect, useState, type ReactNode } from 'react';
import { useT } from '@/lib/i18n';

// A page's "how this works": the few steps a new owner needs, in plain words.
// Open until they press "Got it", then one line to open it again — remembered
// per page in this browser (a private window simply shows it again).
export function PageGuide({ id, steps, note }: { id: string; steps: ReactNode[]; note?: ReactNode }) {
  const t = useT();
  const key = `ew_guide_${id}`;
  const [open, setOpen] = useState<boolean | null>(null);
  useEffect(() => {
    let closed = false;
    try { closed = localStorage.getItem(key) === 'closed'; } catch { /* storage blocked: keep it open */ }
    setOpen(!closed);
  }, [key]);
  const set = (v: boolean) => {
    setOpen(v);
    try { if (v) localStorage.removeItem(key); else localStorage.setItem(key, 'closed'); } catch { /* nothing to remember with */ }
  };

  if (open === null) return null;
  if (!open) {
    return (
      <button type="button" onClick={() => set(true)} aria-expanded={false}
        className="mb-4 inline-flex items-center gap-1.5 rounded-md text-sm text-gold-ink hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gold/50">
        <HelpCircle className="size-4" aria-hidden /> {t('How this page works')}
      </button>
    );
  }
  return (
    <section aria-label={t('How this page works')} className="mb-5 rounded-xl border border-gold-line bg-gold-wash px-4 py-3">
      <div className="flex items-start justify-between gap-3">
        <h2 className="flex items-center gap-2 text-sm font-semibold text-ink"><HelpCircle className="size-4 text-gold-ink" aria-hidden /> {t('How this page works')}</h2>
        <button type="button" onClick={() => set(false)} aria-expanded
          className="shrink-0 rounded-md px-2 py-1 text-sm font-medium text-gold-ink hover:bg-white/70 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gold/50">
          {t('Got it')}
        </button>
      </div>
      <ol className="mt-2 list-decimal space-y-1 ps-5 text-sm leading-relaxed text-ink/85">
        {steps.map((s, i) => <li key={i}>{s}</li>)}
      </ol>
      {note && <p className="mt-2 text-xs text-muted">{note}</p>}
    </section>
  );
}
