import { Bike } from 'lucide-react';
import { serverT } from '@/lib/i18n-server';

// The sign-in link from WhatsApp: /d/<driver id>.<one-time code>. Opening it
// only shows a button — link previews (WhatsApp fetches links to draw them)
// must not use up the one-time code; pressing the button signs the phone in.
export default async function DriverLink({ params }: { params: Promise<{ code: string }> }) {
  const { code } = await params;
  const t = await serverT();
  return (
    <div className="flex min-h-screen items-center justify-center bg-paper p-6">
      <form method="post" action="/api/driver/redeem" className="w-full max-w-sm space-y-4 rounded-2xl bg-white p-6 text-center shadow-sm">
        <div className="mx-auto flex size-14 items-center justify-center rounded-full bg-gold-wash text-gold-ink"><Bike className="size-7" /></div>
        <h1 className="text-xl font-bold">{t('Driver sign in')}</h1>
        <p className="text-sm text-muted">{t('Sign this phone in to see the orders you deliver.')}</p>
        <input type="hidden" name="code" value={code} />
        <button type="submit" className="h-12 w-full rounded-lg bg-gold text-base font-semibold text-navy">{t('Sign in')}</button>
      </form>
    </div>
  );
}
