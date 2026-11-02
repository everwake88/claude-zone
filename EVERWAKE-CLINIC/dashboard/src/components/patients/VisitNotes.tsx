'use client';
import { FileSignature, Plus } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { cx, dateShort } from '@/lib/format';
import { useLang } from '@/lib/i18n';
import { sb } from '@/lib/supabase/client';
import { Button, Card, Checkbox, Drawer, Empty, Field, Input, Pill, Select, Textarea, useAction } from '../ui';
import { useTenant } from '../tenant';
import type { Encounter, FormField, FormTemplate } from './types';

// The visits: each one a note written on the doctor's own form (the speciality's, changeable in
// Settings), a draft until it is signed. Stage 2's recorder fills the same form.
export function VisitNotes({ patientId, encounters, templates, onChanged, appointmentId }:
  { patientId: number; encounters: Encounter[]; templates: FormTemplate[]; onChanged: () => void; appointmentId?: number | null }) {
  const { t, lang } = useLang();
  const { tenant, can } = useTenant();
  const [open, setOpen] = useState<Encounter | 'new' | null>(null);
  return (
    <Card title={t('Visit notes')} pad={false}
      action={can.clinical && templates.length > 0 ? <Button size="sm" variant="outline" onClick={() => setOpen('new')}><Plus className="size-3.5" aria-hidden />{t('New visit note')}</Button> : undefined}>
      {encounters.length === 0 ? <div className="p-4"><Empty>{t('No visit notes yet.')}</Empty></div> : (
        <ul className="divide-y divide-rule">
          {encounters.map(e => {
            const tpl = templates.find(x => x.id === e.template_id) || templates[0];
            const filled = tpl ? tpl.schema.sections.flatMap(s => s.fields.map(f => ({ s, f, v: e.data?.[s.key]?.[f.key] }))).filter(x => x.v !== undefined && x.v !== '' && x.v !== null && x.v !== false) : [];
            return (
              <li key={e.id}>
                <button onClick={() => setOpen(e)} className="block w-full px-4 py-3 text-start hover:bg-raised">
                  <p className="flex flex-wrap items-center gap-2 text-[13.5px]">
                    <span className="font-medium">{dateShort(e.started_at, tenant.timezone)}</span>
                    {e.doctor && <span className="text-muted"><bdi>{e.doctor}</bdi></span>}
                    <Pill tone={e.status === 'signed' ? 'positive' : 'caution'}>{t(e.status === 'signed' ? 'Signed' : 'Draft')}</Pill>
                  </p>
                  {e.chief_complaint && <p className="mt-0.5 text-[13px]"><bdi>{e.chief_complaint}</bdi></p>}
                  {filled.length > 0 && (
                    <p className="mt-1 line-clamp-2 text-xs text-muted">
                      {filled.slice(0, 6).map(({ f, v }, i) => <bdi key={f.key}>{i ? ' · ' : ''}{lang === 'en' ? f.label_en : f.label_ar}: {Array.isArray(v) ? v.join('، ') : v === true ? t('yes') : String(v)}</bdi>)}
                    </p>
                  )}
                </button>
              </li>
            );
          })}
        </ul>
      )}
      <EncounterForm open={open !== null} encounter={open === 'new' ? null : open} templates={templates} patientId={patientId} appointmentId={appointmentId}
        onClose={() => setOpen(null)} onSaved={() => { setOpen(null); onChanged(); }} />
    </Card>
  );
}

function EncounterForm({ open, encounter, templates, patientId, appointmentId, onClose, onSaved }:
  { open: boolean; encounter: Encounter | null; templates: FormTemplate[]; patientId: number; appointmentId?: number | null; onClose: () => void; onSaved: () => void }) {
  const { t, lang } = useLang();
  const { busy, run } = useAction();
  const [tplId, setTplId] = useState('');
  const [data, setData] = useState<Record<string, Record<string, unknown>>>({});
  const [cc, setCc] = useState('');
  const [follow, setFollow] = useState('');
  useEffect(() => {
    if (!open) return;
    setTplId(encounter?.template_id || templates[0]?.id || '');
    setData(encounter?.data || {});
    setCc(encounter?.chief_complaint || '');
    setFollow(encounter?.follow_up_date || '');
  }, [open, encounter, templates]);
  const tpl = useMemo(() => templates.find(x => x.id === tplId), [templates, tplId]);
  const signed = encounter?.status === 'signed';
  const setV = (s: string, f: string, v: unknown) => setData(d => ({ ...d, [s]: { ...(d[s] || {}), [f]: v } }));

  const save = async (sign: boolean) => {
    const r = await run(async () => {
      const { data: res, error } = await sb().rpc('save_encounter', { p_patient: patientId, p: { id: encounter?.id || null, template_id: tplId || null,
        appointment_id: encounter?.appointment_id || appointmentId || null, chief_complaint: cc, data, follow_up_date: follow || null, sign } });
      if (error) throw new Error(error.message);
      return res;
    }, sign ? t('Signed.') : t('Draft saved.'));
    if (r) onSaved();
  };

  const field = (sKey: string, f: FormField) => {
    const v = data[sKey]?.[f.key];
    const label = lang === 'en' ? f.label_en : f.label_ar;
    const common = { disabled: signed };
    switch (f.type) {
      case 'textarea': return <Field key={f.key} label={label} className="sm:col-span-2"><Textarea rows={2} {...common} value={String(v ?? '')} onChange={e => setV(sKey, f.key, e.target.value)} /></Field>;
      case 'boolean': return <div key={f.key} className="flex items-end pb-1.5"><Checkbox checked={v === true} onChange={b => !signed && setV(sKey, f.key, b)} label={label} /></div>;
      case 'select': return <Field key={f.key} label={label}><Select {...common} value={String(v ?? '')} onChange={e => setV(sKey, f.key, e.target.value)}><option value="">—</option>{(f.options || []).map(o => <option key={o} value={o}>{o}</option>)}</Select></Field>;
      case 'multiselect': {
        const list = Array.isArray(v) ? (v as string[]) : [];
        return (
          <Field key={f.key} label={label} className="sm:col-span-2">
            <div className="flex flex-wrap gap-1.5">
              {(f.options || []).map(o => {
                const on = list.includes(o);
                return <button key={o} type="button" disabled={signed} aria-pressed={on} onClick={() => setV(sKey, f.key, on ? list.filter(x => x !== o) : [...list, o])}
                  className={cx('press h-8 rounded-[7px] px-2.5 text-[12.5px]', on ? 'bg-accent text-white' : 'ring-1 ring-inset ring-border hover:bg-raised')}>{o}</button>;
              })}
            </div>
          </Field>
        );
      }
      case 'scale': return (
        <Field key={f.key} label={label}>
          <div className="flex gap-1">{Array.from({ length: 10 }, (_, i) => i + 1).map(n => (
            <button key={n} type="button" disabled={signed} aria-pressed={v === n} onClick={() => setV(sKey, f.key, n)}
              className={cx('press h-8 flex-1 rounded-[6px] text-xs font-medium tabular-nums', v === n ? 'bg-accent text-white' : 'ring-1 ring-inset ring-border hover:bg-raised')}>{n}</button>))}
          </div>
        </Field>
      );
      case 'tooth_chart': case 'treatment_plan': return null;
      default: return (
        <Field key={f.key} label={<>{label}{f.unit && <span className="ms-1 text-faint">({f.unit})</span>}</>}>
          <Input {...common} inputMode={f.type === 'number' ? 'decimal' : undefined} value={String(v ?? '')} onChange={e => setV(sKey, f.key, e.target.value)} />
        </Field>
      );
    }
  };

  return (
    <Drawer open={open} onClose={onClose} width="max-w-[720px]"
      title={<span className="inline-flex items-center gap-2"><FileSignature className="size-4 text-accent" aria-hidden />{encounter ? (signed ? t('Signed visit note') : t('Visit note (draft)')) : t('New visit note')}</span>}
      footer={signed ? <Button variant="outline" onClick={onClose}>{t('Close')}</Button> : <>
        <Button variant="outline" busy={busy} onClick={() => save(false)}>{t('Save draft')}</Button>
        <Button variant="accent" busy={busy} onClick={() => save(true)}>{t('Sign')}</Button>
      </>}>
      <div className="space-y-6">
        <div className="grid gap-4 sm:grid-cols-2">
          {templates.length > 1 && (
            <Field label={t('Form')}><Select disabled={signed} value={tplId} onChange={e => setTplId(e.target.value)}>{templates.map(x => <option key={x.id} value={x.id}>{x.name}</option>)}</Select></Field>
          )}
          <Field label={t('Reason for the visit')} className={templates.length > 1 ? '' : 'sm:col-span-2'}><Input disabled={signed} value={cc} onChange={e => setCc(e.target.value)} /></Field>
        </div>
        {tpl?.schema.sections.map(s => (
          <section key={s.key}>
            <h3 className="mb-2.5 border-b border-rule pb-1.5 text-[13px] font-semibold text-muted">{lang === 'en' ? s.title_en : s.title_ar}</h3>
            <div className="grid gap-4 sm:grid-cols-2">{s.fields.map(f => field(s.key, f))}</div>
          </section>
        ))}
        <Field label={t('Follow-up on')} hint={t('The assistant can remind the patient and book it.')}><Input type="date" disabled={signed} value={follow} onChange={e => setFollow(e.target.value)} /></Field>
      </div>
    </Drawer>
  );
}
