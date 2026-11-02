'use client';
import { CalendarOff, Copy, MapPin, Plus, Smartphone, Trash2, UserPlus, X } from 'lucide-react';
import { AnimatePresence, motion } from 'motion/react';
import { useEffect, useState } from 'react';
import { docName, placeName, useClinic } from '@/lib/clinic-data';
import { cx, dateShort, phone as fmtPhone } from '@/lib/format';
import { useLang } from '@/lib/i18n';
import { sb } from '@/lib/supabase/client';
import type { Doctor, Location, Role, Schedule } from '@/lib/types';
import { useCached } from '@/lib/use-cached';
import { DocDot } from '../booking/pickers';
import { useShell } from '../shell/Shell';
import { Avatar, Button, Card, Checkbox, Drawer, Empty, Field, Input, Pill, Segmented, Select, Skeleton, Switch, Textarea, useAction, useToast } from '../ui';
import { useTenant } from '../tenant';

const COLORS = ['#2f7d6d', '#b8693f', '#2347b5', '#7c3aed', '#be185d', '#0e7490', '#a16207', '#475569'];
const DAY_LABEL = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const WEEK = [6, 0, 1, 2, 3, 4, 5];

function useTableSave() {
  const { t } = useLang();
  const { refresh } = useClinic();
  const { busy, run } = useAction();
  const save = async (table: string, row: Record<string, unknown>, said = t('Saved.')) => run(async () => {
    const db = sb();
    const { id, ...rest } = row;
    const { error } = id ? await db.from(table).update(rest).eq('id', id as string) : await db.from(table).insert(rest);
    if (error) throw new Error(error.message);
    await refresh();
    return true;
  }, said);
  const remove = async (table: string, id: string, said = t('Removed.')) => run(async () => {
    const { error } = await sb().from(table).delete().eq('id', id);
    if (error) throw new Error(error.message);
    await refresh();
    return true;
  }, said);
  return { busy, save, remove };
}

// ---- Doctors ------------------------------------------------------------------------------
export function DoctorsSection() {
  const { t, lang } = useLang();
  const { doctors, ready } = useClinic();
  const [open, setOpen] = useState<Doctor | 'new' | null>(null);
  const { data: presets } = useCached<{ code: string; name_ar: string; name_en: string }[]>('presets', async () => {
    const { data } = await sb().from('specialty_presets').select('code, name_ar, name_en').order('sort');
    return (data || []) as { code: string; name_ar: string; name_en: string }[];
  });
  const spec = (c: string) => { const p = presets?.find(x => x.code === c); return p ? (lang === 'ar' ? p.name_ar : p.name_en) : c; };
  if (!ready) return <Skeleton className="h-64" />;
  return (
    <>
      <div className="mb-4 flex justify-end"><Button onClick={() => setOpen('new')}><UserPlus className="size-4" aria-hidden />{t('Add a doctor')}</Button></div>
      <div className="grid gap-3 sm:grid-cols-2">
        {doctors.map(d => (
          <button key={d.id} onClick={() => setOpen(d)} className={cx('card lift flex items-start gap-3 p-4 text-start', !d.is_active && 'opacity-60')}>
            <Avatar name={d.name_ar} hue={d.color} size={44} />
            <span className="min-w-0 flex-1">
              <span className="block truncate text-[15px] font-semibold">{docName(d, lang)}</span>
              <span className="block truncate text-[13px] text-muted">{spec(d.specialty)}{d.sub_specialty_ar ? <> · <bdi>{d.sub_specialty_ar}</bdi></> : null}</span>
              <span className="mt-1.5 flex flex-wrap gap-1.5">
                {!d.accepts_new && <Pill tone="caution">{t('No new patients')}</Pill>}
                {d.ops_whatsapp ? <Pill tone="positive">{t('WhatsApp commands on')}</Pill> : <Pill>{t('No WhatsApp for commands')}</Pill>}
                {!d.is_active && <Pill>{t('Not working now')}</Pill>}
              </span>
            </span>
          </button>
        ))}
      </div>
      <DoctorDrawer doctor={open === 'new' ? null : open} open={open !== null} onClose={() => setOpen(null)} presets={presets || []} />
    </>
  );
}

function DoctorDrawer({ doctor, open, onClose, presets }: { doctor: Doctor | null; open: boolean; onClose: () => void; presets: { code: string; name_ar: string; name_en: string }[] }) {
  const { tenant } = useTenant();
  const { t, lang } = useLang();
  const { busy, save } = useTableSave();
  const [f, setF] = useState<Partial<Doctor>>({});
  const [starter, setStarter] = useState(true);
  useEffect(() => { if (open) setF(doctor || { gender: 'female', specialty: tenant.specialty, color: COLORS[0], follow_up_days: 14, accepts_new: true, is_active: true, title_ar: 'د.', title_en: 'Dr.' }); }, [open, doctor, tenant.specialty]);
  const set = <K extends keyof Doctor>(k: K, v: Doctor[K]) => setF(x => ({ ...x, [k]: v }));
  const submit = async () => {
    const row = { id: doctor?.id, tenant_id: tenant.id, name_ar: f.name_ar, name_en: f.name_en || null, gender: f.gender, specialty: f.specialty, title_ar: f.title_ar || 'د.', title_en: f.title_en || 'Dr.',
      sub_specialty_ar: f.sub_specialty_ar || null, bio_ar: f.bio_ar || null, color: f.color, ops_whatsapp: f.ops_whatsapp ? f.ops_whatsapp.replace(/\D/g, '').replace(/^0(1\d{9})$/, '20$1') : null,
      follow_up_days: Number(f.follow_up_days) || 0, accepts_new: f.accepts_new, is_active: f.is_active };
    const r = await save('doctors', row, doctor ? t('Saved.') : t('Doctor added.'));
    if (r && !doctor && starter) {
      const { data } = await sb().from('doctors').select('id').eq('tenant_id', tenant.id).eq('name_ar', f.name_ar!).order('created_at', { ascending: false }).limit(1).maybeSingle();
      if (data) await sb().rpc('apply_preset', { p_tenant: tenant.id, p_specialty: f.specialty, p_doctor: (data as { id: string }).id });
    }
    if (r) onClose();
  };
  return (
    <Drawer open={open} onClose={onClose} title={doctor ? docName(doctor, lang) : t('Add a doctor')}
      footer={<><Button variant="outline" onClick={onClose}>{t('Cancel')}</Button><Button busy={busy} disabled={!f.name_ar?.trim()} onClick={submit}>{t('Save')}</Button></>}>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label={t('Name in Arabic')}><Input dir="rtl" value={f.name_ar || ''} onChange={e => set('name_ar', e.target.value)} placeholder="منى عادل" /></Field>
        <Field label={t('Name in English')}><Input dir="ltr" value={f.name_en || ''} onChange={e => set('name_en', e.target.value)} placeholder="Mona Adel" /></Field>
        <Field label={t('Patients call them')}>
          <Segmented label="doc-g" value={(f.gender || 'female') as 'female' | 'male'} onChange={v => set('gender', v)} options={[{ value: 'female', label: 'دكتورة' }, { value: 'male', label: 'دكتور' }]} />
        </Field>
        <Field label={t('Speciality')}><Select value={f.specialty || ''} onChange={e => set('specialty', e.target.value)}>{presets.map(p => <option key={p.code} value={p.code}>{lang === 'ar' ? p.name_ar : p.name_en}</option>)}</Select></Field>
        <Field label={t('Special interest')} className="sm:col-span-2"><Input value={f.sub_specialty_ar || ''} onChange={e => set('sub_specialty_ar', e.target.value)} placeholder="تجميل وزراعة الأسنان" /></Field>
        <Field label={t('A line about them (the assistant may say it)')} className="sm:col-span-2"><Textarea rows={2} value={f.bio_ar || ''} onChange={e => set('bio_ar', e.target.value)} /></Field>
        <Field label={t('Their own WhatsApp')} hint={t('From this number they can tell the assistant “I’ll be 20 minutes late” or change a price.')}><Input dir="ltr" inputMode="tel" value={f.ops_whatsapp ? fmtPhone(f.ops_whatsapp) : ''} onChange={e => set('ops_whatsapp', e.target.value)} placeholder="010 0000 0000" /></Field>
        <Field label={t('Follow-up within (days)')} hint={t('A visit within this many days is priced as a follow-up.')}><Input inputMode="numeric" value={String(f.follow_up_days ?? '')} onChange={e => set('follow_up_days', Number(e.target.value.replace(/\D/g, '')) || 0)} /></Field>
        <Field label={t('Colour on the calendar')} className="sm:col-span-2">
          <div className="flex flex-wrap gap-2">{COLORS.map(c => <button key={c} type="button" onClick={() => set('color', c)} aria-label={c} aria-pressed={f.color === c} className={cx('press size-8 rounded-full ring-2 ring-offset-2 ring-offset-sheet', f.color === c ? 'ring-ink' : 'ring-transparent')} style={{ background: c }} />)}</div>
        </Field>
        <label className="flex items-center justify-between gap-3 rounded-xl px-3 py-2 text-[13.5px] ring-1 ring-inset ring-border">{t('Takes new patients')}<Switch checked={!!f.accepts_new} onChange={v => set('accepts_new', v)} label={t('Takes new patients')} /></label>
        <label className="flex items-center justify-between gap-3 rounded-xl px-3 py-2 text-[13.5px] ring-1 ring-inset ring-border">{t('Working now')}<Switch checked={!!f.is_active} onChange={v => set('is_active', v)} label={t('Working now')} /></label>
        {!doctor && <div className="sm:col-span-2"><Checkbox checked={starter} onChange={setStarter} label={t('Add the speciality’s usual services (prices left for you)')} /></div>}
      </div>
    </Drawer>
  );
}

// ---- Locations & chairs -----------------------------------------------------------------------
export function LocationsSection() {
  const { tenant } = useTenant();
  const { t, lang } = useLang();
  const { locations, resources, ready } = useClinic();
  const { busy, save, remove } = useTableSave();
  const [open, setOpen] = useState<Location | 'new' | null>(null);
  const [chair, setChair] = useState<Record<string, string>>({});
  if (!ready) return <Skeleton className="h-64" />;
  return (
    <>
      <div className="mb-4 flex justify-end"><Button onClick={() => setOpen('new')}><Plus className="size-4" aria-hidden />{t('Add a location')}</Button></div>
      <div className="space-y-4">
        {locations.map(l => (
          <Card key={l.id} title={<span className="inline-flex items-center gap-2"><MapPin className="size-4 text-accent" aria-hidden />{placeName(l, lang)}</span>}
            sub={l.address_ar || t('No address yet — the assistant needs it to send directions')}
            action={<Button size="sm" variant="ghost" onClick={() => setOpen(l)}>{t('Edit')}</Button>}>
            <p className="mb-2 text-[13px] font-medium">{t('Chairs and rooms')}</p>
            <div className="flex flex-wrap items-center gap-2">
              <AnimatePresence initial={false}>
                {resources.filter(r => r.location_id === l.id && r.is_active).map(r => (
                  <motion.span key={r.id} layout initial={{ opacity: 0, scale: 0.9 }} animate={{ opacity: 1, scale: 1 }} exit={{ opacity: 0, scale: 0.9 }}
                    className="inline-flex h-8 items-center gap-1.5 rounded-full bg-raised ps-3 pe-1 text-[13px] ring-1 ring-inset ring-border">
                    <bdi>{lang === 'en' && r.name_en ? r.name_en : r.name_ar}</bdi>
                    <button onClick={() => remove('resources', r.id)} className="press rounded-full p-1 text-muted hover:bg-active" aria-label={t('Remove')}><X className="size-3.5" /></button>
                  </motion.span>
                ))}
              </AnimatePresence>
              <form className="flex gap-1.5" onSubmit={async e => { e.preventDefault(); const n = (chair[l.id] || '').trim(); if (!n) return;
                const ok = await save('resources', { tenant_id: tenant.id, location_id: l.id, kind: 'chair', name_ar: n }, t('Added.')); if (ok) setChair(c => ({ ...c, [l.id]: '' })); }}>
                <Input value={chair[l.id] || ''} onChange={e => setChair(c => ({ ...c, [l.id]: e.target.value }))} placeholder={t('Chair 3')} className="!h-8 !w-28" aria-label={t('New chair')} />
                <Button size="sm" variant="outline" type="submit" busy={busy}>{t('Add')}</Button>
              </form>
            </div>
            <p className="mt-2 text-xs text-muted">{t('A service that needs a chair is booked only when one is free, so two patients never share it.')}</p>
          </Card>
        ))}
        {!locations.length && <Empty>{t('No locations yet.')}</Empty>}
      </div>
      <LocationDrawer loc={open === 'new' ? null : open} open={open !== null} onClose={() => setOpen(null)} />
    </>
  );
}

function LocationDrawer({ loc, open, onClose }: { loc: Location | null; open: boolean; onClose: () => void }) {
  const { tenant } = useTenant();
  const { t } = useLang();
  const { busy, save } = useTableSave();
  const [f, setF] = useState<Partial<Location>>({});
  useEffect(() => { if (open) setF(loc || {}); }, [open, loc]);
  const set = (k: keyof Location) => (e: { target: { value: string } }) => setF(x => ({ ...x, [k]: e.target.value }));
  const submit = async () => {
    const r = await save('locations', { id: loc?.id, tenant_id: tenant.id, name_ar: f.name_ar, name_en: f.name_en || null, area_ar: f.area_ar || null,
      address_ar: f.address_ar || null, address_en: f.address_en || null, directions_ar: f.directions_ar || null, maps_url: f.maps_url || null,
      lat: f.lat ? Number(f.lat) : null, lng: f.lng ? Number(f.lng) : null, phone: f.phone || null });
    if (r) onClose();
  };
  return (
    <Drawer open={open} onClose={onClose} title={loc ? loc.name_ar : t('Add a location')}
      footer={<><Button variant="outline" onClick={onClose}>{t('Cancel')}</Button><Button busy={busy} disabled={!f.name_ar?.trim()} onClick={submit}>{t('Save')}</Button></>}>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label={t('Name in Arabic')}><Input dir="rtl" value={f.name_ar || ''} onChange={set('name_ar')} placeholder="المعادي" /></Field>
        <Field label={t('Name in English')}><Input dir="ltr" value={f.name_en || ''} onChange={set('name_en')} placeholder="Maadi" /></Field>
        <Field label={t('Address in Arabic')} className="sm:col-span-2"><Input dir="rtl" value={f.address_ar || ''} onChange={set('address_ar')} /></Field>
        <Field label={t('How to find it')} hint={t('Sent with the booking confirmation.')} className="sm:col-span-2"><Input dir="rtl" value={f.directions_ar || ''} onChange={set('directions_ar')} placeholder="الدور التالت فوق صيدلية العزبي" /></Field>
        <Field label={t('Latitude')} hint={t('The map pin sent after booking.')}><Input dir="ltr" inputMode="decimal" value={f.lat ?? ''} onChange={set('lat')} /></Field>
        <Field label={t('Longitude')}><Input dir="ltr" inputMode="decimal" value={f.lng ?? ''} onChange={set('lng')} /></Field>
        <Field label={t('Google Maps link')} className="sm:col-span-2"><Input dir="ltr" value={f.maps_url || ''} onChange={set('maps_url')} /></Field>
        <Field label={t('Phone')}><Input dir="ltr" value={f.phone || ''} onChange={set('phone')} /></Field>
      </div>
    </Drawer>
  );
}

// ---- Schedules & days off ------------------------------------------------------------------------
export function SchedulesSection() {
  const { tenant } = useTenant();
  const { t, lang } = useLang();
  const shell = useShell();
  const { doctors, locations, schedules, ready } = useClinic();
  const { busy, save, remove } = useTableSave();
  const docs = doctors.filter(d => d.is_active);
  const [doctor, setDoctor] = useState<string>('');
  useEffect(() => { if (!doctor && docs[0]) setDoctor(tenant.doctor_id || docs[0].id); }, [docs, doctor, tenant.doctor_id]);
  const { data: offs, refresh } = useCached<{ id: string; on_date: string; kind: string; start_time: string | null; end_time: string | null; reason: string | null }[]>(
    doctor ? `offs:${doctor}` : null, async () => {
      const { data } = await sb().from('schedule_exceptions').select('id, on_date, kind, start_time, end_time, reason').eq('doctor_id', doctor)
        .gte('on_date', new Date().toISOString().slice(0, 10)).order('on_date', { ascending: true }).limit(40);
      return (data || []) as { id: string; on_date: string; kind: string; start_time: string | null; end_time: string | null; reason: string | null }[];
    });
  if (!ready) return <Skeleton className="h-80" />;
  const mine = schedules.filter(s => s.doctor_id === doctor);
  const add = (weekday: number) => save('schedules', { tenant_id: tenant.id, doctor_id: doctor, location_id: locations[0]?.id, weekday, start_time: '17:00', end_time: '21:00', mode: 'slots', slot_minutes: 15, online_booking: true, is_active: true }, t('Added.'));
  const upd = (s: Schedule, patch: Partial<Schedule>) => save('schedules', { id: s.id, ...patch });
  return (
    <div className="space-y-5">
      {docs.length > 1 && (
        <div className="rail -mx-1 overflow-x-auto px-1">
          <Segmented label="sch-doc" value={doctor} onChange={setDoctor} options={docs.map(d => ({ value: d.id, label: <span className="inline-flex items-center gap-1.5"><DocDot color={d.color} />{docName(d, lang)}</span> }))} />
        </div>
      )}
      <Card pad={false} title={t('The week')} sub={t('Slots: fixed times. Queue: a number (الدور) with an estimated time. Both: the two together.')}>
        <ul className="divide-y divide-rule">
          {WEEK.map(w => {
            const rows = mine.filter(s => s.weekday === w);
            return (
              <li key={w} className="grid gap-2 px-5 py-3 sm:grid-cols-[88px_minmax(0,1fr)]">
                <span className="pt-1.5 text-[13.5px] font-medium">{t(DAY_LABEL[w])}</span>
                <div className="space-y-2">
                  {rows.map(s => (
                    <div key={s.id} className={cx('flex flex-wrap items-center gap-2 rounded-xl bg-raised p-2 ring-1 ring-inset ring-border', !s.is_active && 'opacity-60')}>
                      <Select aria-label={t('Location')} value={s.location_id} onChange={e => upd(s, { location_id: e.target.value })} className="!h-8 !w-36">{locations.map(l => <option key={l.id} value={l.id}>{placeName(l, lang)}</option>)}</Select>
                      <Input type="time" aria-label={t('From')} defaultValue={s.start_time.slice(0, 5)} onBlur={e => e.target.value !== s.start_time.slice(0, 5) && upd(s, { start_time: e.target.value })} className="!h-8 !w-[124px]" />
                      <span className="text-muted">–</span>
                      <Input type="time" aria-label={t('To')} defaultValue={s.end_time.slice(0, 5)} onBlur={e => e.target.value !== s.end_time.slice(0, 5) && upd(s, { end_time: e.target.value })} className="!h-8 !w-[124px]" />
                      <Select aria-label={t('How patients are seen')} value={s.mode} onChange={e => upd(s, { mode: e.target.value as Schedule['mode'] })} className="!h-8 !w-28">
                        <option value="slots">{t('Slots')}</option><option value="queue">{t('Queue')}</option><option value="both">{t('Both')}</option>
                      </Select>
                      {s.mode !== 'slots' && <Input inputMode="numeric" aria-label={t('Places in the queue')} title={t('Places in the queue')} defaultValue={s.capacity ?? ''} onBlur={e => upd(s, { capacity: Number(e.target.value) || null })} className="!h-8 !w-16" placeholder="20" />}
                      <label className="ms-auto inline-flex items-center gap-2 text-xs text-muted">{t('On WhatsApp')}<Switch checked={s.online_booking} onChange={v => upd(s, { online_booking: v })} label={t('On WhatsApp')} /></label>
                      <button onClick={() => remove('schedules', s.id)} className="press rounded-lg p-1.5 text-muted hover:bg-active hover:text-critical" aria-label={t('Remove')}><Trash2 className="size-4" /></button>
                    </div>
                  ))}
                  <button onClick={() => add(w)} disabled={busy || !doctor} className="press inline-flex h-8 items-center gap-1.5 rounded-full px-2 text-[13px] text-accent hover:bg-raised">
                    <Plus className="size-3.5" aria-hidden />{rows.length ? t('Another session') : t('Add a session')}
                  </button>
                </div>
              </li>
            );
          })}
        </ul>
      </Card>
      <Card pad={false} title={t('Days off and changes')} action={<Button size="sm" variant="outline" onClick={() => shell.blockTime(doctor)}><CalendarOff className="size-4" aria-hidden />{t('Block time')}</Button>}>
        <ul className="divide-y divide-rule">
          {(offs || []).map(o => (
            <li key={o.id} className="flex items-center gap-3 px-5 py-2.5 text-[13.5px]">
              <span className="w-28 font-medium">{dateShort(o.on_date, tenant.timezone)}</span>
              <span className="min-w-0 flex-1 text-muted">{t(o.kind === 'off' ? 'Off' : o.kind === 'extra' ? 'Extra session' : 'Changed hours')}{o.start_time ? ` · ${o.start_time.slice(0, 5)}–${(o.end_time || '').slice(0, 5)}` : ` · ${t('all day')}`}{o.reason ? <> · <bdi>{o.reason}</bdi></> : null}</span>
              <button onClick={async () => { await remove('schedule_exceptions', o.id); refresh(); }} className="press rounded-lg p-1.5 text-muted hover:bg-raised hover:text-critical" aria-label={t('Remove')}><Trash2 className="size-4" /></button>
            </li>
          ))}
          {offs && !offs.length && <li className="px-5 py-3 text-[13px] text-muted">{t('No days off coming up.')}</li>}
        </ul>
      </Card>
    </div>
  );
}

// ---- WhatsApp -------------------------------------------------------------------------------------
interface Channel { id: string; provider: string; label: string | null; phone_number: string | null; instance_name: string | null; base_url: string | null; status: string; is_active: boolean; last_inbound_at: string | null }
export function WhatsAppSection() {
  const { tenant } = useTenant();
  const { t } = useLang();
  const toast = useToast();
  const { busy, run } = useAction();
  const [f, setF] = useState({ label: '', phone_number: '', instance_name: '', base_url: '', api_key: '' });
  const [token, setToken] = useState<Record<string, string>>({});
  const { data, refresh } = useCached<Channel[]>(`channels:${tenant.id}`, async () => {
    const { data } = await sb().from('whatsapp_channels').select('id, provider, label, phone_number, instance_name, base_url, status, is_active, last_inbound_at').eq('tenant_id', tenant.id);
    return (data || []) as Channel[];
  });
  const add = async () => {
    const r = await run(async () => {
      const { data, error } = await sb().rpc('save_channel', { p_tenant: tenant.id, p: { provider: 'evolution', ...f } });
      if (error) throw new Error(error.message);
      return data as { id: string; webhook_token: string };
    }, t('Number added.'));
    if (r) { setToken(x => ({ ...x, [r.id]: r.webhook_token })); setF({ label: '', phone_number: '', instance_name: '', base_url: '', api_key: '' }); refresh(); }
  };
  const showToken = async (id: string) => { const { data } = await sb().rpc('channel_webhook_token', { p_channel: id }); if (data) setToken(x => ({ ...x, [id]: String(data) })); };
  return (
    <div className="space-y-5">
      {(data || []).map(c => (
        <Card key={c.id} title={<span className="inline-flex items-center gap-2"><Smartphone className="size-4 text-positive" aria-hidden /><bdi dir="ltr">{fmtPhone(c.phone_number)}</bdi></span>}
          sub={`${c.label || ''} · Evolution · ${c.instance_name}`} action={<Pill tone={c.status === 'connected' ? 'positive' : 'caution'}>{t(c.status === 'connected' ? 'Connected' : 'Not connected yet')}</Pill>}>
          <p className="text-[13px] text-muted">{t('In Evolution, set this instance’s webhook to your n8n:')}</p>
          {token[c.id] ? (
            <p className="mt-2 flex items-center gap-2 rounded-xl bg-raised px-3 py-2 font-mono text-[12px] ring-1 ring-inset ring-border" dir="ltr">
              <span className="min-w-0 flex-1 truncate">https://YOUR-N8N/webhook/clinic-evo?token={token[c.id]}</span>
              <button onClick={() => { navigator.clipboard?.writeText(`/webhook/clinic-evo?token=${token[c.id]}`); toast(t('Copied.')); }} className="press rounded p-1 text-muted hover:bg-active" aria-label={t('Copy')}><Copy className="size-3.5" /></button>
            </p>
          ) : <Button size="sm" variant="outline" className="mt-2" onClick={() => showToken(c.id)}>{t('Show the webhook address')}</Button>}
          {c.last_inbound_at && <p className="mt-2 text-xs text-faint">{t('Last message in: {d}', { d: dateShort(c.last_inbound_at, tenant.timezone) })}</p>}
        </Card>
      ))}
      <Card title={t('Connect a number')} sub={t('Evolution API for now; the official WhatsApp Cloud API is next. Every message the clinic starts already carries its template name for the switch.')}>
        <form className="grid gap-4 sm:grid-cols-2" onSubmit={e => { e.preventDefault(); add(); }}>
          <Field label={t('Label')}><Input value={f.label} onChange={e => setF({ ...f, label: e.target.value })} placeholder="رقم العيادة" /></Field>
          <Field label={t('WhatsApp number')}><Input dir="ltr" value={f.phone_number} onChange={e => setF({ ...f, phone_number: e.target.value })} placeholder="2010…" /></Field>
          <Field label={t('Evolution instance name')}><Input dir="ltr" value={f.instance_name} onChange={e => setF({ ...f, instance_name: e.target.value })} /></Field>
          <Field label={t('Evolution address')}><Input dir="ltr" value={f.base_url} onChange={e => setF({ ...f, base_url: e.target.value })} placeholder="https://evo.example.com" /></Field>
          <Field label={t('Evolution API key')} hint={t('Stored in the database; the dashboard never shows it again.')} className="sm:col-span-2"><Input dir="ltr" type="password" value={f.api_key} onChange={e => setF({ ...f, api_key: e.target.value })} /></Field>
          <div className="flex justify-end sm:col-span-2"><Button type="submit" busy={busy} disabled={!f.instance_name || !f.base_url}>{t('Connect')}</Button></div>
        </form>
      </Card>
    </div>
  );
}

// ---- Team ----------------------------------------------------------------------------------------
interface Member { user_id: string; role: Role; clinical: boolean; doctor_id: string | null; email: string | null; display_name: string | null; phone: string | null }
const ROLES: Role[] = ['owner', 'manager', 'doctor', 'nurse', 'receptionist'];
const ROLE_HINT: Record<Role, string> = { owner: 'Everything, including the team and WhatsApp', manager: 'Everything but the team', doctor: 'Their patients’ records, prices and their schedule',
  nurse: 'Records and the day', receptionist: 'Bookings, the waiting room and chats — no medical records' };
export function TeamSection() {
  const { tenant, can } = useTenant();
  const { t, lang } = useLang();
  const { doctors } = useClinic();
  const { busy, run } = useAction();
  const [inv, setInv] = useState({ email: '', role: 'receptionist' as Role, doctor: '' });
  const [myPhone, setMyPhone] = useState('');
  const { data, refresh } = useCached<{ m: Member[]; i: { id: string; email: string; role: string; accepted_at: string | null }[] }>(`team:${tenant.id}`, async () => {
    const db = sb();
    const [m, i] = await Promise.all([db.from('tenant_members').select('user_id, role, clinical, doctor_id, email, display_name, phone').eq('tenant_id', tenant.id),
      db.from('tenant_invites').select('id, email, role, accepted_at').eq('tenant_id', tenant.id).is('accepted_at', null)]);
    return { m: (m.data || []) as Member[], i: (i.data || []) as { id: string; email: string; role: string; accepted_at: string | null }[] };
  });
  const call = async (fn: string, args: Record<string, unknown>, said: string) => {
    const r = await run(async () => { const { error } = await sb().rpc(fn, args); if (error) throw new Error(error.message); return true; }, said);
    if (r) refresh();
    return r;
  };
  return (
    <div className="space-y-5">
      <Card pad={false} title={t('Who can sign in')}>
        <ul className="divide-y divide-rule">
          {(data?.m || []).map(m => (
            <li key={m.user_id} className="flex flex-wrap items-center gap-3 px-5 py-3">
              <Avatar name={m.display_name || m.email} size={34} />
              <div className="min-w-0 flex-1">
                <p className="truncate text-[14px] font-medium"><bdi>{m.display_name || m.email}</bdi></p>
                <p className="truncate text-xs text-muted" dir="ltr">{m.email}{m.phone ? ` · ${fmtPhone(m.phone)}` : ''}</p>
              </div>
              {can.owner ? (
                <Select aria-label={t('Role')} value={m.role} onChange={e => call('update_member', { p_tenant: tenant.id, p_user: m.user_id, p: { role: e.target.value, clinical: ['owner', 'doctor', 'nurse'].includes(e.target.value) } }, t('Saved.'))} className="!h-8 !w-36">
                  {ROLES.map(r => <option key={r} value={r}>{t(r)}</option>)}
                </Select>
              ) : <Pill>{t(m.role)}</Pill>}
              {m.clinical && <Pill tone="accent">{t('Sees records')}</Pill>}
              {m.doctor_id && <span className="inline-flex items-center gap-1 text-xs text-muted"><DocDot color={doctors.find(d => d.id === m.doctor_id)?.color} />{docName(doctors.find(d => d.id === m.doctor_id), lang)}</span>}
              {can.owner && m.role !== 'owner' && <button onClick={() => call('remove_member', { p_tenant: tenant.id, p_user: m.user_id }, t('Removed.'))} className="press rounded-lg p-1.5 text-muted hover:bg-raised hover:text-critical" aria-label={t('Remove')}><Trash2 className="size-4" /></button>}
            </li>
          ))}
          {(data?.i || []).map(i => (
            <li key={i.id} className="flex items-center gap-3 px-5 py-3 text-[13.5px] text-muted">
              <span className="flex size-[34px] items-center justify-center rounded-full border border-dashed border-control"><UserPlus className="size-4" aria-hidden /></span>
              <span className="min-w-0 flex-1 truncate" dir="ltr">{i.email}</span><Pill tone="caution">{t('Invited')} · {t(i.role)}</Pill>
            </li>
          ))}
        </ul>
      </Card>
      {can.owner && (
        <Card title={t('Invite someone')} sub={t('They sign up with this e-mail and join the clinic automatically.')}>
          <form className="grid gap-4 sm:grid-cols-[minmax(0,1fr)_180px]" onSubmit={async e => { e.preventDefault();
            const ok = await call('invite_member', { p_tenant: tenant.id, p_email: inv.email, p_role: inv.role, p_clinical: ['owner', 'doctor', 'nurse'].includes(inv.role), p_doctor: inv.doctor || null }, t('Invited.'));
            if (ok) setInv({ email: '', role: 'receptionist', doctor: '' }); }}>
            <Field label={t('E-mail')}><Input dir="ltr" type="email" required value={inv.email} onChange={e => setInv({ ...inv, email: e.target.value })} /></Field>
            <Field label={t('Role')}><Select value={inv.role} onChange={e => setInv({ ...inv, role: e.target.value as Role })}>{ROLES.map(r => <option key={r} value={r}>{t(r)}</option>)}</Select></Field>
            <p className="-mt-2 text-xs text-muted sm:col-span-2">{t(ROLE_HINT[inv.role])}</p>
            {inv.role === 'doctor' && <Field label={t('Which doctor are they')}><Select value={inv.doctor} onChange={e => setInv({ ...inv, doctor: e.target.value })}><option value="">—</option>{doctors.map(d => <option key={d.id} value={d.id}>{docName(d, lang)}</option>)}</Select></Field>}
            <div className="flex items-end justify-end sm:col-span-2"><Button type="submit" busy={busy}>{t('Send the invite')}</Button></div>
          </form>
        </Card>
      )}
      <Card title={t('Your own WhatsApp number')} sub={t('Messages from it reach the assistant as you: “cancel today’s session”, “I’ll be 20 minutes late”.')}>
        <form className="flex flex-wrap gap-2" onSubmit={async e => { e.preventDefault(); await call('set_my_phone', { p_tenant: tenant.id, p_phone: myPhone }, t('Saved.')); }}>
          <Input dir="ltr" inputMode="tel" value={myPhone} onChange={e => setMyPhone(e.target.value)} placeholder="010 0000 0000" className="!w-56" aria-label={t('Your own WhatsApp number')} />
          <Button type="submit" variant="outline" busy={busy}>{t('Save')}</Button>
        </form>
      </Card>
    </div>
  );
}
