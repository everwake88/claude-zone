'use client';
import { Bike } from 'lucide-react';
import { useSearchParams } from 'next/navigation';
import { Suspense, useState } from 'react';
import { Button, Input } from '@/components/ui';
import { LangSwitch, useT } from '@/lib/i18n';

// Drivers sign in with their WhatsApp number only: the restaurant sends a
// link to it, and the link signs this phone in for months.
function Login() {
  const t = useT();
  const link = useSearchParams().get('link');
  const [phone, setPhone] = useState('');
  const [state, setState] = useState<'idle' | 'busy' | 'sent'>('idle');
  const [error, setError] = useState<string | null>(null);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setState('busy'); setError(null);
    const res = await fetch('/api/driver/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ phone }) });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) { setError(data.error || 'Something went wrong'); setState('idle'); return; }
    setState('sent');
  };

  return (
    <div className="flex min-h-screen flex-col items-center justify-center gap-6 bg-paper p-6">
      <div className="w-full max-w-sm rounded-2xl bg-white p-6 shadow-sm">
        <div className="mb-4 flex size-12 items-center justify-center rounded-full bg-gold-wash text-gold-ink"><Bike className="size-6" /></div>
        <h1 className="text-xl font-bold">{t('Driver sign in')}</h1>
        {link && <p className="mt-2 rounded-lg bg-gold-wash p-2 text-sm text-gold-ink">{t('That link was already used or has expired. Get a new one below.')}</p>}
        {state === 'sent'
          ? <p className="mt-3 text-sm">{t('If this number is registered as a driver, a sign-in link is on its way to it on WhatsApp. Open it on this phone.')}</p>
          : <form onSubmit={submit} className="mt-3 space-y-3">
              <p className="text-sm text-muted">{t('Type your WhatsApp number. The restaurant sends you a link — open it and you are in.')}</p>
              <Input dir="ltr" inputMode="tel" autoComplete="tel" placeholder="01xxxxxxxxx" value={phone} onChange={e => setPhone(e.target.value)} />
              {error && <p className="text-sm text-critical">{t(error)}</p>}
              <Button type="submit" variant="gold" className="h-11 w-full" busy={state === 'busy'}>{t('Send me the link')}</Button>
            </form>}
      </div>
      <LangSwitch />
    </div>
  );
}

export default function DriverLogin() {
  return <Suspense><Login /></Suspense>;
}
