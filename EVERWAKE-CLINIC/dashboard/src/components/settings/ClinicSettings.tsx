'use client';
import { Check, ImageUp } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { brandVars, logoColour } from '@/lib/brand';
import { cx } from '@/lib/format';
import { useLang } from '@/lib/i18n';
import { sb } from '@/lib/supabase/client';
import { Button, Card, Field, Input, Segmented, Skeleton, Switch, Textarea } from '../ui';
import { useTenant } from '../tenant';
import { useTenantRow } from './useTenantRow';

type Obj = Record<string, unknown>;
const str = (v: unknown) => (v == null ? '' : String(v));

// a save bar that appears when something changed
export function SaveBar({ dirty, busy, onSave, onReset }: { dirty: boolean; busy: boolean; onSave: () => void; onReset: () => void }) {
  const { t } = useLang();
  return (
    <div className={cx('sticky bottom-20 z-20 mt-5 flex justify-end transition-[opacity,transform] duration-200 lg:bottom-4', dirty ? 'opacity-100' : 'pointer-events-none translate-y-2 opacity-0')}>
      <div className="flex items-center gap-2 rounded-2xl bg-ink px-3 py-2 text-[13px] text-white shadow-[0_16px_40px_-16px_rgb(15_23_41/.6)]">
        <span className="px-1">{t('Unsaved changes')}</span>
        <button onClick={onReset} className="press rounded-full px-2.5 py-1 text-white/80 hover:bg-white/10">{t('Discard')}</button>
        <Button size="sm" busy={busy} onClick={onSave}>{t('Save')}</Button>
      </div>
    </div>
  );
}

function useDraft<T>(source: T | undefined) {
  const [d, setD] = useState<T | undefined>(source);
  useEffect(() => { if (source) setD(source); }, [source]);
  const dirty = useMemo(() => JSON.stringify(d) !== JSON.stringify(source), [d, source]);
  return { d, setD, dirty, reset: () => setD(source) };
}

export function ClinicSection() {
  const { t } = useLang();
  const { row, save, busy } = useTenantRow();
  const src = useMemo(() => row && ({ name_ar: row.name_ar, name_en: row.name_en, about_ar: str(row.merged_profile.about_ar), about_en: str(row.merged_profile.about_en),
    insurance: ((row.merged_profile.insurance as string[]) || []).join('، '), phone: str((row.merged_profile.contacts as Obj)?.phone),
    whatsapp: str((row.merged_profile.contacts as Obj)?.whatsapp), email: str((row.merged_profile.contacts as Obj)?.email),
    website: str(row.merged_profile.website), maps: str(row.merged_profile.google_maps_url), review: str(row.merged_profile.google_review_url) }), [row]);
  const { d, setD, dirty, reset } = useDraft(src);
  if (!d) return <Skeleton className="h-96" />;
  const set = (k: keyof typeof d) => (e: { target: { value: string } }) => setD({ ...d, [k]: e.target.value });
  const submit = () => save({ name_ar: d.name_ar, name_en: d.name_en, profile: {
    about_ar: d.about_ar, about_en: d.about_en, insurance: d.insurance.split(/[،,]/).map(x => x.trim()).filter(Boolean),
    contacts: { ...((row!.profile.contacts as Obj) || {}), phone: d.phone, whatsapp: d.whatsapp, email: d.email },
    website: d.website, google_maps_url: d.maps, google_review_url: d.review } });
  return (
    <>
      <div className="space-y-5">
        <Card title={t('The clinic')}>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label={t('Name in Arabic')}><Input dir="rtl" value={d.name_ar} onChange={set('name_ar')} /></Field>
            <Field label={t('Name in English')}><Input dir="ltr" value={d.name_en} onChange={set('name_en')} /></Field>
            <Field label={t('About the clinic, in Arabic')} hint={t('The assistant uses this to introduce the clinic.')} className="sm:col-span-2"><Textarea rows={3} dir="rtl" value={d.about_ar} onChange={set('about_ar')} /></Field>
            <Field label={t('About the clinic, in English')} className="sm:col-span-2"><Textarea rows={2} dir="ltr" value={d.about_en} onChange={set('about_en')} /></Field>
            <Field label={t('Insurance accepted')} hint={t('Separated by commas.')} className="sm:col-span-2"><Input value={d.insurance} onChange={set('insurance')} placeholder="AXA، MetLife" /></Field>
          </div>
        </Card>
        <Card title={t('How patients reach you')}>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label={t('Phone')}><Input dir="ltr" value={d.phone} onChange={set('phone')} /></Field>
            <Field label={t('WhatsApp')}><Input dir="ltr" value={d.whatsapp} onChange={set('whatsapp')} /></Field>
            <Field label={t('E-mail')}><Input dir="ltr" value={d.email} onChange={set('email')} /></Field>
            <Field label={t('Website')}><Input dir="ltr" value={d.website} onChange={set('website')} /></Field>
            <Field label={t('Google Maps link')}><Input dir="ltr" value={d.maps} onChange={set('maps')} /></Field>
            <Field label={t('Google review link')} hint={t('Happy patients are sent here after a visit (stage 3).')}><Input dir="ltr" value={d.review} onChange={set('review')} /></Field>
          </div>
        </Card>
      </div>
      <SaveBar dirty={dirty} busy={busy} onSave={submit} onReset={reset} />
    </>
  );
}

export function AgentSection() {
  const { t } = useLang();
  const { row, save, busy } = useTenantRow();
  const src = useMemo(() => {
    if (!row) return undefined;
    const p = row.merged_profile, s = row.merged_settings;
    return { name_ar: str((p.agent_name as Obj)?.ar), name_en: str((p.agent_name as Obj)?.en), gender: str(p.agent_gender) || 'female', tone: str(p.tone),
      em_ar: str(p.emergency_text_ar), em_en: str(p.emergency_text_en), ambulance: str((s.emergency as Obj)?.ambulance),
      wa_doctor: Boolean((s.emergency as Obj)?.whatsapp_doctor), aftercare: Boolean(s.aftercare_messages), release: str(s.human_auto_release_minutes),
      test: ((s.test_numbers as string[]) || []).join('، ') };
  }, [row]);
  const { d, setD, dirty, reset } = useDraft(src);
  if (!d) return <Skeleton className="h-96" />;
  const set = (k: keyof typeof d) => (e: { target: { value: string } }) => setD({ ...d, [k]: e.target.value });
  const submit = () => save({
    profile: { agent_name: { ar: d.name_ar, en: d.name_en }, agent_gender: d.gender, tone: d.tone, emergency_text_ar: d.em_ar, emergency_text_en: d.em_en },
    settings: { emergency: { whatsapp_doctor: d.wa_doctor, ambulance: d.ambulance }, aftercare_messages: d.aftercare,
                human_auto_release_minutes: Number(d.release) || 30, test_numbers: d.test.split(/[،,\s]+/).map(x => x.replace(/\D/g, '')).filter(Boolean) } });
  return (
    <>
      <div className="space-y-5">
        <Card title={t('Who answers')} sub={t('The assistant introduces itself by this name and speaks as one person.')}>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label={t('Name in Arabic')}><Input dir="rtl" value={d.name_ar} onChange={set('name_ar')} /></Field>
            <Field label={t('Name in English')}><Input dir="ltr" value={d.name_en} onChange={set('name_en')} /></Field>
            <Field label={t('Speaks as')}>
              <Segmented label="agent-gender" value={d.gender as 'female' | 'male'} onChange={v => setD({ ...d, gender: v })} options={[{ value: 'female', label: t('A woman') }, { value: 'male', label: t('A man') }]} />
            </Field>
            <Field label={t('Tone (optional)')} hint={t('For example: warm and brief, formal, cheerful with children’s parents.')}><Input value={d.tone} onChange={set('tone')} /></Field>
          </div>
        </Card>
        <Card title={t('In an emergency')} sub={t('When a message sounds like an emergency the assistant says this first, raises the red banner here, and messages the doctor.')}>
          <div className="grid gap-4">
            <Field label={t('What it tells the patient, in Arabic')}><Textarea rows={2} dir="rtl" value={d.em_ar} onChange={set('em_ar')} /></Field>
            <Field label={t('…and in English')}><Textarea rows={2} dir="ltr" value={d.em_en} onChange={set('em_en')} /></Field>
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label={t('Ambulance number')}><Input dir="ltr" value={d.ambulance} onChange={set('ambulance')} /></Field>
              <label className="flex items-center justify-between gap-3 self-end rounded-xl px-3 py-2 text-[13.5px] ring-1 ring-inset ring-border">
                {t('Message the doctor’s own WhatsApp')}<Switch checked={d.wa_doctor} onChange={v => setD({ ...d, wa_doctor: v })} label={t('Message the doctor’s own WhatsApp')} />
              </label>
            </div>
          </div>
        </Card>
        <Card title={t('Everything else')}>
          <div className="grid gap-4 sm:grid-cols-2">
            <label className="flex items-center justify-between gap-3 rounded-xl px-3 py-2 text-[13.5px] ring-1 ring-inset ring-border sm:col-span-2">
              {t('Send aftercare instructions when a visit is marked done')}<Switch checked={d.aftercare} onChange={v => setD({ ...d, aftercare: v })} label={t('Aftercare')} />
            </label>
            <Field label={t('Give a taken-over chat back after (minutes of silence)')}><Input inputMode="numeric" value={d.release} onChange={set('release')} /></Field>
            <Field label={t('Test numbers')} hint={t('Before going live, only these numbers reach the assistant.')}><Input dir="ltr" value={d.test} onChange={set('test')} placeholder="2010…" /></Field>
          </div>
        </Card>
      </div>
      <SaveBar dirty={dirty} busy={busy} onSave={submit} onReset={reset} />
    </>
  );
}

export function BookingSection() {
  const { t } = useLang();
  const { row, save, busy } = useTenantRow();
  const src = useMemo(() => {
    if (!row) return undefined;
    const b = (row.merged_settings.booking || {}) as Obj, dl = (row.merged_settings.delay || {}) as Obj;
    return { lead: str(b.lead_minutes), ahead: str(b.days_ahead), hold: str(b.hold_minutes), queue: str(b.queue_minutes), cancel: str(b.cancel_hours),
      no_show: Boolean(row.merged_settings.auto_no_show), grace: str(row.merged_settings.no_show_grace_minutes),
      share: String(Math.round(Number(dl.reply_share || 0.4) * 100)), rmin: str(dl.reply_min_minutes), rmax: str(dl.reply_max_minutes), before: str(dl.before_start_minutes) };
  }, [row]);
  const { d, setD, dirty, reset } = useDraft(src);
  if (!d) return <Skeleton className="h-96" />;
  const n = (k: keyof typeof d) => ({ inputMode: 'numeric' as const, value: String(d[k]), onChange: (e: { target: { value: string } }) => setD({ ...d, [k]: e.target.value.replace(/\D/g, '') }) });
  const submit = () => save({ settings: {
    booking: { ...((row!.settings.booking as Obj) || {}), lead_minutes: Number(d.lead), days_ahead: Number(d.ahead), hold_minutes: Number(d.hold), queue_minutes: Number(d.queue), cancel_hours: Number(d.cancel) },
    auto_no_show: d.no_show, no_show_grace_minutes: Number(d.grace),
    delay: { reply_share: Number(d.share) / 100, reply_min_minutes: Number(d.rmin), reply_max_minutes: Number(d.rmax), before_start_minutes: Number(d.before) } } });
  return (
    <>
      <div className="space-y-5">
        <Card title={t('Booking on WhatsApp')}>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label={t('Soonest a patient can book (minutes from now)')}><Input {...n('lead')} /></Field>
            <Field label={t('How far ahead (days)')}><Input {...n('ahead')} /></Field>
            <Field label={t('Hold a chosen time while the patient confirms (minutes)')}><Input {...n('hold')} /></Field>
            <Field label={t('Average visit, for queue estimates (minutes)')}><Input {...n('queue')} /></Field>
            <Field label={t('Cancel up to (hours before; 0 = any time)')}><Input {...n('cancel')} /></Field>
          </div>
        </Card>
        <Card title={t('Did not come')}>
          <div className="grid gap-4 sm:grid-cols-2">
            <label className="flex items-center justify-between gap-3 rounded-xl px-3 py-2 text-[13.5px] ring-1 ring-inset ring-border">
              {t('Mark “did not come” on its own')}<Switch checked={d.no_show} onChange={v => setD({ ...d, no_show: v })} label={t('Mark “did not come” on its own')} />
            </label>
            <Field label={t('After (minutes past the time)')}><Input {...n('grace')} /></Field>
          </div>
        </Card>
        <Card title={t('When the doctor is late')} sub={t('A patient who has not answered the delay message gets one more, sooner when their time is close.')}>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label={t('Wait this share of the time left (%)')}><Input {...n('share')} /></Field>
            <Field label={t('…but at least (minutes)')}><Input {...n('rmin')} /></Field>
            <Field label={t('…and at most (minutes)')}><Input {...n('rmax')} /></Field>
            <Field label={t('Never later than (minutes before their time)')}><Input {...n('before')} /></Field>
          </div>
          <p className="mt-3 text-xs text-muted">{t('Example: 2 hours before their time, the follow-up goes {m} minutes after the notice.', { m: Math.round(Math.min(Math.max(120 * Number(d.share) / 100, Number(d.rmin)), Number(d.rmax))) })}</p>
        </Card>
      </div>
      <SaveBar dirty={dirty} busy={busy} onSave={submit} onReset={reset} />
    </>
  );
}

// Listening to the visit: how long the audio is kept (the words stay with the note)
export function ScribeSection() {
  const { t } = useLang();
  const { row, save, busy } = useTenantRow();
  const src = useMemo(() => row ? { days: str(((row.merged_settings.scribe || {}) as Obj).audio_days ?? 30) } : undefined, [row]);
  const { d, setD, dirty, reset } = useDraft(src);
  if (!d) return <Skeleton className="h-48" />;
  const days = Math.min(365, Math.max(1, Number(d.days) || 30));
  const submit = () => save({ settings: { scribe: { ...((row!.settings.scribe as Obj) || {}), audio_days: days } } });
  return (
    <>
      <Card title={t('The audio')} sub={t('The patient agrees every time, and only doctors and nurses can listen.')}>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label={t('Keep the audio (days)')} hint={t('Then it is deleted. The transcript and the signed note stay.')}>
            <Input inputMode="numeric" value={d.days} onChange={e => setD({ ...d, days: e.target.value.replace(/\D/g, '').slice(0, 3) })} />
          </Field>
        </div>
      </Card>
      <SaveBar dirty={dirty} busy={busy} onSave={submit} onReset={reset} />
    </>
  );
}

const TEMPLATES: { key: string; label: string; vars: string }[] = [
  { key: 'booking_confirmed', label: 'Booking confirmed', vars: '{name} {for} {when} {doctor} {location} {ref_no} {prep} {link}' },
  { key: 'reminder_day_before', label: 'Reminder the day before', vars: '{name} {for} {when} {doctor} {location} {link}' },
  { key: 'reminder_hours_before', label: 'Reminder hours before', vars: '{name} {for} {when} {doctor} {location} {link}' },
  { key: 'delay_notice', label: 'The doctor is late', vars: '{name} {doctor} {minutes} {for} {new_time} {old_time}' },
  { key: 'delay_followup', label: 'No answer to the delay', vars: '{name} {new_time}' },
  { key: 'session_cancelled', label: 'Session cancelled', vars: '{name} {doctor} {when} {reason} {for} {options}' },
  { key: 'booking_moved', label: 'Booking moved by the clinic', vars: '{name} {for} {doctor} {when}' },
  { key: 'booking_cancelled_by_clinic', label: 'Booking cancelled by the clinic', vars: '{name} {for} {when} {doctor} {reason}' },
  { key: 'waitlist_offer', label: 'An earlier time for the waitlist', vars: '{name} {doctor} {when} {for}' },
  { key: 'aftercare', label: 'After the visit', vars: '{for} {service} {aftercare}' },
  { key: 'pause_apology', label: 'Assistant paused', vars: '{name}' },
  { key: 'resume_notice', label: 'Assistant back', vars: '{name}' }
];

export function MessagesSection() {
  const { t } = useLang();
  const { row, save, busy } = useTenantRow();
  const [lang2, setLang2] = useState<'ar' | 'en'>('ar');
  const src = useMemo(() => {
    if (!row) return undefined;
    const rem = (row.merged_settings.reminders as Obj[]) || [];
    return { day_at: str(rem.find(r => r.kind === 'day_before')?.at) || '19:00', hours: str(rem.find(r => r.kind === 'hours_before')?.hours) || '3',
      day_on: rem.some(r => r.kind === 'day_before'), hours_on: rem.some(r => r.kind === 'hours_before'),
      templates: { ...((row.merged_settings.templates as Record<string, string>) || {}) } };
  }, [row]);
  const { d, setD, dirty, reset } = useDraft(src);
  if (!d || !row) return <Skeleton className="h-96" />;
  const defaults = (row.merged_settings.templates as Record<string, string>) || {};
  const submit = () => {
    const changed = Object.fromEntries(Object.entries(d.templates).filter(([k, v]) => v !== defaults[k] || (row.settings.templates as Obj)?.[k] !== undefined));
    return save({ settings: {
      reminders: [d.day_on && { key: 'day_before', kind: 'day_before', at: d.day_at }, d.hours_on && { key: 'hours_before', kind: 'hours_before', hours: Number(d.hours) || 3 }].filter(Boolean),
      templates: { ...((row.settings.templates as Obj) || {}), ...changed } } });
  };
  return (
    <>
      <div className="space-y-5">
        <Card title={t('Reminders')} sub={t('Each reminder lets the patient confirm, change or cancel, by a number or in their own words.')}>
          <div className="space-y-3">
            <div className="flex flex-wrap items-center gap-3 rounded-xl px-3 py-2.5 ring-1 ring-inset ring-border">
              <Switch checked={d.day_on} onChange={v => setD({ ...d, day_on: v })} label={t('The day before')} />
              <span className="text-[13.5px]">{t('The day before, at')}</span>
              <Input type="time" value={d.day_at} onChange={e => setD({ ...d, day_at: e.target.value })} className="!w-32" disabled={!d.day_on} />
            </div>
            <div className="flex flex-wrap items-center gap-3 rounded-xl px-3 py-2.5 ring-1 ring-inset ring-border">
              <Switch checked={d.hours_on} onChange={v => setD({ ...d, hours_on: v })} label={t('Hours before')} />
              <Input inputMode="numeric" value={d.hours} onChange={e => setD({ ...d, hours: e.target.value.replace(/\D/g, '') })} className="!w-16" disabled={!d.hours_on} />
              <span className="text-[13.5px]">{t('hours before the visit')}</span>
            </div>
          </div>
        </Card>
        <Card title={t('What the messages say')} sub={t('Words in {braces} are filled in for each patient.')}
          action={<Segmented label="tpl-lang" size="sm" value={lang2} onChange={setLang2} options={[{ value: 'ar', label: 'العربية' }, { value: 'en', label: 'English' }]} />}>
          <div className="space-y-4">
            {TEMPLATES.map(tp => {
              const k = `${tp.key}_${lang2}`;
              return (
                <Field key={k} label={t(tp.label)} hint={<span dir="ltr" className="font-mono text-[11px]">{tp.vars}</span>}>
                  <Textarea rows={3} dir={lang2 === 'ar' ? 'rtl' : 'ltr'} value={d.templates[k] || ''} onChange={e => setD({ ...d, templates: { ...d.templates, [k]: e.target.value } })} />
                </Field>
              );
            })}
          </div>
        </Card>
      </div>
      <SaveBar dirty={dirty} busy={busy} onSave={submit} onReset={reset} />
    </>
  );
}

const SWATCHES = ['#2347b5', '#2f7d6d', '#0e7490', '#7c3aed', '#be185d', '#b45309', '#0f766e', '#334155'];
export function BrandSection() {
  const { t } = useLang();
  const { tenant, brand, setBrand } = useTenant();
  const { row, save, busy } = useTenantRow();
  const [color, setColor] = useState(brand.color || '');
  const [logo, setLogo] = useState(brand.logo_url || '');
  const [suggest, setSuggest] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  useEffect(() => { setColor(brand.color || ''); setLogo(brand.logo_url || ''); }, [brand]);
  const vars = brandVars(color || '#2347b5');
  const upload = async (f: File) => {
    setUploading(true);
    const path = `${tenant.id}/logo-${Date.now()}.${(f.name.split('.').pop() || 'png').toLowerCase()}`;
    const { error } = await sb().storage.from('clinic-media').upload(path, f, { upsert: true, contentType: f.type });
    setUploading(false);
    if (error) return;
    const url = sb().storage.from('clinic-media').getPublicUrl(path).data.publicUrl;
    setLogo(url);
    setSuggest(await logoColour(url));
  };
  const submit = async () => {
    const b = { ...((row?.profile.brand as Obj) || {}), color: color || null, logo_url: logo || null };
    const r = await save({ profile: { brand: b } });
    if (r) setBrand({ color: color || undefined, logo_url: logo || undefined });
  };
  if (!row) return <Skeleton className="h-80" />;
  return (
    <>
      <div className="grid items-start gap-5 lg:grid-cols-[minmax(0,1fr)_320px]">
        <Card title={t('Logo and colour')} sub={t('The dashboard takes the clinic’s colour, darkened where needed so text stays readable.')}>
          <div className="space-y-5">
            <label className="flex cursor-pointer items-center gap-4">
              <span className="flex size-16 items-center justify-center overflow-hidden rounded-[20px] bg-raised ring-1 ring-inset ring-border">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                {logo ? <img src={logo} alt="" className="size-full object-contain p-1" /> : <ImageUp className="size-6 text-faint" aria-hidden />}
              </span>
              <span className="text-[13.5px]"><span className="font-medium text-gold-ink">{uploading ? t('Uploading…') : t('Upload the logo')}</span><span className="block text-xs text-muted">{t('PNG or SVG, square works best')}</span></span>
              <input type="file" accept="image/*" className="hidden" onChange={e => e.target.files?.[0] && upload(e.target.files[0])} />
            </label>
            <div className="flex flex-wrap items-center gap-2">
              {[...(suggest ? [suggest] : []), ...SWATCHES].map(c => (
                <button key={c} type="button" onClick={() => setColor(c)} aria-label={c} aria-pressed={color === c}
                  className={cx('press relative size-9 rounded-full ring-2 ring-offset-2 ring-offset-sheet', color === c ? 'ring-ink' : 'ring-transparent')} style={{ background: c }}>
                  {color === c && <Check className="absolute inset-0 m-auto size-4 text-white" aria-hidden />}
                </button>
              ))}
              <Input dir="ltr" value={color} onChange={e => setColor(e.target.value)} placeholder="#2347b5" className="!w-28 font-mono" aria-label={t('Colour')} />
            </div>
            {suggest && <p className="text-xs text-muted">{t('The first colour comes from your logo.')}</p>}
          </div>
        </Card>
        <Card title={t('Preview')}>
          <div className="space-y-3" style={vars ? Object.fromEntries(Object.entries(vars)) as React.CSSProperties : undefined}>
            <span className="inline-flex h-9 items-center rounded-full px-3.5 text-sm font-medium text-white" style={{ background: 'var(--brand)' }}>{t('New booking')}</span>
            <div className="rounded-xl px-3 py-2 text-[13px]" style={{ background: 'var(--brand-soft)', color: 'var(--brand-ink)' }}>{t('Next visit')} · 6:30 pm</div>
            <div className="h-2 overflow-hidden rounded-full bg-rule"><span className="block h-full w-2/3 rounded-full" style={{ background: 'var(--brand)' }} /></div>
          </div>
        </Card>
      </div>
      <SaveBar dirty={color !== (brand.color || '') || logo !== (brand.logo_url || '')} busy={busy} onSave={submit} onReset={() => { setColor(brand.color || ''); setLogo(brand.logo_url || ''); }} />
    </>
  );
}
