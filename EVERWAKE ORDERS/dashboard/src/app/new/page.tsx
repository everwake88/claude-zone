'use client';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { Button, Field, Input, Select } from '@/components/ui';
import { sb } from '@/lib/supabase/client';

const COUNTRIES = [
  { code: 'EG', name: 'Egypt', currency: 'EGP', tz: 'Africa/Cairo', lang: 'ar' },
  { code: 'SA', name: 'Saudi Arabia', currency: 'SAR', tz: 'Asia/Riyadh', lang: 'ar' },
  { code: 'AE', name: 'United Arab Emirates', currency: 'AED', tz: 'Asia/Dubai', lang: 'ar' },
  { code: 'QA', name: 'Qatar', currency: 'QAR', tz: 'Asia/Qatar', lang: 'ar' },
  { code: 'KW', name: 'Kuwait', currency: 'KWD', tz: 'Asia/Kuwait', lang: 'ar' },
  { code: 'BH', name: 'Bahrain', currency: 'BHD', tz: 'Asia/Bahrain', lang: 'ar' },
  { code: 'OM', name: 'Oman', currency: 'OMR', tz: 'Asia/Muscat', lang: 'ar' },
  { code: 'JO', name: 'Jordan', currency: 'JOD', tz: 'Asia/Amman', lang: 'ar' }
];

// Signing a restaurant up: one form, then the go-live checklist guides the rest
export default function NewRestaurant() {
  const router = useRouter();
  const [nameAr, setNameAr] = useState('');
  const [nameEn, setNameEn] = useState('');
  const [country, setCountry] = useState('EG');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const c = COUNTRIES.find(x => x.code === country)!;

  const create = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true); setErr('');
    const db = sb();
    const { data, error } = await db.rpc('create_tenant', {
      p_name_ar: nameAr, p_name_en: nameEn, p_slug: null, p_country: c.code,
      p_timezone: c.tz, p_currency: c.currency, p_language: c.lang });
    if (error) { setErr(error.message); setBusy(false); return; }
    const { data: t } = await db.from('tenants').select('slug').eq('id', data as string).single();
    router.replace(`/r/${(t as { slug: string }).slug}`);
    router.refresh();
  };

  return (
    <main className="flex min-h-screen items-center justify-center bg-paper p-4">
      <form onSubmit={create} className="w-full max-w-lg space-y-5 rounded-2xl border border-hairline bg-white p-7 shadow-lg">
        <div>
          <p className="label-caps">Everwake Orders</p>
          <h1 className="mt-1 text-2xl font-semibold">Sign up your restaurant</h1>
          <p className="mt-1 text-sm text-muted">Next you add branches, the menu, delivery zones and the WhatsApp number — a checklist walks you through it, and nothing goes live until you say so.</p>
        </div>
        <Field label="Restaurant name in Arabic"><Input dir="rtl" required value={nameAr} onChange={e => setNameAr(e.target.value)} placeholder="مشويات النيل" /></Field>
        <Field label="Restaurant name in English" hint="Also used for the restaurant's web address in the dashboard.">
          <Input dir="ltr" required value={nameEn} onChange={e => setNameEn(e.target.value)} placeholder="Nile Grill" />
        </Field>
        <Field label="Country" hint={`Prices in ${c.currency}, times in ${c.tz}. Both can be changed later.`}>
          <Select value={country} onChange={e => setCountry(e.target.value)}>
            {COUNTRIES.map(x => <option key={x.code} value={x.code}>{x.name}</option>)}
          </Select>
        </Field>
        {err && <p className="rounded-lg bg-critical-wash px-3 py-2 text-sm text-critical">{err}</p>}
        <Button type="submit" variant="gold" className="w-full" busy={busy}>Create the restaurant</Button>
      </form>
    </main>
  );
}
