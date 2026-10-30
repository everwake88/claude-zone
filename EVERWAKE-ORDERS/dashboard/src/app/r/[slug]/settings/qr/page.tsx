'use client';
import { Copy, Download, ExternalLink, Flame, Monitor, Plus, Printer, QrCode, Trash2 } from 'lucide-react';
import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { useTenantRow } from '@/components/settings/useTenantRow';
import { Badge, Button, Card, Field, Input, Spinner, Switch, useAction, useToast } from '@/components/ui';
import { useTenant } from '@/components/tenant';
import { cairo } from '@/lib/fonts';
import { useT } from '@/lib/i18n';
import { loadImage } from '@/lib/menu-art';
import { drawCard, toPng } from '@/lib/qr-card';
import { sb } from '@/lib/supabase/client';
import type { Branch, QrCode as Code } from '@/lib/types';

// "1-12, VIP, 20" → 1 … 12, VIP, 20
function parseTables(text: string): string[] {
  const out: string[] = [];
  for (const part of text.split(/[,،\n]+/).map(s => s.trim()).filter(Boolean)) {
    const m = part.match(/^(\d+)\s*[-–]\s*(\d+)$/);
    if (m) for (let i = Number(m[1]); i <= Math.min(Number(m[2]), Number(m[1]) + 99); i++) out.push(String(i));
    else out.push(part.slice(0, 20));
  }
  return [...new Set(out)];
}
const save = (blob: Blob, name: string) => {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob); a.download = name; a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
};

// A QR code on the counter and on each table: the customer sees the branch's
// menu on their phone, orders, pays by card or at the counter, and watches
// their order until it is ready. The kitchen gets it on its screen.
export default function QrSettings() {
  const { tenant, brand, base, can } = useTenant();
  const { row, save: saveRow, busy: saving } = useTenantRow();
  const t = useT();
  const toast = useToast();
  const { busy, run } = useAction();
  const [branches, setBranches] = useState<Branch[] | null>(null);
  const [codes, setCodes] = useState<Code[]>([]);
  const [paymob, setPaymob] = useState(false);
  const [tables, setTables] = useState<Record<string, string>>({});
  const [origin, setOrigin] = useState('');
  useEffect(() => setOrigin(process.env.NEXT_PUBLIC_SITE_URL || window.location.origin), []);

  const load = useCallback(async () => {
    const [b, c] = await Promise.all([
      sb().from('branches').select('*').eq('tenant_id', tenant.id).eq('is_active', true).order('sort'),
      sb().from('qr_codes').select('*').eq('tenant_id', tenant.id).order('created_at')
    ]);
    setBranches((b.data || []) as Branch[]);
    setCodes((c.data || []) as Code[]);
  }, [tenant.id]);
  useEffect(() => {
    load();
    sb().rpc('payment_account_view', { p_tenant: tenant.id }).then(({ data }) => setPaymob(!!(data as { connected?: boolean } | null)?.connected));
  }, [load, tenant.id]);

  if (!row || !branches) return <Spinner />;
  const ro = !can.edit;
  const qs = row.settings.qr_ordering || {};
  const cash = qs.cash !== false, card = qs.card !== false;
  const setPay = (k: 'cash' | 'card', v: boolean) => saveRow({ settings: { ...row.settings, qr_ordering: { ...qs, [k]: v } } }, t('Saved'));
  const link = (c: Code) => `${origin}/q/${c.code}`;
  const byLabel = (a: Code, b: Code) => (a.table_label || '').localeCompare(b.table_label || '', undefined, { numeric: true });

  const addCounter = (b: Branch) => run(async () => {
    const { error } = await sb().from('qr_codes').insert({ tenant_id: tenant.id, branch_id: b.id, table_label: null });
    if (error) throw new Error(error.message);
    await load();
  }, t('Saved'));
  const addTables = (b: Branch) => run(async () => {
    const labels = parseTables(tables[b.id] || '');
    if (!labels.length) return;
    const { error } = await sb().from('qr_codes').upsert(labels.map(l => ({ tenant_id: tenant.id, branch_id: b.id, table_label: l })),
                                                         { onConflict: 'branch_id,table_label', ignoreDuplicates: true });
    if (error) throw new Error(error.message);
    setTables({ ...tables, [b.id]: '' });
    await load();
  }, t('Saved'));
  const setActive = (c: Code, v: boolean) => run(async () => {
    const { error } = await sb().from('qr_codes').update({ is_active: v }).eq('id', c.id);
    if (error) throw new Error(error.message);
    setCodes(codes.map(x => x.id === c.id ? { ...x, is_active: v } : x));
  });
  const remove = (c: Code) => {
    if (!confirm(t('Delete this QR code? Printed copies stop working.'))) return;
    run(async () => {
      const { error } = await sb().from('qr_codes').delete().eq('id', c.id);
      if (error) throw new Error(error.message);
      setCodes(codes.filter(x => x.id !== c.id));
    });
  };

  const cardFor = async (b: Branch, c: Code) => {
    await Promise.all(['600', '700', '800'].map(w => document.fonts.load(`${w} 40px ${cairo.style.fontFamily}`, 'امسح واطلب 0123').catch(() => null)));
    const logo = brand.logo_url ? await loadImage(brand.logo_url).catch(() => null) : null;
    return drawCard({
      link: link(c), title: tenant.name_ar || tenant.name_en, headline: 'امسح واطلب',
      offer: c.table_label ? 'اطلب وادفع من موبايلك — ويوصلك على الترابيزة' : 'المنيو والطلب والدفع من موبايلك — ونبهك أول ما يجهز',
      branch: b.name_ar, phone: '', place: c.table_label ? `ترابيزة ${c.table_label}` : null,
      logo, color: brand.color || '#0B222E', font: cairo.style.fontFamily
    });
  };
  const download = (b: Branch, c: Code) => run(async () =>
    save(await toPng(await cardFor(b, c)), `qr-${b.code}-${c.table_label ? 'table-' + c.table_label : 'counter'}.png`));
  // every card of the branch, one per A6 page, in a print window
  const printAll = (b: Branch, list: Code[]) => {
    const w = window.open('', '_blank');
    if (!w) { toast(t('Allow pop-ups for this site to print the cards.'), 'critical'); return; }
    w.document.write(`<title>${b.name_ar}</title><p style="font:16px sans-serif">…</p>`);
    run(async () => {
      const urls: string[] = [];
      for (const c of list) urls.push(URL.createObjectURL(await toPng(await cardFor(b, c))));
      w.document.open();
      w.document.write(`<!doctype html><title>${b.name_ar}</title><style>@page{size:A6;margin:0}body{margin:0}img{display:block;width:105mm;height:148mm;page-break-after:always}</style>`
        + urls.map(u => `<img src="${u}">`).join(''));
      w.document.close();
      w.onload = () => w.print();
      setTimeout(() => w.print(), 1200);
    });
  };
  const copy = (c: Code) => navigator.clipboard.writeText(link(c)).then(() => toast(t('Link copied')), () => toast(link(c), 'neutral'));

  return (
    <div className="space-y-4">
      <Card title={t('How QR customers pay')}>
        <div className="grid gap-3 sm:grid-cols-2">
          <label className="flex items-center justify-between gap-3 rounded-xl bg-paper p-3">
            <span>
              <span className="block text-sm font-medium">{t('Cash at the counter')}</span>
              <span className="block text-xs text-muted">{t('The order reaches the kitchen once the cashier taps “Paid” on the kitchen screen.')}</span>
            </span>
            <Switch checked={cash} disabled={ro || saving} onChange={v => setPay('cash', v)} />
          </label>
          <label className="flex items-center justify-between gap-3 rounded-xl bg-paper p-3">
            <span>
              <span className="block text-sm font-medium">{t('Card on the phone')}</span>
              <span className="block text-xs text-muted">
                {paymob ? t('Paid through your Paymob account; the order goes to the kitchen the moment Paymob confirms it.')
                        : <>{t('Connect Paymob first.')} <Link href={`${base}/settings/payments`} className="text-gold-ink underline">{t('Online payments')}</Link></>}
              </span>
            </span>
            <Switch checked={card && paymob} disabled={ro || saving || !paymob} onChange={v => setPay('card', v)} />
          </label>
        </div>
        {!cash && !(card && paymob) && <p className="mt-3 text-sm text-critical">{t('Turn on at least one way to pay, or customers can only look at the menu.')}</p>}
      </Card>

      {branches.map(b => {
        const mine = codes.filter(c => c.branch_id === b.id);
        const counter = mine.find(c => !c.table_label);
        const tableCodes = mine.filter(c => c.table_label).sort(byLabel);
        return (
          <Card key={b.id} title={<span className="flex items-center gap-2"><QrCode className="size-4 text-gold-ink" /> {b.name_ar}</span>}
            action={
              <div className="flex gap-1">
                <Link href={`${base}/kitchen?branch=${b.id}`} className="inline-flex items-center gap-1 rounded-lg px-2 py-1 text-xs text-muted hover:bg-paper hover:text-ink"><Flame className="size-3.5" /> {t('Kitchen screen')}</Link>
                <Link href={`${base}/kitchen/tv?branch=${b.id}`} target="_blank" className="inline-flex items-center gap-1 rounded-lg px-2 py-1 text-xs text-muted hover:bg-paper hover:text-ink"><Monitor className="size-3.5" /> {t('Ready screen')}</Link>
              </div>
            }>
            <div className="space-y-4">
              {!b.pickup_enabled && !b.dine_in && <p className="text-sm text-caution">{t('This branch has neither pickup nor dine-in turned on, so QR orders are taken as pickup at the counter.')}</p>}
              <div>
                <p className="mb-2 text-sm font-medium">{t('The counter')} <span className="text-xs font-normal text-muted">— {t('take away: the customer collects when their number is called')}</span></p>
                {counter ? <CodeRow c={counter} link={link(counter)} ro={ro} busy={busy} onCopy={() => copy(counter)} onDownload={() => download(b, counter)}
                                     onActive={v => setActive(counter, v)} onDelete={() => remove(counter)} t={t} />
                  : <Button variant="outline" disabled={ro || busy} onClick={() => addCounter(b)}><Plus className="size-4" /> {t('Make the counter QR code')}</Button>}
              </div>
              <div>
                <div className="mb-2 flex items-center justify-between gap-2">
                  <p className="text-sm font-medium">{t('Tables')} <span className="text-xs font-normal text-muted">— {t('dine-in: the order is brought to the table')}</span></p>
                  {tableCodes.length > 0 && <Button size="sm" variant="ghost" disabled={busy} onClick={() => printAll(b, [...(counter ? [counter] : []), ...tableCodes])}><Printer className="size-4" /> {t('Print all cards')}</Button>}
                </div>
                {tableCodes.length > 0 && (
                  <ul className="mb-3 divide-y divide-hairline rounded-xl border border-hairline">
                    {tableCodes.map(c => (
                      <li key={c.id} className="px-3 py-2">
                        <CodeRow c={c} link={link(c)} ro={ro} busy={busy} onCopy={() => copy(c)} onDownload={() => download(b, c)}
                                 onActive={v => setActive(c, v)} onDelete={() => remove(c)} t={t} />
                      </li>
                    ))}
                  </ul>
                )}
                {!ro && (
                  <div className="flex items-end gap-2">
                    <Field label={t('Add tables')} hint={t('Numbers or names, e.g. 1-12, VIP, Garden 1')} className="flex-1">
                      <Input value={tables[b.id] || ''} onChange={e => setTables({ ...tables, [b.id]: e.target.value })} placeholder="1-12" />
                    </Field>
                    <Button variant="outline" disabled={busy || !parseTables(tables[b.id] || '').length} onClick={() => addTables(b)} className="mb-5"><Plus className="size-4" /> {t('Add')}</Button>
                  </div>
                )}
              </div>
            </div>
          </Card>
        );
      })}

      <Card title={t('How it works in the branch')}>
        <ol className="list-decimal space-y-2 ps-5 text-sm text-muted">
          <li>{t('Print the counter card and one card per table, and put them where customers wait or sit.')}</li>
          <li>{t('The customer scans, picks from the branch’s menu (with its own prices and what is sold out) and pays by card, or chooses cash and pays at the counter.')}</li>
          <li>{t('Open the kitchen screen on a tablet in the kitchen: cash orders wait in “At the counter” until the cashier taps Paid; paid orders go straight to New.')}</li>
          <li>{t('When the kitchen marks an order Ready, the customer’s phone rings, and WhatsApp tells them too if they asked for it. Put the ready screen on a TV so everyone sees their number.')}</li>
        </ol>
      </Card>
    </div>
  );
}

function CodeRow({ c, link, ro, busy, onCopy, onDownload, onActive, onDelete, t }: {
  c: Code; link: string; ro: boolean; busy: boolean; onCopy: () => void; onDownload: () => void;
  onActive: (v: boolean) => void; onDelete: () => void; t: ReturnType<typeof useT>;
}) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      {c.table_label && <span className="min-w-20 font-medium">{t('Table {n}', { n: c.table_label })}</span>}
      <bdi dir="ltr" className="min-w-0 flex-1 truncate font-mono text-xs text-muted">{link}</bdi>
      <Badge tone="neutral">{t('{n} scans', { n: c.scans })}</Badge>
      {!c.is_active && <Badge tone="caution">{t('Off')}</Badge>}
      <div className="flex items-center gap-1">
        <button onClick={onCopy} className="rounded-lg p-1.5 text-muted hover:bg-paper hover:text-ink" aria-label={t('Copy link')} title={t('Copy link')}><Copy className="size-4" /></button>
        <a href={link} target="_blank" rel="noreferrer" className="rounded-lg p-1.5 text-muted hover:bg-paper hover:text-ink" aria-label={t('Open')} title={t('Open')}><ExternalLink className="size-4" /></a>
        <button onClick={onDownload} disabled={busy} className="rounded-lg p-1.5 text-muted hover:bg-paper hover:text-ink disabled:opacity-50" aria-label={t('Download the card')} title={t('Download the card')}><Download className="size-4" /></button>
        {!ro && <Switch checked={c.is_active} disabled={busy} onChange={onActive} label={t('On')} />}
        {!ro && <button onClick={onDelete} disabled={busy} className="rounded-lg p-1.5 text-muted hover:bg-paper hover:text-critical" aria-label={t('Delete')} title={t('Delete')}><Trash2 className="size-4" /></button>}
      </div>
    </div>
  );
}
