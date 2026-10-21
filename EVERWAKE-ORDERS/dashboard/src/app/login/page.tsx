'use client';
import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useState } from 'react';
import { Button, Field, Input, Tabs } from '@/components/ui';
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
    <main className="relative flex min-h-screen items-center justify-center bg-navy p-4">
      <LangSwitch className="absolute end-4 top-4" />
      <div className="w-full max-w-sm rounded-2xl bg-white p-7 shadow-2xl">
        <div className="mb-6 flex items-center gap-3">
          <span className="flex size-10 items-center justify-center rounded-xl bg-navy text-lg font-bold text-gold">E</span>
          <div>
            <p className="text-lg font-semibold leading-tight">Everwake Orders</p>
            <p className="text-sm text-muted">{t('WhatsApp ordering for your restaurant')}</p>
          </div>
        </div>
        <Tabs value={mode} onChange={(m) => { setMode(m); setMsg(null); }}
          tabs={[{ value: 'signin', label: t('Sign in') }, { value: 'signup', label: t('Create account') }, { value: 'link', label: t('E-mail link') }]} />
        <form onSubmit={submit} className="mt-5 space-y-4">
          <Field label={t('E-mail')}><Input type="email" required value={email} onChange={e => setEmail(e.target.value)} autoComplete="email" dir="ltr" /></Field>
          {mode !== 'link' && (
            <Field label={t('Password')} hint={mode === 'signup' ? t('At least 8 characters.') : undefined}>
              <Input type="password" required minLength={mode === 'signup' ? 8 : undefined} value={password}
                onChange={e => setPassword(e.target.value)} autoComplete={mode === 'signup' ? 'new-password' : 'current-password'} dir="ltr" />
            </Field>
          )}
          {msg && <p className={`rounded-lg px-3 py-2 text-sm ${msg.tone === 'ok' ? 'bg-positive-wash text-positive' : 'bg-critical-wash text-critical'}`}>{msg.text}</p>}
          <Button type="submit" variant="gold" className="w-full" busy={busy}>
            {mode === 'signin' ? t('Sign in') : mode === 'signup' ? t('Create account') : t('Send me a link')}
          </Button>
        </form>
        <p className="mt-5 text-xs text-muted">{t('Invited by your restaurant? Sign up with the same e-mail and you will be added automatically.')}</p>
      </div>
    </main>
  );
}

export default function LoginPage() {
  return <Suspense><LoginForm /></Suspense>;
}
