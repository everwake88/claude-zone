'use client';
import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useState } from 'react';
import { Mark } from '@/components/mark';
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
    <main className="relative flex min-h-dvh items-center justify-center p-4">
      <LangSwitch className="absolute end-4 top-4" />
      <div className="c-rise w-full max-w-[380px]">
        <div className="mb-5 flex items-center gap-3 px-1">
          <Mark />
          <div>
            <p className="text-[17px] font-semibold leading-tight">Everwake Clinic</p>
            <p className="text-[13px] text-muted">{t('Your clinic’s day, and the assistant that books it')}</p>
          </div>
        </div>
        <div className="sheet p-6">
          <Segmented label="login-mode" value={mode} onChange={(m) => { setMode(m); setMsg(null); }}
            options={[{ value: 'signin', label: t('Sign in') }, { value: 'signup', label: t('Create account') }, { value: 'link', label: t('E-mail link') }]} />
          <form onSubmit={submit} className="mt-5 space-y-4">
            <Field label={t('E-mail')}><Input type="email" required value={email} onChange={e => setEmail(e.target.value)} autoComplete="email" dir="ltr" /></Field>
            {mode !== 'link' && (
              <Field label={t('Password')} hint={mode === 'signup' ? t('At least 8 characters.') : undefined}>
                <Input type="password" required minLength={mode === 'signup' ? 8 : undefined} value={password}
                  onChange={e => setPassword(e.target.value)} autoComplete={mode === 'signup' ? 'new-password' : 'current-password'} dir="ltr" />
              </Field>
            )}
            {msg && <p role={msg.tone === 'err' ? 'alert' : 'status'} className={`c-fade rounded-[7px] px-3 py-2 text-sm ${msg.tone === 'ok' ? 'bg-positive-soft text-positive-ink' : 'bg-critical-soft text-critical-ink'}`}>{msg.text}</p>}
            <Button type="submit" variant="accent" className="w-full" busy={busy}>
              {mode === 'signin' ? t('Sign in') : mode === 'signup' ? t('Create account') : t('Send me a link')}
            </Button>
          </form>
        </div>
        <p className="mt-4 px-1 text-xs leading-relaxed text-muted">{t('Invited by your clinic? Sign up with the same e-mail and you will be added automatically.')}</p>
      </div>
    </main>
  );
}

export default function LoginPage() {
  return <Suspense><LoginForm /></Suspense>;
}
