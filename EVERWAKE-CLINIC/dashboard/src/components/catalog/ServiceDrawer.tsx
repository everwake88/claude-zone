'use client';
import { Trash2 } from 'lucide-react';
import { useEffect, useState } from 'react';
import { docName, useClinic } from '@/lib/clinic-data';
import { PRICE_UNITS } from '@/lib/format';
import { useLang } from '@/lib/i18n';
import type { PriceKind, Service } from '@/lib/types';
import { DocDot } from '../booking/pickers';
import { Button, Drawer, Field, Input, Segmented, Select, Switch, Textarea } from '../ui';
import { useTenant } from '../tenant';
import { CATEGORIES, useCatalog } from './Services';

const DAYS = [6, 0, 1, 2, 3, 4, 5];
const DAY_LABEL = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
type Form = { name_ar: string; name_en: string; aliases: string; category: string; description_ar: string; duration_min: string; price_kind: PriceKind;
  price: string; price_max: string; price_unit: string; price_note_ar: string; sessions: string; session_gap_days: string; prep_ar: string; aftercare_ar: string;
  doctor_ids: string[]; days: number[]; min_age: string; max_age: string; needs_consult_first: boolean; agent_visible: boolean; bookable: boolean; resource_kind: string };

const blank: Form = { name_ar: '', name_en: '', aliases: '', category: 'procedure', description_ar: '', duration_min: '20', price_kind: 'fixed', price: '', price_max: '',
  price_unit: 'visit', price_note_ar: '', sessions: '1', session_gap_days: '', prep_ar: '', aftercare_ar: '', doctor_ids: [], days: [], min_age: '', max_age: '',
  needs_consult_first: false, agent_visible: true, bookable: true, resource_kind: '' };

// Everything about one service: what patients call it, how long it takes, its price, who does it and
// when, what to tell the patient before and after. Saved as one change you can undo.
export function ServiceDrawer({ service, open, onClose }: { service: Service | null; open: boolean; onClose: () => void }) {
  const { t } = useLang();
  const { can, tenant } = useTenant();
  const { doctors } = useClinic();
  const { busy, change } = useCatalog();
  const [f, setF] = useState<Form>(blank);
  useEffect(() => {
    if (!open) return;
    const s = service;
    setF(s ? { name_ar: s.name_ar, name_en: s.name_en || '', aliases: s.aliases.join('، '), category: s.category, description_ar: s.description_ar || '',
      duration_min: String(s.duration_min), price_kind: s.price_kind, price: s.price != null ? String(s.price) : '', price_max: s.price_max != null ? String(s.price_max) : '',
      price_unit: s.price_unit, price_note_ar: s.price_note_ar || '', sessions: String(s.sessions), session_gap_days: s.session_gap_days != null ? String(s.session_gap_days) : '',
      prep_ar: s.prep_ar || '', aftercare_ar: s.aftercare_ar || '', doctor_ids: s.doctor_ids, days: s.days, min_age: s.min_age != null ? String(s.min_age) : '',
      max_age: s.max_age != null ? String(s.max_age) : '', needs_consult_first: s.needs_consult_first, agent_visible: s.agent_visible, bookable: s.bookable,
      resource_kind: s.resource_kind || '' } : blank);
  }, [open, service]);
  const set = <K extends keyof Form>(k: K, v: Form[K]) => setF(x => ({ ...x, [k]: v }));
  const num = (v: string) => (v.trim() === '' ? null : Number(v));
  const fields = () => ({
    name_ar: f.name_ar.trim(), name_en: f.name_en.trim() || null, aliases: f.aliases.split(/[،,]/).map(x => x.trim()).filter(Boolean), category: f.category,
    description_ar: f.description_ar || null, duration_min: Number(f.duration_min) || 15, price_kind: f.price_kind,
    price: ['after_exam', 'free'].includes(f.price_kind) ? (f.price_kind === 'free' ? 0 : null) : num(f.price), price_max: f.price_kind === 'range' ? num(f.price_max) : null,
    price_unit: f.price_unit, price_note_ar: f.price_note_ar || null, sessions: Number(f.sessions) || 1, session_gap_days: num(f.session_gap_days),
    prep_ar: f.prep_ar || null, aftercare_ar: f.aftercare_ar || null, doctor_ids: f.doctor_ids, days: f.days, min_age: num(f.min_age), max_age: num(f.max_age),
    needs_consult_first: f.needs_consult_first, agent_visible: f.agent_visible, bookable: f.bookable, resource_kind: f.resource_kind || null
  });
  const save = async () => {
    const x = fields();
    const r = service
      ? await change([{ op: 'update_service', service: service.code, fields: x }], t('{name} saved.', { name: x.name_ar }))
      : await change([{ op: 'add_service', ...x, duration: x.duration_min, unit: x.price_unit }], t('{name} added.', { name: x.name_ar }));
    if (r) onClose();
  };
  const remove = async () => {
    if (!service) return;
    const r = await change([{ op: 'remove_service', service: service.code }], t('{name} removed.', { name: service.name_ar }));
    if (r) onClose();
  };
  const ro = !can.edit;
  const docs = doctors.filter(d => d.is_active);

  return (
    <Drawer open={open} onClose={onClose} width="max-w-[640px]" title={service ? service.name_ar : t('Add a service')}
      footer={ro ? <Button variant="outline" onClick={onClose}>{t('Close')}</Button> : <>
        {service && <Button variant="ghost" className="me-auto text-critical" onClick={remove}><Trash2 className="size-4" aria-hidden />{t('Remove')}</Button>}
        <Button variant="outline" onClick={onClose}>{t('Cancel')}</Button>
        <Button busy={busy} disabled={!f.name_ar.trim()} onClick={save}>{t('Save')}</Button>
      </>}>
      <fieldset disabled={ro} className="space-y-6">
        <section className="grid gap-4 sm:grid-cols-2">
          <Field label={t('Name in Arabic')}><Input dir="rtl" value={f.name_ar} onChange={e => set('name_ar', e.target.value)} placeholder="تنضيف جير وتلميع" /></Field>
          <Field label={t('Name in English')}><Input dir="ltr" value={f.name_en} onChange={e => set('name_en', e.target.value)} placeholder="Scaling and polishing" /></Field>
          <Field label={t('Other names patients use')} hint={t('Separated by commas. The assistant recognises these.')} className="sm:col-span-2">
            <Input value={f.aliases} onChange={e => set('aliases', e.target.value)} placeholder="تنظيف، جير، تلميع" />
          </Field>
          <Field label={t('Kind')}><Select value={f.category} onChange={e => set('category', e.target.value)}>{CATEGORIES.map(c => <option key={c.key} value={c.key}>{t(c.label)}</option>)}</Select></Field>
          <Field label={t('How long (minutes)')} hint={t('Sets the length of the booking.')}><Input inputMode="numeric" value={f.duration_min} onChange={e => set('duration_min', e.target.value.replace(/\D/g, ''))} /></Field>
        </section>

        <section className="space-y-3 rounded-2xl bg-raised p-4 ring-1 ring-inset ring-border">
          <h3 className="text-[13px] font-semibold">{t('Price')}</h3>
          <Segmented label="svc-kind" value={f.price_kind} onChange={v => set('price_kind', v)}
            options={[{ value: 'fixed', label: t('Fixed') }, { value: 'range', label: t('From–to') }, { value: 'from', label: t('From') }, { value: 'after_exam', label: t('After check-up') }, { value: 'free', label: t('Free') }]} />
          <div className="grid gap-3 sm:grid-cols-3">
            {!['after_exam', 'free'].includes(f.price_kind) && <Field label={f.price_kind === 'range' ? t('From') : t('Price ({sym})', { sym: tenant.currency_symbol })}><Input inputMode="numeric" value={f.price} onChange={e => set('price', e.target.value.replace(/[^\d.]/g, ''))} className="tabular-nums" /></Field>}
            {f.price_kind === 'range' && <Field label={t('Up to')}><Input inputMode="numeric" value={f.price_max} onChange={e => set('price_max', e.target.value.replace(/[^\d.]/g, ''))} className="tabular-nums" /></Field>}
            <Field label={t('Per')}><Select value={f.price_unit} onChange={e => set('price_unit', e.target.value)}>{Object.entries(PRICE_UNITS).map(([k, v]) => <option key={k} value={k}>{k === 'visit' ? t('visit') : t(v)}</option>)}</Select></Field>
          </div>
          <Field label={t('Why the price varies (the assistant says this)')}><Input value={f.price_note_ar} onChange={e => set('price_note_ar', e.target.value)} placeholder="حسب نوع الزرعة وحالة العظم" /></Field>
        </section>

        <section className="grid gap-4 sm:grid-cols-2">
          <Field label={t('Sessions')}><Input inputMode="numeric" value={f.sessions} onChange={e => set('sessions', e.target.value.replace(/\D/g, ''))} /></Field>
          <Field label={t('Days between sessions')}><Input inputMode="numeric" value={f.session_gap_days} onChange={e => set('session_gap_days', e.target.value.replace(/\D/g, ''))} /></Field>
          {docs.length > 1 && (
            <Field label={t('Who does it')} hint={t('None chosen: every doctor of this speciality.')} className="sm:col-span-2">
              <div className="flex flex-wrap gap-1.5">
                {docs.map(d => {
                  const on = f.doctor_ids.includes(d.id);
                  return <button key={d.id} type="button" aria-pressed={on} onClick={() => set('doctor_ids', on ? f.doctor_ids.filter(x => x !== d.id) : [...f.doctor_ids, d.id])}
                    className={`press inline-flex h-8 items-center gap-1.5 rounded-full px-2.5 text-[13px] ${on ? 'bg-accent-soft font-medium text-gold-ink-ink ring-1 ring-inset ring-accent/40' : 'ring-1 ring-inset ring-border hover:bg-raised'}`}><DocDot color={d.color} />{docName(d, 'ar')}</button>;
                })}
              </div>
            </Field>
          )}
          <Field label={t('Only on')} hint={t('None chosen: every day the doctor works.')} className="sm:col-span-2">
            <div className="flex flex-wrap gap-1.5">
              {DAYS.map(d => {
                const on = f.days.includes(d);
                return <button key={d} type="button" aria-pressed={on} onClick={() => set('days', on ? f.days.filter(x => x !== d) : [...f.days, d])}
                  className={`press h-8 w-12 rounded-full text-[12.5px] ${on ? 'bg-accent text-white' : 'ring-1 ring-inset ring-border hover:bg-raised'}`}>{t(DAY_LABEL[d])}</button>;
              })}
            </div>
          </Field>
          <Field label={t('Youngest age')}><Input inputMode="decimal" value={f.min_age} onChange={e => set('min_age', e.target.value.replace(/[^\d.]/g, ''))} placeholder={t('years')} /></Field>
          <Field label={t('Oldest age')}><Input inputMode="decimal" value={f.max_age} onChange={e => set('max_age', e.target.value.replace(/[^\d.]/g, ''))} placeholder={t('years')} /></Field>
        </section>

        <section className="grid gap-4">
          <Field label={t('Before the visit (sent with the booking)')}><Textarea rows={2} value={f.prep_ar} onChange={e => set('prep_ar', e.target.value)} placeholder="تعال صايم 8 ساعات" /></Field>
          <Field label={t('After the visit (sent when it is marked done)')}><Textarea rows={3} value={f.aftercare_ar} onChange={e => set('aftercare_ar', e.target.value)} /></Field>
          <Field label={t('Description')}><Textarea rows={2} value={f.description_ar} onChange={e => set('description_ar', e.target.value)} /></Field>
        </section>

        <section className="divide-y divide-rule rounded-2xl ring-1 ring-inset ring-border">
          {([
            ['agent_visible', 'The assistant may mention it and its price'],
            ['bookable', 'The assistant may book it directly'],
            ['needs_consult_first', 'Needs a check-up first']
          ] as [keyof Form, string][]).map(([k, label]) => (
            <label key={k} className="flex items-center justify-between gap-3 px-4 py-3 text-[13.5px]">
              {t(label)}<Switch checked={Boolean(f[k])} onChange={v => set(k, v as never)} label={t(label)} />
            </label>
          ))}
          <label className="flex items-center justify-between gap-3 px-4 py-3 text-[13.5px]">
            {t('Needs a dental chair')}<Switch checked={f.resource_kind === 'chair'} onChange={v => set('resource_kind', v ? 'chair' : '')} label={t('Needs a dental chair')} />
          </label>
        </section>
      </fieldset>
    </Drawer>
  );
}
