'use client';
import { CalendarCheck2, CornerDownLeft, Search, User } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { SETTINGS_SECTIONS } from '@/components/settings/sections';
import { cx, dateShort, phone } from '@/lib/format';
import { useT } from '@/lib/i18n';
import { sb } from '@/lib/supabase/client';
import { useTenant } from '../tenant';
import { NAV } from './nav';

interface Hit { key: string; label: string; sub?: string; href: string; icon: typeof Search; group: string }

// One box to reach anything: a page or a setting by name, a patient by name, file number or phone,
// an appointment by its reference. "/" or Ctrl+K opens it. It opens and closes instantly: it is used
// many times a day from the keyboard, where motion only slows it down.
export function useCommandPalette() {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      const typing = e.target instanceof HTMLElement && (e.target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(e.target.tagName));
      if ((e.key === 'k' && (e.metaKey || e.ctrlKey)) || (e.key === '/' && !typing)) { e.preventDefault(); setOpen(o => !o); }
    };
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  }, []);
  return { open, setOpen };
}

export function CommandPalette({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { tenant, base } = useTenant();
  const router = useRouter();
  const t = useT();
  const [q, setQ] = useState('');
  const [found, setFound] = useState<Hit[]>([]);
  const [at, setAt] = useState(0);
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => { if (open) { setQ(''); setFound([]); setAt(0); setTimeout(() => input.current?.focus(), 0); } }, [open]);

  const pages = useMemo<Hit[]>(() => [
    ...NAV.flatMap(g => g.items.map(i => ({ key: 'p' + i.href, label: t(i.label), href: base + i.href, icon: i.icon, group: t('Pages') }))),
    ...SETTINGS_SECTIONS.map(s => ({ key: 's' + s.key, label: t(s.label), sub: t('Settings'), href: `${base}/settings/${s.key}`, icon: s.icon, group: t('Pages') }))
  ], [base, t]);

  useEffect(() => {
    const term = q.trim();
    if (term.length < 2) { setFound([]); return; }
    const timer = setTimeout(async () => {
      const db = sb();
      const [p, a] = await Promise.all([
        db.rpc('patient_search', { p_tenant: tenant.id, p_q: term, p_limit: 6 }),
        /^[a-z]{1,4}-?\d/i.test(term)
          ? db.from('appointments').select('id, ref_no, starts_at, patient_id').eq('tenant_id', tenant.id).ilike('ref_no', `%${term.replace(/[%_]/g, '')}%`).limit(4)
          : Promise.resolve({ data: [] })
      ]);
      setFound([
        ...((p.data || []) as { id: number; full_name: string; file_no: string | null; phone: string | null; age: string | null }[]).map(x => ({
          key: 'pt' + x.id, label: x.full_name, sub: [x.file_no && `#${x.file_no}`, x.age, phone(x.phone)].filter(Boolean).join(' · '),
          href: `${base}/patients/${x.id}`, icon: User, group: t('Patients') })),
        ...((a.data || []) as { id: number; ref_no: string; starts_at: string; patient_id: number | null }[]).map(x => ({
          key: 'a' + x.id, label: x.ref_no, sub: dateShort(x.starts_at, tenant.timezone),
          href: x.patient_id ? `${base}/patients/${x.patient_id}` : `${base}/calendar`, icon: CalendarCheck2, group: t('Appointments') }))
      ]);
    }, 160);
    return () => clearTimeout(timer);
  }, [q, tenant.id, tenant.timezone, base, t]);

  const term = q.trim().toLowerCase();
  const list = useMemo(() => [
    ...pages.filter(p => !term || p.label.toLowerCase().includes(term) || (p.sub || '').toLowerCase().includes(term)).slice(0, term ? 5 : 9),
    ...found
  ], [pages, found, term]);
  useEffect(() => { setAt(0); }, [term, found.length]);

  const go = useCallback((h: Hit) => { onClose(); router.push(h.href); }, [onClose, router]);
  if (!open) return null;

  return (
    <div className="fixed inset-0 z-[70] flex items-start justify-center px-4 pt-[12vh]" role="dialog" aria-modal="true" aria-label={t('Search')}>
      <div className="absolute inset-0 bg-ink/30" onClick={onClose} />
      <div className="relative w-full max-w-xl overflow-hidden rounded-xl bg-sheet shadow-[0_24px_64px_-24px_rgb(15_23_41/.5)] ring-1 ring-border">
        <label className="flex items-center gap-3 border-b border-rule px-4">
          <Search className="size-[18px] shrink-0 text-faint" aria-hidden />
          <input ref={input} value={q} onChange={e => setQ(e.target.value)} dir="auto"
            onKeyDown={e => {
              if (e.key === 'Escape') onClose();
              else if (e.key === 'ArrowDown') { e.preventDefault(); setAt(i => Math.min(list.length - 1, i + 1)); }
              else if (e.key === 'ArrowUp') { e.preventDefault(); setAt(i => Math.max(0, i - 1)); }
              else if (e.key === 'Enter' && list[at]) go(list[at]);
            }}
            placeholder={t('A patient, a phone number, a page…')} aria-label={t('Search')}
            className="h-13 flex-1 bg-transparent text-[15px] text-ink outline-none placeholder:text-faint" />
          <kbd className="rounded-md bg-raised px-1.5 py-0.5 text-[11px] text-muted ring-1 ring-border">Esc</kbd>
        </label>
        <ul className="max-h-[50vh] overflow-y-auto p-1.5" role="listbox">
          {list.length === 0 && <li className="px-3 py-6 text-center text-sm text-muted">{t('Nothing found for “{q}”', { q })}</li>}
          {list.map((h, i) => (
            <li key={h.key} role="option" aria-selected={i === at}>
              {(i === 0 || list[i - 1].group !== h.group) && <p className="px-3 pb-1 pt-2 text-xs font-medium text-faint">{h.group}</p>}
              <button onMouseMove={() => setAt(i)} onClick={() => go(h)}
                className={cx('flex w-full items-center gap-3 rounded-lg px-3 py-2 text-start text-sm', i === at ? 'bg-accent-soft' : '')}>
                <h.icon className={cx('size-4 shrink-0', i === at ? 'text-accent' : 'text-faint')} aria-hidden />
                <span className="min-w-0 flex-1">
                  <bdi className="block truncate font-medium">{h.label}</bdi>
                  {h.sub && <bdi className="block truncate text-xs text-muted">{h.sub}</bdi>}
                </span>
                {i === at && <CornerDownLeft className="size-3.5 text-faint rtl:-scale-x-100" aria-hidden />}
              </button>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
