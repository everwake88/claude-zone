'use client';
import { Copy, Download, Plus, Printer, QrCode } from 'lucide-react';
import Link from 'next/link';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { SavingsHero } from '@/components/growth/SavingsHero';
import { Button, Card, Field, Input, PageHeader, Select, Spinner, useAction, useToast } from '@/components/ui';
import { PageGuide } from '@/components/guide';
import { useTenant } from '@/components/tenant';
import { cairo } from '@/lib/fonts';
import { money } from '@/lib/format';
import { useT } from '@/lib/i18n';
import { loadImage } from '@/lib/menu-art';
import { drawCard, qrCanvas, toPng } from '@/lib/qr-card';
import { sb } from '@/lib/supabase/client';
import type { Branch, Settings } from '@/lib/types';

// "Where did you find us": the link pre-fills "… عرفتكم من <source>", so the
// customer's first message says it, the agent reads it as a normal sentence,
// and the report below counts the chats and orders each source brought.
const SOURCES: [string, string][] = [
  ['الكارت اللي في الكيس', 'A card in the delivery-app bag'],
  ['المحل', 'In the shop'],
  ['انستجرام', 'Instagram'],
  ['فيسبوك', 'Facebook'],
  ['تيك توك', 'TikTok'],
  ['جوجل ماب', 'Google Maps'],
  ['فلاير', 'A flyer']
];
interface SourceRow { source: string; chats: number; customers: number; orders: number; revenue: number; commission_saved: number }
const local = (d: string) => (d.startsWith('20') && d.length === 12 ? '0' + d.slice(2) : '+' + d);
const save = (blob: Blob, name: string) => {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob); a.download = name; a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
};

export default function Growth() {
  const { tenant, brand, base, can } = useTenant();
  const t = useT();
  const toast = useToast();
  const { busy, run } = useAction();
  const [branches, setBranches] = useState<Branch[]>([]);
  const [number, setNumber] = useState<string | null | undefined>(undefined);
  const [settings, setSettings] = useState<Settings>({});
  const [branchId, setBranchId] = useState('');
  const [source, setSource] = useState(SOURCES[0][0]);
  const [custom, setCustom] = useState('');
  const [headline, setHeadline] = useState('اطلب على واتساب');
  const [offer, setOffer] = useState('امسح الكود واطلب في ثواني — من غير تطبيقات');
  const [qr, setQr] = useState<string | null>(null);
  const [rows, setRows] = useState<SourceRow[] | null>(null);

  useEffect(() => {
    sb().from('branches').select('*').eq('tenant_id', tenant.id).eq('is_active', true).order('sort').then(({ data }) => setBranches((data || []) as Branch[]));
    sb().from('whatsapp_channels').select('phone_number').eq('tenant_id', tenant.id).eq('is_active', true).order('created_at').limit(1)
      .then(({ data }) => setNumber((data?.[0]?.phone_number as string | null) || null));
    sb().from('tenants').select('settings').eq('id', tenant.id).single().then(({ data }) => setSettings((data?.settings || {}) as Settings));
  }, [tenant.id]);

  const sources = useMemo(() => [...SOURCES.map(s => s[0]), ...(settings.growth_sources || []).filter(x => !SOURCES.some(s => s[0] === x))], [settings]);
  const branch = branches.find(b => b.id === branchId) || null;
  const message = `أهلاً 👋 عايز أطلب${branch ? ' من فرع ' + branch.name_ar : ''} — عرفتكم من ${source}`;
  const link = number ? `https://wa.me/${number}?text=${encodeURIComponent(message)}` : '';

  useEffect(() => {
    if (!link) { setQr(null); return; }
    qrCanvas(link, 360).then(c => setQr(c.toDataURL('image/png')));
  }, [link]);

  const loadRows = useCallback(async () => {
    const { data } = await sb().rpc('growth_sources', { p_tenant: tenant.id, p_from: new Date(Date.now() - 30 * 864e5).toISOString(),
                                                        p_to: new Date(Date.now() + 60000).toISOString(), p_sources: sources });
    setRows((data || []) as SourceRow[]);
  }, [tenant.id, sources]);
  useEffect(() => { if (can.edit) loadRows(); }, [loadRows, can.edit]);

  const addSource = () => run(async () => {
    const name = custom.trim();
    if (!name) return;
    const next = { ...settings, growth_sources: [...(settings.growth_sources || []), name] };
    const { error } = await sb().from('tenants').update({ settings: next }).eq('id', tenant.id);
    if (error) throw new Error(error.message);
    setSettings(next); setSource(name); setCustom('');
  });

  const downloadQr = () => run(async () => save(await toPng(await qrCanvas(link, 1200)), `whatsapp-qr-${branch?.code || 'all'}.png`));
  const downloadCard = () => run(async () => {
    await Promise.all(['600', '700', '800'].map(w => document.fonts.load(`${w} 40px ${cairo.style.fontFamily}`, 'اطلب WhatsApp 0123').catch(() => null)));
    const logo = brand.logo_url ? await loadImage(brand.logo_url).catch(() => null) : null;
    const card = await drawCard({ link, title: tenant.name_ar || tenant.name_en, headline, offer, branch: branch?.name_ar || null,
                                  phone: number ? local(number) : '', logo, color: brand.color || '#0B222E', font: cairo.style.fontFamily });
    save(await toPng(card), `whatsapp-card-${branch?.code || 'all'}.png`);
  });

  if (number === undefined) return <Spinner />;
  const sym = tenant.currency_symbol;

  return (
    <div className={`space-y-5 ${cairo.className}`}>
      <PageHeader title={t('Get customers')} subtitle={t('Move your customers from the delivery apps to your own WhatsApp: a link and a QR code for each branch and each place you advertise, and what each one brought.')} />
      <PageGuide id="growth" steps={[
          t('Each link opens a WhatsApp chat with your number, and tells you where that customer came from.'),
          t('Print the QR code for the branch, the bags and the flyers; put the links in your ads, on Instagram and on Google Maps.'),
          t('“What each place brought” shows the chats and orders from each one, so you know what works.')
        ]} />
      <SavingsHero />

      {!number && (
        <Card><p className="text-sm">{t('Connect your WhatsApp number first — the links and QR codes point to it.')} <Link href={`${base}/settings/whatsapp`} className="text-gold-ink underline">{t('Settings → WhatsApp')}</Link></p></Card>
      )}

      {number && (
        <Card title={<span className="flex items-center gap-2"><QrCode className="size-4 text-gold-ink" /> {t('Your WhatsApp link and QR code')}</span>}>
          <div className="grid gap-6 lg:grid-cols-[1fr_auto]">
            <div className="space-y-4">
              <div className="grid gap-4 sm:grid-cols-2">
                {branches.length > 1 && (
                  <Field label={t('Branch')} hint={t('The message names the branch, so the agent starts there.')}>
                    <Select value={branchId} onChange={e => setBranchId(e.target.value)}>
                      <option value="">{t('Any branch')}</option>
                      {branches.map(b => <option key={b.id} value={b.id}>{b.name_ar}</option>)}
                    </Select>
                  </Field>
                )}
                <Field label={t('Where will customers see it?')} hint={t('Each place gets its own link, so you can see which one works.')}>
                  <Select value={source} onChange={e => setSource(e.target.value)}>
                    {sources.map(s => <option key={s} value={s}>{t(SOURCES.find(x => x[0] === s)?.[1] || s)}</option>)}
                  </Select>
                </Field>
              </div>
              {can.edit && (
                <div className="flex gap-2">
                  <Input dir="rtl" value={custom} onChange={e => setCustom(e.target.value)} placeholder={t('Another place, in Arabic (e.g. منيو الترابيزة)')} />
                  <Button variant="outline" disabled={busy || !custom.trim()} onClick={addSource}><Plus className="size-4" /> {t('Add')}</Button>
                </div>
              )}
              <Field label={t('The message it opens with')} hint={t('The customer just presses send. The agent reads it like any first message.')}>
                <p dir="rtl" className="rounded-xl bg-[#DCF8C6] px-3 py-2 text-sm text-ink">{message}</p>
              </Field>
              <div className="flex gap-2">
                <Input readOnly dir="ltr" value={link} className="text-xs" />
                <Button variant="outline" onClick={() => { navigator.clipboard.writeText(link); toast(t('Copied')); }}><Copy className="size-4" /></Button>
              </div>
              <div className="grid gap-4 sm:grid-cols-2">
                <Field label={t('Card headline')}><Input dir="rtl" value={headline} onChange={e => setHeadline(e.target.value)} /></Field>
                <Field label={t('Card line under it (your offer)')}><Input dir="rtl" value={offer} onChange={e => setOffer(e.target.value)} /></Field>
              </div>
              <div className="flex flex-wrap gap-2">
                <Button variant="gold" busy={busy} onClick={downloadCard}><Printer className="size-4" /> {t('Download the printable card')}</Button>
                <Button variant="outline" disabled={busy} onClick={downloadQr}><Download className="size-4" /> {t('Download the QR code only')}</Button>
              </div>
              <p className="text-xs text-muted">{t('Tip: put the card in every delivery-app bag with an offer for ordering on WhatsApp next time (create the offer under Offers), then watch the “card in the bag” row below.')}</p>
            </div>
            <div className="flex flex-col items-center gap-2">
              {qr ? <img src={qr} alt="" className="size-56 rounded-xl border border-hairline bg-white p-2" /> : <Spinner />}
              <p className="text-xs text-muted" dir="ltr">{local(number)}</p>
            </div>
          </div>
        </Card>
      )}

      {can.edit && (
        <Card title={t('What each place brought — last 30 days')}>
          {!rows ? <Spinner /> : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="text-xs text-muted">
                  <tr className="border-b border-hairline"><th className="p-2">{t('Place')}</th><th className="p-2">{t('Chats started')}</th><th className="p-2">{t('Ordered')}</th>
                    <th className="p-2">{t('Orders')}</th><th className="p-2">{t('Sales')}</th><th className="p-2">{t('Commission saved')}</th></tr>
                </thead>
                <tbody>
                  {rows.map(r => (
                    <tr key={r.source} className="border-b border-hairline last:border-0">
                      <td className="p-2 font-medium">{t(SOURCES.find(x => x[0] === r.source)?.[1] || r.source)}</td>
                      <td className="p-2">{r.chats}</td>
                      <td className="p-2">{r.chats ? `${r.customers} (${Math.round(100 * r.customers / r.chats)}%)` : '—'}</td>
                      <td className="p-2">{r.orders}</td>
                      <td className="p-2">{money(r.revenue, sym)}</td>
                      <td className="p-2 font-semibold text-positive">{money(r.commission_saved, sym)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <p className="mt-3 text-xs text-muted">{t('Counted from the first message of customers who came through a link. Someone who deletes the pre-filled text is not counted.')}</p>
        </Card>
      )}
    </div>
  );
}
