'use client';
import { CreditCard, ExternalLink, ShieldCheck } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { Badge, Button, Card, Field, Input, Spinner, Switch, useAction, useToast } from '@/components/ui';
import { useTenant } from '@/components/tenant';
import { timeAgo } from '@/lib/format';
import { useT } from '@/lib/i18n';
import { sb } from '@/lib/supabase/client';
import type { PaymentAccountView } from '@/lib/types';

interface Form {
  enabled: boolean; public_key: string; secret_key: string; hmac_secret: string; card_integration_id: string;
  wallet_integration_id: string; other_integration_ids: string; link_minutes: string; reminder_minutes: string; billing_email: string;
}

// The restaurant's own Paymob account: customers who choose "online" get a
// payment link, the money goes to the restaurant's bank, and the order shows
// Paid when Paymob confirms it.
export default function PaymentSettings() {
  const { tenant, can } = useTenant();
  const t = useT();
  const toast = useToast();
  const { busy, run } = useAction();
  const [view, setView] = useState<PaymentAccountView | null>(null);
  const [f, setF] = useState<Form | null>(null);
  const [origin, setOrigin] = useState('');
  useEffect(() => setOrigin(process.env.NEXT_PUBLIC_SITE_URL || window.location.origin), []);

  const load = useCallback(async () => {
    const { data, error } = await sb().rpc('payment_account_view', { p_tenant: tenant.id });
    if (error) { setView({ connected: false }); return; }
    const v = data as PaymentAccountView;
    setView(v);
    setF({
      enabled: !!v.connected, public_key: v.public_key || '', secret_key: '', hmac_secret: '',
      card_integration_id: v.card_integration_id ? String(v.card_integration_id) : '',
      wallet_integration_id: v.wallet_integration_id ? String(v.wallet_integration_id) : '',
      other_integration_ids: (v.other_integration_ids || []).join(', '), link_minutes: String(v.link_minutes ?? 60),
      reminder_minutes: String(v.reminder_minutes ?? 15), billing_email: v.billing_email || ''
    });
  }, [tenant.id]);
  useEffect(() => { if (can.edit) load(); }, [load, can.edit]);

  if (!can.edit) return <Card><p className="text-sm text-muted">{t('Only owners and managers can see the payment settings.')}</p></Card>;
  if (!view || !f) return <Spinner />;
  const set = (k: keyof Form, v: string | boolean) => setF({ ...f, [k]: v });

  const save = (enabled = f.enabled) => run(async () => {
    const { data, error } = await sb().rpc('save_payment_account', { p_tenant: tenant.id, p: {
      ...f, enabled, other_integration_ids: f.other_integration_ids.split(/[\s,،]+/).filter(Boolean),
      link_minutes: Number(f.link_minutes) || 60, reminder_minutes: Number(f.reminder_minutes) || 0, dashboard_url: origin } });
    if (error) throw new Error(error.message);
    setView(data as PaymentAccountView);
    setF({ ...f, enabled, secret_key: '', hmac_secret: '' });
  }, enabled ? t('Saved — customers can now pay online') : t('Saved'));

  const testLink = () => run(async () => {
    const res = await fetch('/api/pay/link', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ test: true, tenant_id: tenant.id }) });
    const r = await res.json() as { ok: boolean; link?: string; error?: string; status?: string; fact?: string };
    if (!r.ok || !r.link) throw new Error(r.error || r.fact || r.status || t('Paymob did not make the link'));
    window.open(r.link, '_blank', 'noopener');
    toast(t('The test link opened in a new tab. Pay with a test card, then come back: “Paymob last reached us” shows the notice arrived.'), 'neutral');
    setTimeout(load, 20000);
  });

  const secretPh = (has?: boolean, hint?: string | null) => has ? t('Saved {hint} — type a new one to replace it', { hint: hint || '' }) : '';

  return (
    <div className="grid gap-4 xl:grid-cols-[1fr_380px]">
      <Card title={<span className="flex items-center gap-2"><CreditCard className="size-4 text-gold-ink" /> {t('Paymob')}
        {view.connected && <Badge tone={view.is_live ? 'positive' : 'caution'}>{view.is_live ? t('Live') : t('Test mode')}</Badge>}</span>}>
        <div className="space-y-4">
          <label className="flex items-center justify-between gap-3 rounded-xl bg-paper p-3">
            <span>
              <span className="block text-sm font-medium">{t('Customers can pay online')}</span>
              <span className="block text-xs text-muted">{t('The agent offers “online by card or wallet” and sends a payment link after placing the order.')}</span>
            </span>
            <Switch checked={f.enabled} disabled={busy} onChange={v => save(v)} />
          </label>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label={t('Public key')} className="sm:col-span-2"><Input dir="ltr" value={f.public_key} onChange={e => set('public_key', e.target.value)} placeholder="egy_pk_live_…" /></Field>
            <Field label={t('Secret key')}><Input dir="ltr" type="password" autoComplete="off" value={f.secret_key} onChange={e => set('secret_key', e.target.value)} placeholder={secretPh(view.has_secret_key, view.secret_hint) || 'egy_sk_live_…'} /></Field>
            <Field label={t('HMAC secret')}><Input dir="ltr" type="password" autoComplete="off" value={f.hmac_secret} onChange={e => set('hmac_secret', e.target.value)} placeholder={secretPh(view.has_hmac_secret)} /></Field>
            <Field label={t('Card integration ID')}><Input dir="ltr" inputMode="numeric" value={f.card_integration_id} onChange={e => set('card_integration_id', e.target.value)} /></Field>
            <Field label={t('Mobile wallet integration ID')} hint={t('Optional — Vodafone Cash and other wallets.')}><Input dir="ltr" inputMode="numeric" value={f.wallet_integration_id} onChange={e => set('wallet_integration_id', e.target.value)} /></Field>
            <Field label={t('Other integration IDs')} hint={t('Optional — e.g. ValU or Apple Pay, comma separated.')} className="sm:col-span-2"><Input dir="ltr" value={f.other_integration_ids} onChange={e => set('other_integration_ids', e.target.value)} /></Field>
            <Field label={t('A payment link works for (minutes)')}><Input type="number" min={10} value={f.link_minutes} onChange={e => set('link_minutes', e.target.value)} /></Field>
            <Field label={t('Remind the customer after (minutes)')} hint={t('One reminder if they have not paid. 0 = none.')}><Input type="number" min={0} value={f.reminder_minutes} onChange={e => set('reminder_minutes', e.target.value)} /></Field>
            <Field label={t('E-mail for Paymob receipts')} hint={t('Paymob asks for an e-mail with each payment; customers on WhatsApp rarely give one. Optional.')} className="sm:col-span-2">
              <Input dir="ltr" type="email" value={f.billing_email} onChange={e => set('billing_email', e.target.value)} placeholder="payments@restaurant.com" />
            </Field>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Button variant="gold" busy={busy} onClick={() => save()}>{t('Save')}</Button>
            {view.connected && <Button variant="outline" disabled={busy} onClick={testLink}><ExternalLink className="size-4" /> {t('Make a 10 EGP test link')}</Button>}
          </div>
          {view.last_error && <p className="rounded-lg bg-paper p-3 text-sm text-critical" dir="ltr">{t('Last problem')}: {view.last_error}</p>}
          <p className="flex items-center gap-1.5 text-xs text-muted"><ShieldCheck className="size-4" />
            {view.last_callback_at ? t('Paymob last reached us {ago}.', { ago: timeAgo(view.last_callback_at) }) : t('Paymob has not reported a payment yet.')}</p>
        </div>
      </Card>

      <Card title={t('Where to find these in Paymob')}>
        <ol className="list-decimal space-y-2 ps-5 text-sm text-muted">
          <li>{t('Open an account at paymob.com (commercial register, tax card and a bank account). There is no monthly fee; Paymob takes a fee from each payment.')}</li>
          <li>{t('Dashboard → Developers → API keys: the public key and the secret key. Test keys work first; switch to the live keys when Paymob activates the account.')}</li>
          <li>{t('Dashboard → Settings → Account info: the HMAC secret. It proves each payment notice really comes from Paymob.')}</li>
          <li>{t('Dashboard → Developers → Payment integrations: the ID of the card integration (and the wallet one). Test keys need test integration IDs.')}</li>
          <li>{t('Nothing to paste back into Paymob: every link tells Paymob where to report the payment:')}{' '}
            <bdi dir="ltr" className="break-all font-mono text-xs text-ink">{(view.dashboard_url || origin)}/api/pay/paymob/{tenant.id}</bdi></li>
        </ol>
      </Card>
    </div>
  );
}
