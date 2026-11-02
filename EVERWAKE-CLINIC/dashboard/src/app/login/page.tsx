'use client';
import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useState } from 'react';
import { Mark, Wordmark } from '@/components/mark';
import { Button, Field, Input, Segmented } from '@/components/ui';
import { LangSwitch, useT } from '@/lib/i18n';
import { sb } from '@/lib/supabase/client';

function LoginForm() {
  const router = useRouter();
  const t = useT();
  const next = useSearchParams().get('next') || '/';
  const [mode, setMode] = useState<'signin' | 'signup' | 'link'>('signin');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ tone: 'ok' | 'err'; text: string } | null>(null);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true); setMsg(null);
    const db = sb();
    const redirectTo = `${window.location.origin}/auth/callback?next=${encodeURIComponent(next)}`;
    try {
      if (mode === 'signin') {
        const { error } = await db.auth.signInWithPassword({ email, password });
        if (error) throw error;
        router.replace(next);
        router.refresh();
      } else if (mode === 'signup') {
        const { data, error } = await db.auth.signUp({ email, password, options: { emailRedirectTo: redirectTo } });
        if (error) throw error;
        if (data.session) { router.replace('/'); router.refresh(); }
        else setMsg({ tone: 'ok', text: t('Check your e-mail to confirm the account, then sign in.') });
      } else {
        const { error } = await db.auth.signInWithOtp({ email, options: { emailRedirectTo: redirectTo } });
        if (error) throw error;
        setMsg({ tone: 'ok', text: t('A sign-in link is on its way to your inbox.') });
      }
    } catch (err) {
      setMsg({ tone: 'err', text: t(err instanceof Error ? err.message : String(err)) });
    } finally {
      setBusy(false);
    }
  };

  return (
    <main className="relative grid min-h-dvh gap-3 p-3 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.1fr)]">
      {/* the brand, on its navy slab */}
      <section className="relative hidden overflow-hidden rounded-[28px] bg-navy p-10 text-white lg:flex lg:flex-col">
        <Wordmark />
        <div className="my-auto max-w-md">
          <Mark size={120} draw />
          <h1 className="mt-8 text-[30px] font-semibold leading-tight tracking-[-0.015em]">{t('Your clinic’s day, and the assistant that books it')}</h1>
          <p className="mt-3 text-[15px] leading-relaxed text-on-navy-muted">{t('Appointments, patients and their records, and a WhatsApp assistant that answers every patient, day and night.')}</p>
        </div>
        <span aria-hidden className="c-glow pointer-events-none absolute -bottom-40 -end-40 size-[420px] rounded-full bg-gold/15" />
      </section>
      <section className="relative flex items-center justify-center px-2 py-10">
        <LangSwitch className="absolute end-3 top-3" />
        <div className="c-rise w-full max-w-[380px]">
          <div className="mb-6 lg:hidden"><span className="inline-flex rounded-2xl bg-navy px-4 py-3"><Wordmark /></span></div>
          <h2 className="text-[24px] font-semibold tracking-[-0.012em]">{mode === 'signup' ? t('Create account') : t('Sign in')}</h2>
          <p className="mt-1 text-[14px] text-muted">{t('Invited by your clinic? Sign up with the same e-mail and you will be added automatically.')}</p>
          <div className="mt-6">
            <Segmented label="login-mode" value={mode} onChange={(m) => { setMode(m); setMsg(null); }}
              options={[{ value: 'signin', label: t('Sign in') }, { value: 'signup', label: t('Create account') }, { value: 'link', label: t('E-mail link') }]} />
          </div>
          <form onSubmit={submit} className="mt-5 space-y-4">
            <Field label={t('E-mail')}><Input type="email" required value={email} onChange={e => setEmail(e.target.value)} autoComplete="email" dir="ltr" /></Field>
            {mode !== 'link' && (
              <Field label={t('Password')} hint={mode === 'signup' ? t('At least 8 characters.') : undefined}>
                <Input type="password" required minLength={mode === 'signup' ? 8 : undefined} value={password}
                  onChange={e => setPassword(e.target.value)} autoComplete={mode === 'signup' ? 'new-password' : 'current-password'} dir="ltr" />
              </Field>
            )}
            {msg && <p role={msg.tone === 'err' ? 'alert' : 'status'} className={`c-fade rounded-xl px-3 py-2 text-sm ${msg.tone === 'ok' ? 'bg-positive-soft text-positive-ink' : 'bg-critical-soft text-critical-ink'}`}>{msg.text}</p>}
            <Button type="submit" className="w-full" busy={busy}>
              {mode === 'signin' ? t('Sign in') : mode === 'signup' ? t('Create account') : t('Send me a link')}
            </Button>
          </form>
        </div>
      </section>
    </main>
  );
}

export default function LoginPage() {
  return <Suspense><LoginForm /></Suspense>;
}
