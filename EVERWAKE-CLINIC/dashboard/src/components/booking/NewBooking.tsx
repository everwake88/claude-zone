'use client';
import { MessageCircle, Search, UserPlus, X } from 'lucide-react';
import { AnimatePresence, motion } from 'motion/react';
import { useEffect, useMemo, useState } from 'react';
import { docName, serviceName, useClinic } from '@/lib/clinic-data';
import { okOrThrow } from '@/lib/codes';
import { clock, cx, dayLabel, phone as fmtPhone } from '@/lib/format';
import { useLang } from '@/lib/i18n';
import { ping } from '@/lib/outbox-client';
import { sb } from '@/lib/supabase/client';
import type { Slot } from '@/lib/types';
import { Avatar, Button, Checkbox, Drawer, Field, Input, Segmented, Select, Textarea, useAction, useToast } from '../ui';
import { useTenant } from '../tenant';
import { DoctorPick, PlacePick } from './pickers';
import { SlotPicker } from './SlotPicker';

export interface BookingPrefill { patientId?: number; patientName?: string; doctorId?: string; locationId?: string; date?: string }
interface Found { id: number; full_name: string; file_no: string | null; phone: string | null; age: string | null; last_visit_at: string | null }

// A booking made at the desk or on the phone: who, with whom, then a day and a time from what is
// really free (the same slots the assistant offers). The patient gets the confirmation on WhatsApp.
export function NewBooking({ open, onClose, prefill }: { open: boolean; onClose: () => void; prefill?: BookingPrefill }) {
  const { tenant } = useTenant();
  const { t, lang } = useLang();
  const { doctors, locations, services, schedules } = useClinic();
  const { busy, run } = useAction();

  const [q, setQ] = useState('');
  const [found, setFound] = useState<Found[] | null>(null);
  const [patient, setPatient] = useState<{ id: number; name: string; sub?: string } | null>(null);
  const [isNew, setIsNew] = useState(false);
  const [np, setNp] = useState({ full_name: '', phone: '', age: '', sex: '' });
  const [doctor, setDoctor] = useState<string | null>(null);
  const [place, setPlace] = useState<string | null>(null);
  const [service, setService] = useState<string>('');
  const [slot, setSlot] = useState<Slot | null>(null);
  const [reason, setReason] = useState('');
  const [source, setSource] = useState<'phone' | 'walk_in' | 'dashboard'>('phone');
  const [notify, setNotify] = useState(true);

  // a fresh form each time it opens, with what the page already knew
  useEffect(() => {
    if (!open) return;
    setQ(''); setFound(null); setIsNew(false); setNp({ full_name: '', phone: '', age: '', sex: '' });
    setPatient(prefill?.patientId ? { id: prefill.patientId, name: prefill.patientName || '' } : null);
    const d = prefill?.doctorId || doctors.find(x => x.is_active)?.id || null;
    setDoctor(d); setPlace(prefill?.locationId || null); setService(''); setSlot(null);
    setReason(''); setSource('phone'); setNotify(true);
  }, [open, prefill, doctors]);

  // the doctor's locations (from the week's schedule) and services
  const docLocs = useMemo(() => {
    const ids = new Set(schedules.filter(s => s.doctor_id === doctor && s.is_active).map(s => s.location_id));
    return locations.filter(l => l.is_active && ids.has(l.id));
  }, [schedules, locations, doctor]);
  const docServices = useMemo(() => services.filter(s => s.is_active && s.bookable && (!s.doctor_ids.length || (doctor && s.doctor_ids.includes(doctor)))), [services, doctor]);
  useEffect(() => { if (docLocs.length && (!place || !docLocs.some(l => l.id === place))) setPlace(docLocs.length === 1 ? docLocs[0].id : null); }, [docLocs, place]);

  // patients, as the desk types
  useEffect(() => {
    const term = q.trim();
    if (term.length < 2) { setFound(null); return; }
    const timer = setTimeout(async () => {
      const { data } = await sb().rpc('patient_search', { p_tenant: tenant.id, p_q: term, p_limit: 6 });
      setFound((data || []) as Found[]);
    }, 180);
    return () => clearTimeout(timer);
  }, [q, tenant.id]);

  const query = useMemo(() => (open && doctor ? { doctor_id: doctor, location_id: place, service_id: service || null,
    patient_id: patient?.id || null, from: prefill?.date || null } : null), [open, doctor, place, service, patient?.id, prefill?.date]);
  const hasPhone = isNew ? np.phone.replace(/\D/g, '').length >= 10 : !!patient;

  const toast = useToast();
  const book = async () => {
    if (!slot || !doctor) return;
    const r = await run(async () => {
      const { data, error } = await sb().rpc('staff_book', { p_tenant: tenant.id, p: {
        doctor_id: doctor, location_id: slot.location_id, service_id: service || null, resource_id: slot.resource_id || null,
        kind: slot.kind, starts_at: slot.kind === 'slot' ? slot.starts_at : null, date: slot.date,
        patient_id: isNew ? null : patient?.id, patient: isNew ? { ...np, sex: np.sex || null } : null,
        reason: reason || null, source, notify } });
      if (error) throw new Error(error.message);
      const res = okOrThrow(data as { ok?: boolean; error?: string; appointment?: { ref_no: string }; notified?: boolean });
      if (res.notified) ping();
      return res;
    });
    if (r) {
      onClose();
      const ref = r.appointment?.ref_no || '';
      toast(r.notified ? t('Booked {ref}. The confirmation is on its way.', { ref }) : t('Booked {ref}.', { ref }));
    }
  };

  const who = isNew ? np.full_name.trim().length > 1 : !!patient;
  const ready = who && !!slot;

  return (
    <Drawer open={open} onClose={onClose} title={t('New booking')} width="max-w-[560px]"
      footer={<>
        <Button variant="outline" onClick={onClose}>{t('Cancel')}</Button>
        <Button busy={busy} disabled={!ready} onClick={book}>
          {slot ? t('Book {when}', { when: slot.kind === 'queue' ? t('number {n}', { n: slot.queue_no }) : clock(slot.starts_at, tenant.timezone) }) : t('Book')}
        </Button>
      </>}>
      <div className="space-y-6">
        {/* who */}
        <section className="space-y-2.5">
          <h3 className="text-[13px] font-medium">{t('Patient')}</h3>
          {patient && !isNew ? (
            <div className="c-pop flex items-center gap-3 rounded-xl bg-raised px-3 py-2.5 ring-1 ring-inset ring-border">
              <Avatar name={patient.name} size={32} />
              <div className="min-w-0 flex-1">
                <p className="truncate font-medium">{patient.name}</p>
                {patient.sub && <p className="truncate text-xs text-muted">{patient.sub}</p>}
              </div>
              <button onClick={() => { setPatient(null); setQ(''); }} className="press rounded-md p-1.5 text-muted hover:bg-active" aria-label={t('Change patient')}><X className="size-4" /></button>
            </div>
          ) : isNew ? (
            <div className="c-fade grid gap-3 sm:grid-cols-2">
              <Field label={t('Full name')} className="sm:col-span-2"><Input value={np.full_name} onChange={e => setNp({ ...np, full_name: e.target.value })} placeholder="أحمد محمود" autoFocus /></Field>
              <Field label={t('Mobile (WhatsApp)')}><Input dir="ltr" inputMode="tel" value={np.phone} onChange={e => setNp({ ...np, phone: e.target.value })} placeholder="010 0000 0000" /></Field>
              <div className="grid grid-cols-[1fr_auto] gap-3">
                <Field label={t('Age')}><Input inputMode="numeric" value={np.age} onChange={e => setNp({ ...np, age: e.target.value })} placeholder={t('e.g. 34 or 8 months')} /></Field>
                <Field label={t('Sex')}>
                  <Segmented label="sex" size="md" value={(np.sex || 'x') as 'male' | 'female' | 'x'} onChange={v => setNp({ ...np, sex: v === 'x' ? '' : v })}
                    options={[{ value: 'female', label: t('F') }, { value: 'male', label: t('M') }]} />
                </Field>
              </div>
              <button onClick={() => setIsNew(false)} className="justify-self-start text-[13px] font-medium text-gold-ink hover:underline sm:col-span-2">{t('Search existing patients instead')}</button>
            </div>
          ) : (
            <div>
              <div className="relative">
                <Search className="pointer-events-none absolute start-3 top-1/2 size-4 -translate-y-1/2 text-faint" aria-hidden />
                <Input value={q} onChange={e => setQ(e.target.value)} placeholder={t('Name, mobile or file number')} className="ps-9" autoFocus />
              </div>
              <AnimatePresence initial={false}>
                {found && (
                  <motion.ul initial={{ opacity: 0, y: -4 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }} transition={{ duration: 0.16 }}
                    className="mt-1.5 divide-y divide-rule overflow-hidden rounded-xl ring-1 ring-border">
                    {found.map(p => (
                      <li key={p.id}>
                        <button onClick={() => setPatient({ id: p.id, name: p.full_name, sub: [p.file_no && `#${p.file_no}`, p.age, fmtPhone(p.phone)].filter(Boolean).join(' · ') })}
                          className="flex w-full items-center gap-3 px-3 py-2 text-start hover:bg-raised">
                          <Avatar name={p.full_name} size={28} />
                          <span className="min-w-0 flex-1">
                            <span className="block truncate text-[13.5px] font-medium">{p.full_name}</span>
                            <span className="block truncate text-xs text-muted">{[p.file_no && `#${p.file_no}`, p.age, fmtPhone(p.phone)].filter(Boolean).join(' · ')}</span>
                          </span>
                        </button>
                      </li>
                    ))}
                    {found.length === 0 && <li className="px-3 py-2.5 text-[13px] text-muted">{t('No patient by that name or number.')}</li>}
                  </motion.ul>
                )}
              </AnimatePresence>
              <button onClick={() => { setIsNew(true); setNp(n => ({ ...n, full_name: /\d{5}/.test(q) ? '' : q, phone: /\d{5}/.test(q) ? q : '' })); }}
                className="press mt-2 inline-flex items-center gap-1.5 rounded-full px-1 text-[13px] font-medium text-gold-ink hover:underline">
                <UserPlus className="size-4" aria-hidden />{t('A new patient')}
              </button>
            </div>
          )}
        </section>

        {/* with whom, where, for what */}
        <section className="space-y-3">
          {doctors.filter(d => d.is_active).length > 1 && <Field label={t('Doctor')}><DoctorPick doctors={doctors} value={doctor} onChange={setDoctor} layout="nb-doc" /></Field>}
          {docLocs.length > 1 && <Field label={t('Location')}><PlacePick locations={docLocs} value={place} onChange={setPlace} layout="nb-loc" /></Field>}
          <Field label={t('Service')} hint={t('Sets how long the visit is and which chair it needs.')}>
            <Select value={service} onChange={e => setService(e.target.value)}>
              <option value="">{t('Check-up (the usual visit)')}</option>
              {docServices.map(s => <option key={s.id} value={s.id}>{serviceName(s, lang)} · {s.duration_min} {t('min')}</option>)}
            </Select>
          </Field>
        </section>

        {/* when */}
        <section className="space-y-2.5">
          <h3 className="text-[13px] font-medium">{t('Day and time')}</h3>
          <SlotPicker query={query} value={slot} onChange={setSlot} layout="nb" startDate={prefill?.date} />
        </section>

        <section className="space-y-3">
          <Field label={t('Reason, in the patient’s words')}><Textarea rows={2} value={reason} onChange={e => setReason(e.target.value)} placeholder="ضرس بيوجعني من يومين" /></Field>
          <div className="flex flex-wrap items-center justify-between gap-3">
            <Segmented label="source" size="sm" value={source} onChange={setSource}
              options={[{ value: 'phone', label: t('By phone') }, { value: 'walk_in', label: t('Walked in') }, { value: 'dashboard', label: t('Other') }]} />
            <Checkbox checked={notify && hasPhone} onChange={setNotify}
              label={<span className={cx('inline-flex items-center gap-1.5', !hasPhone && 'text-faint')}><MessageCircle className="size-4" aria-hidden />{t('Send the confirmation on WhatsApp')}</span>} />
          </div>
        </section>
        {doctor && slot && (
          <p className="c-fade rounded-xl bg-accent-soft px-3 py-2.5 text-[13px] text-accent-ink">
            {docName(doctors.find(d => d.id === doctor), lang)} · {dayLabel(slot.date, tenant.timezone)} · {slot.kind === 'queue' ? t('number {n}', { n: slot.queue_no }) : clock(slot.starts_at, tenant.timezone)}
          </p>
        )}
      </div>
    </Drawer>
  );
}
