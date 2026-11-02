'use client';
import { FileUp, Trash2 } from 'lucide-react';
import { AnimatePresence, motion } from 'motion/react';
import { useEffect, useRef, useState } from 'react';
import { docName, useClinic } from '@/lib/clinic-data';
import { cx } from '@/lib/format';
import { useLang } from '@/lib/i18n';
import type { ImportItem } from '@/lib/price-lines';
import { sb } from '@/lib/supabase/client';
import { DoctorPick } from '../booking/pickers';
import { Button, Checkbox, Drawer, Field, Input, Segmented, Select, Textarea, useAction, useToast } from '../ui';
import { useTenant } from '../tenant';

const KINDS = ['fixed', 'range', 'from', 'after_exam', 'free'] as const;
const KIND_LABEL: Record<string, string> = { fixed: 'Fixed', range: 'From–to', from: 'From', after_exam: 'After check-up', free: 'Free' };

// A price list (pasted, a PDF or a photo) read into lines you check before anything changes.
// Publishing merges it with the list (or replaces it) as one change you can undo.
export function ImportDrawer({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { tenant } = useTenant();
  const { t, lang } = useLang();
  const { doctors, services, refresh } = useClinic();
  const toast = useToast();
  const { busy, run } = useAction();
  const [step, setStep] = useState<'source' | 'review'>('source');
  const [text, setText] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [doctor, setDoctor] = useState<string | null>(null);
  const [importId, setImportId] = useState('');
  const [rows, setRows] = useState<(ImportItem & { keep: boolean })[]>([]);
  const [mode, setMode] = useState<'merge' | 'replace'>('merge');
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => { if (open) { setStep('source'); setText(''); setFile(null); setRows([]); setMode('merge'); setDoctor(tenant.doctor_id || doctors.find(d => d.is_active)?.id || null); } }, [open, doctors, tenant.doctor_id]);

  const read = async () => {
    const r = await run(async () => {
      const body = new FormData();
      body.set('tenant_id', tenant.id);
      if (doctor) body.set('doctor_id', doctor);
      if (text.trim()) body.set('text', text);
      if (file) body.set('file', file);
      const res = await fetch('/api/catalog-import', { method: 'POST', body });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(j.error || t('That did not work. Try again.'));
      return j as { import_id: string; items: ImportItem[] };
    });
    if (r) {
      if (!r.items.length) { toast(t('No prices were found in that. Try one service per line.'), 'critical'); return; }
      setImportId(r.import_id); setRows(r.items.map(i => ({ ...i, keep: true }))); setStep('review');
    }
  };
  const known = (n: string) => services.some(s => s.is_active && (s.name_ar.trim() === n.trim() || s.name_en?.trim().toLowerCase() === n.trim().toLowerCase()));
  const publish = async () => {
    const items = rows.filter(r => r.keep).map(({ keep: _k, ...x }) => x);
    const r = await run(async () => {
      const { data, error } = await sb().rpc('publish_catalog_import', { p_import: importId, p_items: items, p_mode: mode });
      if (error) throw new Error(error.message);
      return data as { change_id?: number };
    });
    if (r) {
      await refresh();
      onClose();
      toast(t('{n} prices published. The assistant uses them from the next message.', { n: items.length }), 'positive',
        r.change_id ? { label: t('Undo'), run: async () => { await sb().rpc('catalog_undo', { p_change: r.change_id }); await refresh(); } } : undefined);
    }
  };
  const set = (i: number, patch: Partial<ImportItem & { keep: boolean }>) => setRows(rs => rs.map((r, k) => (k === i ? { ...r, ...patch } : r)));
  const kept = rows.filter(r => r.keep).length;

  return (
    <Drawer open={open} onClose={onClose} width="max-w-[760px]" title={step === 'source' ? t('Import a price list') : t('Check the prices')}
      footer={step === 'source' ? <>
        <Button variant="outline" onClick={onClose}>{t('Cancel')}</Button>
        <Button busy={busy} disabled={!text.trim() && !file} onClick={read}>{t('Read the list')}</Button>
      </> : <>
        <Segmented label="imp-mode" size="sm" value={mode} onChange={setMode} options={[{ value: 'merge', label: t('Add and update') }, { value: 'replace', label: t('Replace the list') }]} />
        <span className="me-auto" />
        <Button variant="outline" onClick={() => setStep('source')}>{t('Back')}</Button>
        <Button busy={busy} disabled={!kept} onClick={publish}>{t('Publish {n}', { n: kept })}</Button>
      </>}>
      {step === 'source' ? (
        <div className="space-y-5">
          {doctors.filter(d => d.is_active).length > 1 && <Field label={t('Whose prices')}><DoctorPick doctors={doctors} value={doctor} onChange={setDoctor} layout="imp-doc" /></Field>}
          <Field label={t('Paste the list')} hint={t('One service per line, with its price: “تنضيف جير 600”, “زرعة 12000 - 18000 للسنة”, “تقويم شفاف بعد الكشف”.')}>
            <Textarea rows={8} value={text} onChange={e => setText(e.target.value)} placeholder={'كشف 300\nتنضيف جير وتلميع 600\nحشو عصب من 1500 لـ 2500 للسنة'} />
          </Field>
          <div className="flex items-center gap-3 text-[13px] text-muted"><span className="h-px flex-1 bg-rule" />{t('or')}<span className="h-px flex-1 bg-rule" /></div>
          <button type="button" onClick={() => input.current?.click()}
            className={cx('press flex w-full flex-col items-center gap-2 rounded-2xl border border-dashed px-4 py-8 text-center transition-colors', file ? 'border-accent bg-accent-soft' : 'border-control hover:bg-raised')}>
            <FileUp className="size-6 text-accent" aria-hidden />
            <span className="text-[14px] font-medium">{file ? file.name : t('A PDF or a photo of the price list')}</span>
            <span className="text-xs text-muted">{t('Read by AI. Nothing changes until you check it.')}</span>
          </button>
          <input ref={input} type="file" accept="application/pdf,image/*,.txt,.csv" className="hidden" onChange={e => setFile(e.target.files?.[0] || null)} />
        </div>
      ) : (
        <div className="space-y-3">
          <p className="text-[13px] text-muted">{t('Fix anything read wrongly, untick what should not go in. Names already on your list update their price; new names are added.')}
            {doctor && <> {t('For {doc}.', { doc: docName(doctors.find(d => d.id === doctor), lang) })}</>}</p>
          <ul className="space-y-2">
            <AnimatePresence initial={false}>
              {rows.map((r, i) => (
                <motion.li key={i} layout initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, height: 0 }} transition={{ duration: 0.2, delay: Math.min(i, 12) * 0.025 }}
                  className={cx('grid grid-cols-[28px_minmax(0,1fr)_32px] items-center gap-2 rounded-2xl p-2 ring-1 ring-inset sm:grid-cols-[28px_minmax(0,1.6fr)_132px_88px_88px_32px]',
                    r.keep ? 'bg-sheet ring-border' : 'bg-raised opacity-60 ring-border')}>
                  <Checkbox checked={r.keep} onChange={v => set(i, { keep: v })} label={<span className="sr-only">{t('Keep')}</span>} />
                  <div className="min-w-0">
                    <Input value={r.name_ar} onChange={e => set(i, { name_ar: e.target.value })} aria-label={t('Name')} />
                    <p className={cx('mt-1 text-[11.5px]', known(r.name_ar) ? 'text-accent' : 'text-positive')}>{known(r.name_ar) ? t('Updates the price on your list') : t('New service')}</p>
                  </div>
                  <button onClick={() => setRows(rs => rs.filter((_, k) => k !== i))} className="press flex size-8 items-center justify-center rounded-full text-muted hover:bg-raised sm:order-last" aria-label={t('Remove')}><Trash2 className="size-4" /></button>
                  <Select value={r.price_kind || 'fixed'} onChange={e => set(i, { price_kind: e.target.value as ImportItem['price_kind'] })} aria-label={t('Price shape')} className="col-span-3 sm:col-span-1">
                    {KINDS.map(k => <option key={k} value={k}>{t(KIND_LABEL[k])}</option>)}
                  </Select>
                  {!['after_exam', 'free'].includes(r.price_kind || 'fixed')
                    ? <Input inputMode="numeric" value={r.price ?? ''} onChange={e => set(i, { price: e.target.value === '' ? null : Number(e.target.value.replace(/[^\d.]/g, '')) })} aria-label={t('Price')} className="col-span-2 tabular-nums sm:col-span-1" />
                    : <span className="col-span-2 text-xs text-muted sm:col-span-1">—</span>}
                  {r.price_kind === 'range'
                    ? <Input inputMode="numeric" value={r.price_max ?? ''} onChange={e => set(i, { price_max: e.target.value === '' ? null : Number(e.target.value.replace(/[^\d.]/g, '')) })} aria-label={t('Up to')} className="tabular-nums" />
                    : <span className="hidden sm:block" />}
                </motion.li>
              ))}
            </AnimatePresence>
          </ul>
        </div>
      )}
    </Drawer>
  );
}
