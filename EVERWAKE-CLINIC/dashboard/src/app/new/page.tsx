'use client';
import { Check } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useEffect, useMemo, useState } from 'react';
import { Mark } from '@/components/mark';
import { Button, Field, Input, Segmented } from '@/components/ui';
import { cx } from '@/lib/format';
import { LangSwitch, useLang } from '@/lib/i18n';
import { sb } from '@/lib/supabase/client';

interface Preset { code: string; name_ar: string; name_en: string; group_name: string; sort: number }

// Signing a clinic up: its name, its speciality (which fills the services, the visit form and
// the red-flag words), and whether the person signing up is its doctor. Then the go-live
// checklist on Today walks through the rest; nothing reaches patients until they say so.
export default function NewClinic() {
  const router = useRouter();
  const { t, lang } = useLang();
  const [presets, setPresets] = useState<Preset[]>([]);
  const [nameAr, setNameAr] = useState('');
  const [nameEn, setNameEn] = useState('');
  const [spec, setSpec] = useState('dentistry');
  const [me, setMe] = useState<'doctor' | 'staff'>('doctor');
  const [doctor, setDoctor] = useState('');
  const [gender, setGender] = useState<'male' | 'female'>('male');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  useEffect(() => {
    sb().from('specialty_presets').select('code, name_ar, name_en, group_name, sort').order('sort')
      .then(({ data }) => setPresets((data || []) as Preset[]));
  }, []);
  const [dental, other] = useMemo(() => [presets.filter(p => p.group_name === 'dental'), presets.filter(p => p.group_name !== 'dental')], [presets]);

  const create = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true); setErr('');
    const db = sb();
    const { data, error } = await db.rpc('create_tenant', {
      p_name_ar: nameAr, p_name_en: nameEn, p_slug: null, p_specialty: spec,
      p_doctor_name: me === 'doctor' ? doctor : null, p_doctor_gender: me === 'doctor' ? gender : null });
    if (error) { setErr(t(error.message)); setBusy(false); return; }
    const { data: row } = await db.from('tenants').select('slug').eq('id', data as string).single();
    router.replace(`/c/${(row as { slug: string }).slug}`);
    router.refresh();
  };

  const chip = (p: Preset) => {
    const on = spec === p.code;
    return (
      <button key={p.code} type="button" onClick={() => setSpec(p.code)} aria-pressed={on}
        className={cx('press flex min-h-10 items-center justify-between gap-2 rounded-[8px] border px-3 py-2 text-start text-[13px]',
          on ? 'border-accent bg-accent-soft font-medium text-accent-ink' : 'border-border bg-sheet text-ink hover:border-control hover:bg-raised')}>
        <span className="min-w-0 leading-snug">{lang === 'ar' ? p.name_ar : p.name_en}</span>
        {on && <Check className="c-pop size-4 shrink-0" aria-hidden />}
      </button>
    );
  };

  return (
    <main className="relative min-h-dvh px-4 py-10">
      <LangSwitch className="absolute end-4 top-4" />
      <form onSubmit={create} className="c-rise mx-auto w-full max-w-2xl">
        <div className="mb-5 flex items-center gap-3 px-1">
          <Mark />
          <div>
            <h1 className="text-[20px] font-semibold leading-tight">{t('Sign up your clinic')}</h1>
            <p className="text-[13px] text-muted">{t('A checklist walks you through the rest. Nothing reaches patients until you say so.')}</p>
          </div>
        </div>
        <div className="sheet space-y-6 p-6">
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label={t('Clinic name in Arabic')}><Input dir="rtl" required value={nameAr} onChange={e => setNameAr(e.target.value)} placeholder="عيادات النيل" /></Field>
            <Field label={t('Clinic name in English')} hint={t('Also used for the clinic’s web address.')}>
              <Input dir="ltr" value={nameEn} onChange={e => setNameEn(e.target.value)} placeholder="Nile Clinics" />
            </Field>
          </div>

          <fieldset>
            <legend className="text-[13px] font-medium">{t('The speciality')}</legend>
            <p className="mt-0.5 text-xs text-muted">{t('It fills in the services, the visit form and the warning signs the assistant listens for. A polyclinic adds the other doctors later.')}</p>
            {presets.length === 0
              ? <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-3">{Array.from({ length: 9 }).map((_, i) => <span key={i} className="skeleton h-10" />)}</div>
              : <>
                  <div className="mt-3 grid grid-cols-1 gap-2 sm:grid-cols-3">{dental.map(chip)}</div>
                  <div className="mt-2 grid grid-cols-2 gap-2 sm:grid-cols-3">{other.map(chip)}</div>
                </>}
          </fieldset>

          <div className="space-y-3 border-t border-rule pt-5">
            <Segmented label="who" value={me} onChange={setMe}
              options={[{ value: 'doctor', label: t('I am the doctor') }, { value: 'staff', label: t('I run the clinic') }]} />
            {me === 'doctor' && (
              <div className="c-fade grid gap-4 sm:grid-cols-[1fr_auto]">
                <Field label={t('Your name as patients know it')}><Input dir="auto" required value={doctor} onChange={e => setDoctor(e.target.value)} placeholder="د. منى عادل" /></Field>
                <Field label={t('Patients call you')}>
                  <Segmented label="gender" value={gender} onChange={setGender}
                    options={[{ value: 'male', label: t('دكتور') }, { value: 'female', label: t('دكتورة') }]} />
                </Field>
              </div>
            )}
          </div>

          {err && <p role="alert" className="rounded-[7px] bg-critical-soft px-3 py-2 text-sm text-critical-ink">{err}</p>}
          <div className="flex justify-end">
            <Button type="submit" variant="accent" busy={busy}>{t('Create the clinic')}</Button>
          </div>
        </div>
      </form>
    </main>
  );
}
